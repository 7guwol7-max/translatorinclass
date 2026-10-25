// Electron main: 창(컨트롤 패널·자막 오버레이), 키·설정, 파이프라인, 학생 링크, 단축키
import {
  BrowserWindow,
  Menu,
  app,
  globalShortcut,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs, readFileSync } from 'node:fs';
import type { Caption, Channel, DisplayInfo, KeyProvider, OverlayAnchor, OverlayPlacement, Settings, StatusMessage, StudentLinkStatus, TestResult } from '../shared/types';
import { pickRecommendedGeminiModel } from '../shared/prompts';
import { SettingsStore } from './settings';
import { KeyStore, looksLikeKey } from './keystore';
import { QuotaTracker, nextPacificMidnight, type QuotaState, type QuotaStore } from './quota';
import { Pipeline } from './pipeline';
import { ModelPool, type ModelStat, type PoolStore } from './model-pool';
import { rankGeminiCandidates } from '../shared/models';
import { GeminiClient } from './providers/gemini';
import { connectLive } from './providers/gemini-live';
import { LiveEngine } from './live';
import { liveTranslateModels, pickLiveModel } from '../shared/live';
import { ClaudeTranslator } from './providers/claude';
import { AihubClient } from './providers/aihub';
import { ProviderError } from './providers/errors';
import { StudentLinkServer } from './lan/server';
import { boundsFor } from './overlay-layout';

const DIST = __dirname;
const RENDERER_DIR = path.join(DIST, 'renderer');
const STUDENT_DIR = path.join(DIST, 'student');
const APP_ORIGIN = 'app://ui';
const MAX_SEGMENT_SAMPLES = 16000 * 60;
/** Live 모드로 한 번에 받는 소리 조각의 최대 길이 (보통 0.1초) */
const MAX_STREAM_SAMPLES = 16000 * 2;

const EXTERNAL_ALLOWLIST = [
  'https://aistudio.google.com/',
  'https://ai.google.dev/',
  'https://console.anthropic.com/',
  'https://platform.claude.com/',
  'https://aihub.or.kr/',
  'https://www.aihub.or.kr/',
];

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// 단축키(Ctrl+Alt+P)로 시작할 때도 오디오 처리가 막히지 않게
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let control: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let settings: SettingsStore;
let keys: KeyStore;
let quota: QuotaTracker;
let pool: ModelPool;
let pipeline: Pipeline;
let live: LiveEngine;
let studentLink: StudentLinkServer;
let listening = false;
let moveMode = false;
let linkError: string | null = null;
let gemini: { key: string; client: GeminiClient } | null = null;
let claude: { key: string; client: ClaudeTranslator } | null = null;

function geminiClient(key: string): GeminiClient {
  if (!gemini || gemini.key !== key) gemini = { key, client: new GeminiClient(key) };
  return gemini.client;
}

/** 교사 마이크가 쓰는 채널 (Live 모드는 수업 시작 때 이 채널의 세션을 미리 연다) */
function teacherChannel(): Channel {
  return settings.get().teacherMicMode === 'auto' ? 'auto' : 'teacher';
}

function publishLive(): void {
  control?.webContents.send('live', live.status());
}

function claudeClient(key: string): ClaudeTranslator {
  if (!claude || claude.key !== key) claude = { key, client: new ClaudeTranslator(key) };
  return claude.client;
}

function fileQuotaStore(dir: string): QuotaStore {
  const file = path.join(dir, 'quota.json');
  return {
    load: () => {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as QuotaState;
      } catch {
        return null;
      }
    },
    save: (state) => void fs.writeFile(file, JSON.stringify(state), 'utf8').catch(() => undefined),
  };
}

function filePoolStore(dir: string): PoolStore {
  const file = path.join(dir, 'model-speed.json');
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    load: () => {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as Record<string, ModelStat>;
      } catch {
        return null;
      }
    },
    // 요청마다 쓰지 않고 잠깐 모아서 저장한다
    save: (stats) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fs.writeFile(file, JSON.stringify(stats), 'utf8').catch(() => undefined), 2_000);
    },
  };
}

/** 설정에 맞춰 모델 묶음을 다시 정한다 (자동: 키로 쓸 수 있는 Flash 계열 여러 개 / 직접: 고른 모델 + 대체 모델) */
function refreshPool(): void {
  const s = settings.get();
  const models = s.geminiModelMode === 'manual'
    ? [s.geminiModel, s.geminiFallbackModel]
    : rankGeminiCandidates(s.geminiModels.length > 0 ? s.geminiModels : [s.geminiModel], s.modelPreference);
  pool.setCandidates(models.length > 0 ? models : [s.geminiModel], s.modelPreference);
}

// ── 창 ─────────────────────────────────────────────────────────

function webPreferences(): Electron.WebPreferences {
  return {
    preload: path.join(DIST, 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    // 창을 내려도 마이크 처리와 자막 표시가 멈추지 않게
    backgroundThrottling: false,
  };
}

function createControl(): void {
  control = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    title: '교실 통역',
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  });
  void control.loadURL(`${APP_ORIGIN}/control/index.html`);
  control.webContents.once('did-finish-load', () => {
    const reset = new Date(nextPacificMidnight(Date.now()));
    status('info', `Gemini 무료 일일 한도는 매일 ${reset.toLocaleTimeString('ko-KR', { hour: 'numeric' })}(이 PC 시간)에 초기화됩니다.`);
  });
  control.on('closed', () => {
    control = null;
    app.quit();
  });
}

/** 자막 창을 띄울 화면: 고른 화면 → 없으면 프로젝터(주 모니터가 아닌 화면) → 주 모니터 */
function displayFor(id: number | null): Electron.Display {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return all.find((d) => d.id === id) ?? all.find((d) => d.id !== primary.id) ?? primary;
}

function defaultOverlayBounds(): Electron.Rectangle {
  const s = settings.get();
  return boundsFor(displayFor(s.overlayDisplayId).workArea, s.overlayAnchor ?? 'bottom-center', s.overlayWidthPct, s.overlayHeight);
}

function visibleBounds(b: Settings['overlayBounds']): Electron.Rectangle | null {
  if (!b) return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
  return onScreen ? b : null;
}

/** 지금 자막 창 위치를 설정에 저장 (직접 옮긴 경우 위치 버튼 선택은 풀린다) */
async function saveOverlayBounds(anchor: OverlayAnchor | null): Promise<void> {
  if (!overlay) return;
  const bounds = overlay.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const next = await settings.update({
    overlayBounds: bounds,
    overlayAnchor: anchor,
    overlayDisplayId: display.id,
    overlayWidthPct: Math.round((bounds.width / display.workArea.width) * 100),
    overlayHeight: bounds.height,
  });
  sendAll('settings', next);
}

async function placeOverlay(placement: OverlayPlacement): Promise<void> {
  if (!overlay) return;
  const display = placement.displayId !== null ? displayFor(placement.displayId) : screen.getDisplayMatching(overlay.getBounds());
  const area = display.workArea;
  let bounds: Electron.Rectangle;
  if (placement.anchor) {
    bounds = boundsFor(area, placement.anchor, placement.widthPct, placement.height);
  } else {
    // 직접 옮겨 둔 상태에서 크기만 바꾸면: 가운데·아래쪽을 그대로 두고 키운다
    const cur = overlay.getBounds();
    const width = Math.round((area.width * Math.min(100, Math.max(30, placement.widthPct))) / 100);
    const height = Math.min(area.height, Math.max(100, placement.height));
    const x = Math.min(Math.max(area.x, Math.round(cur.x + cur.width / 2 - width / 2)), area.x + area.width - width);
    const y = Math.min(Math.max(area.y, cur.y + cur.height - height), area.y + area.height - height);
    bounds = { x, y, width, height };
  }
  overlay.setBounds(bounds);
  if (!overlay.isVisible()) setOverlayVisible(true);
  await saveOverlayBounds(placement.anchor);
}

// 자막 창 위 도구 막대로 끌어서 옮기기·크기 바꾸기 (마우스 위치를 따라간다)
let pointerTimer: NodeJS.Timeout | null = null;
let pointerStop: NodeJS.Timeout | null = null;

function startPointerTrack(kind: 'move' | 'resize'): void {
  if (!overlay) return;
  stopPointerTrack(false);
  const start = screen.getCursorScreenPoint();
  const from = overlay.getBounds();
  pointerTimer = setInterval(() => {
    if (!overlay) return;
    const p = screen.getCursorScreenPoint();
    const dx = p.x - start.x;
    const dy = p.y - start.y;
    if (kind === 'move') overlay.setBounds({ ...from, x: from.x + dx, y: from.y + dy });
    else overlay.setBounds({ ...from, width: Math.max(360, from.width + dx), height: Math.max(120, from.height + dy) });
  }, 16);
  pointerStop = setTimeout(() => stopPointerTrack(true), 60_000); // 혹시 놓친 경우 대비
}

function stopPointerTrack(save: boolean): void {
  if (pointerStop) clearTimeout(pointerStop);
  pointerStop = null;
  if (!pointerTimer) return;
  clearInterval(pointerTimer);
  pointerTimer = null;
  if (save) void saveOverlayBounds(null);
}

function setOverlayVisible(visible: boolean): void {
  if (!overlay) return;
  if (visible) overlay.showInactive();
  else overlay.hide();
  control?.webContents.send('overlay:visible', visible);
}

function displayList(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    primary: d.id === primary.id,
    label: `화면 ${i + 1}${d.id === primary.id ? ' (주 모니터)' : ''} · ${d.size.width}×${d.size.height}`,
  }));
}

function createOverlay(): void {
  const bounds = visibleBounds(settings.get().overlayBounds) ?? defaultOverlayBounds();
  overlay = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    title: '교실 통역 자막',
    webPreferences: webPreferences(),
  });
  // 전체화면 PPT·영상 위에도 보이도록 가장 높은 단계로
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true }); // 클릭은 아래 창으로 통과
  void overlay.loadURL(`${APP_ORIGIN}/overlay/index.html`);
  const reveal = () => {
    if (overlay && !overlay.isVisible()) overlay.showInactive();
  };
  overlay.once('ready-to-show', reveal);
  overlay.webContents.once('did-finish-load', reveal); // 투명 창에서 ready-to-show 가 늦거나 안 오는 경우 대비
  overlay.on('closed', () => {
    overlay = null;
  });
}

/** 일부 전체화면 프로그램이 위로 올라오는 경우를 대비해 주기적으로 다시 맨 위로 */
function keepOverlayOnTop(): void {
  setInterval(() => {
    if (overlay && overlay.isVisible() && !moveMode && !pointerTimer) {
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.moveTop();
    }
  }, 3000);
}

function setMoveMode(on: boolean): void {
  if (!overlay) return;
  if (on && !overlay.isVisible()) overlay.showInactive();
  moveMode = on;
  overlay.setIgnoreMouseEvents(!on, { forward: true });
  overlay.setFocusable(on);
  overlay.setResizable(on);
  if (on) overlay.focus();
  overlay.webContents.send('overlay:move-mode', on);
  control?.webContents.send('overlay:move-mode', on);
  if (!on) void saveOverlayBounds(null);
}

function toggleOverlay(): void {
  if (!overlay) return;
  setOverlayVisible(!overlay.isVisible());
}

// ── 이벤트 전달 ────────────────────────────────────────────────

function sendAll(channel: string, payload: unknown): void {
  for (const win of [control, overlay]) if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 듣기 상태를 바꾸고 컨트롤 패널·자막 창에 알린다 */
function setListening(on: boolean): void {
  listening = on;
  sendAll('session:listening', on);
}

function status(level: StatusMessage['level'], text: string): void {
  control?.webContents.send('status', { level, text, ts: Date.now() } satisfies StatusMessage);
}

function linkStatus(): StudentLinkStatus {
  return { enabled: settings.get().studentLinkEnabled, urls: studentLink.urls(), clients: studentLink.clientCount, error: linkError };
}

function publishLink(): void {
  control?.webContents.send('link', linkStatus());
}

async function applyStudentLink(): Promise<void> {
  const s = settings.get();
  linkError = null;
  try {
    if (s.studentLinkEnabled && !studentLink.running) await studentLink.start(s.studentLinkPort);
    if (!s.studentLinkEnabled && studentLink.running) await studentLink.stop();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    linkError = code === 'EADDRINUSE' ? `포트 ${s.studentLinkPort} 를 다른 프로그램이 쓰고 있습니다. 설정에서 포트를 바꿔 주세요.` : `학생 링크를 열지 못했습니다 (${String(error)})`;
  }
  publishLink();
}

// ── IPC ────────────────────────────────────────────────────────

function fromApp(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return Boolean(event.senderFrame?.url.startsWith(`${APP_ORIGIN}/`));
}

function handle<T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error('허용되지 않은 요청입니다');
    return fn(...(args as T));
  });
}

function isChannel(v: unknown): v is Channel {
  return v === 'teacher' || v === 'student' || v === 'auto';
}

function isUtterance(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function isProvider(v: unknown): v is KeyProvider {
  return v === 'gemini' || v === 'claude' || v === 'aihub';
}

async function testKey(provider: KeyProvider): Promise<TestResult> {
  const key = await keys.get(provider);
  if (!key) return { ok: false, message: '저장된 키가 없습니다.' };
  try {
    if (provider === 'gemini') {
      const { generate: models, live: liveModels } = await geminiClient(key).listModels();
      const recommended = pickRecommendedGeminiModel(models);
      sendAll('settings', await settings.update({ geminiModels: models, liveModels, liveModel: pickLiveModel(liveModels, settings.get().liveModel) }));
      refreshPool();
      publishLive();
      const liveNote = liveTranslateModels(liveModels).length > 0 ? ' Live 번역 모델도 쓸 수 있어요.' : '';
      if (settings.get().geminiModelMode === 'auto') {
        const pooled = pool.list();
        return {
          ok: true,
          models,
          liveModels,
          recommendedModel: recommended,
          message: pooled.length > 0
            ? `연결되었습니다. 모델 ${pooled.length}개를 묶어 가장 빠른 것을 자동으로 씁니다.${liveNote}`
            : `연결되었지만 이 키로 쓸 수 있는 Gemini Flash 모델이 없습니다.${liveNote}`,
        };
      }
      const current = settings.get().geminiModel;
      const hasCurrent = models.includes(current);
      return {
        ok: true,
        models,
        liveModels,
        recommendedModel: recommended,
        message: hasCurrent
          ? `연결되었습니다. 현재 모델(${current})을 쓸 수 있습니다.`
          : `연결되었습니다. 현재 모델(${current})은 이 키로 쓸 수 없어요${recommended ? ` — 추천: ${recommended}` : ''}.`,
      };
    }
    if (provider === 'aihub') {
      const count = await new AihubClient(key).count('번역');
      return { ok: true, message: `연결되었습니다. '번역' 관련 데이터셋이 ${count}개 있어요.` };
    }
    const model = settings.get().claudeModel;
    await claudeClient(key).check(model);
    return { ok: true, message: `연결되었습니다. ${model} 을(를) 쓸 수 있습니다.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Live 세션 하나를 열었다 닫아 본다 (소리는 보내지 않는다) */
async function testLive(): Promise<TestResult> {
  const key = await keys.get('gemini');
  if (!key) return { ok: false, message: '먼저 Gemini API 키를 저장해 주세요.' };
  const s = settings.get();
  const target = s.studentLanguages[0] ?? 'en';
  const startedAt = Date.now();
  try {
    const conn = await connectLive(key, { model: s.liveModel, target }, {
      onInput: () => undefined,
      onOutput: () => undefined,
      onTurnEnd: () => undefined,
      onUsage: () => undefined,
      onGoAway: () => undefined,
      onClose: () => undefined,
    });
    const ms = Date.now() - startedAt;
    conn.close();
    const sessions = s.studentLanguages.length + (s.teacherMicMode === 'auto' ? 1 : 0);
    return { ok: true, message: `Live 연결 성공 (${s.liveModel}, ${(ms / 1000).toFixed(1)}초). 수업 중에는 연결을 ${sessions}개 엽니다.` };
  } catch (error) {
    return { ok: false, message: `Live 연결 실패: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function registerIpc(): void {
  handle('settings:get', () => settings.get());
  handle('settings:update', async (patch: Partial<Settings>) => {
    const before = settings.get();
    const next = await settings.update(patch ?? {});
    sendAll('settings', next);
    refreshPool();
    if (before.studentLanguages.join() !== next.studentLanguages.join()) studentLink.refreshConfig();
    if (before.studentLinkEnabled !== next.studentLinkEnabled || (next.studentLinkEnabled && before.studentLinkPort !== next.studentLinkPort)) {
      if (studentLink.running && before.studentLinkPort !== next.studentLinkPort) await studentLink.stop();
      await applyStudentLink();
    }
    if (before.overlayBounds !== null && next.overlayBounds === null && overlay) overlay.setBounds(defaultOverlayBounds());
    if (listening && before.liveMode !== next.liveMode) {
      if (next.liveMode) live.start([teacherChannel()]);
      else live.stop();
    }
    control?.webContents.send('quota', pipeline.quotaStatus());
    publishLive();
    return next;
  });

  handle('keys:status', () => keys.status());
  handle('keys:save', async (provider: unknown, key: unknown) => {
    if (!isProvider(provider) || typeof key !== 'string') throw new Error('잘못된 요청입니다');
    const problem = looksLikeKey(provider, key);
    if (problem) throw new Error(problem);
    await keys.set(provider, key);
    return keys.status();
  });
  handle('keys:clear', async (provider: unknown) => {
    if (!isProvider(provider)) throw new Error('잘못된 요청입니다');
    await keys.clear(provider);
    return keys.status();
  });
  handle('keys:test', (provider: unknown) => {
    if (!isProvider(provider)) throw new Error('잘못된 요청입니다');
    return testKey(provider);
  });

  handle('session:start', async () => {
    const key = await keys.get('gemini');
    if (!key) return { ok: false, message: '먼저 설정에서 Gemini API 키를 저장해 주세요.' };
    const s = settings.get();
    if (s.translator === 'claude' && !(await keys.get('claude'))) {
      return { ok: false, message: '번역 엔진이 Claude 로 되어 있지만 Claude API 키가 없습니다.' };
    }
    setListening(true);
    pipeline.resetContext();
    // 모델 목록을 아직 안 받았으면 받아 둔다 (연결 테스트를 건너뛴 경우). 무료 요청 수에는 잡히지 않는다.
    if ((s.geminiModelMode === 'auto' && s.geminiModels.length === 0) || (s.liveMode && s.liveModels.length === 0)) {
      try {
        const lists = await geminiClient(key).listModels();
        sendAll('settings', await settings.update({ geminiModels: lists.generate, liveModels: lists.live, liveModel: pickLiveModel(lists.live, s.liveModel) }));
        refreshPool();
      } catch {
        // 목록을 못 받아도 기본 모델로 시작한다
      }
    }
    const first = pool.best();
    if (first) void geminiClient(key).warmUp(first);
    live.start([teacherChannel()]);
    control?.webContents.send('quota', pipeline.quotaStatus());
    return { ok: true, message: '듣는 중' };
  });
  handle('session:stop', () => {
    setListening(false);
    live.stop();
  });
  handle('session:state', () => listening);
  // 자막 창의 멈춤/다시 시작 버튼: 마이크는 컨트롤 패널이 열고 닫으므로 그쪽에 맡긴다 (Ctrl+Alt+P 와 같음)
  ipcMain.on('session:request-toggle', (event) => {
    if (!fromApp(event)) return;
    control?.webContents.send('session:toggle');
  });
  handle('quota:get', () => pipeline.quotaStatus());
  handle('live:status', () => live.status());
  handle('live:test', () => testLive());
  handle('link:get', () => linkStatus());
  handle('shell:open', async (url: unknown) => {
    if (typeof url === 'string' && EXTERNAL_ALLOWLIST.some((prefix) => url.startsWith(prefix))) await shell.openExternal(url);
  });

  handle('aihub:search', async (keyword: unknown) => {
    const key = await keys.get('aihub');
    if (!key) return { ok: false, message: 'API 키 화면에서 AI 허브 키를 먼저 저장해 주세요.', total: 0, items: [] };
    const q = typeof keyword === 'string' ? keyword.trim().slice(0, 60) : '';
    try {
      const { total, items } = await new AihubClient(key).search(q, 20);
      return { ok: true, message: `전체 ${total}개 중 ${items.length}개`, total, items };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), total: 0, items: [] };
    }
  });
  handle('aihub:detail', async (id: unknown) => {
    const key = await keys.get('aihub');
    if (!key) return { ok: false, message: 'AI 허브 키가 없습니다.' };
    try {
      return { ok: true, message: '', detail: await new AihubClient(key).detail(String(id)) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  handle('overlay:displays', () => displayList());
  handle('overlay:place', (placement: OverlayPlacement) => {
    if (!placement || typeof placement !== 'object') throw new Error('잘못된 요청입니다');
    const anchor = placement.anchor;
    return placeOverlay({
      displayId: typeof placement.displayId === 'number' ? placement.displayId : null,
      anchor: typeof anchor === 'string' && /^(top|middle|bottom)-(left|center|right)$/.test(anchor) ? anchor : null,
      widthPct: Number(placement.widthPct) || settings.get().overlayWidthPct,
      height: Number(placement.height) || settings.get().overlayHeight,
    });
  });
  handle('overlay:set-visible', (visible: unknown) => setOverlayVisible(Boolean(visible)));
  handle('overlay:toggle-move', () => setMoveMode(!moveMode));

  // 자막 창 안의 도구 막대
  ipcMain.on('overlay:interactive', (event, interactive: unknown) => {
    if (!fromApp(event) || !overlay || moveMode) return;
    overlay.setIgnoreMouseEvents(!interactive, { forward: true });
  });
  ipcMain.on('overlay:pointer', (event, kind: unknown, phase: unknown) => {
    if (!fromApp(event) || (kind !== 'move' && kind !== 'resize')) return;
    if (phase === 'start') startPointerTrack(kind);
    else stopPointerTrack(true);
  });
  ipcMain.on('overlay:font', async (event, delta: unknown) => {
    if (!fromApp(event) || typeof delta !== 'number') return;
    const next = await settings.update({ overlayFontSize: settings.get().overlayFontSize + Math.sign(delta) * 2 });
    sendAll('settings', next);
  });

  ipcMain.on('audio:segment', (event, channel: unknown, pcm: unknown, utterance: unknown) => {
    if (!fromApp(event) || !listening || !isChannel(channel)) return;
    if (!(pcm instanceof Float32Array) || pcm.length === 0 || pcm.length > MAX_SEGMENT_SAMPLES) return;
    // Live 모드: Live 가 그 말에 답하지 않을 때만 기존 방식으로 처리하도록 맡긴다
    if (settings.get().liveMode && isUtterance(utterance)) live.segment(channel, utterance, pcm);
    else pipeline.enqueue(channel, pcm);
  });
  ipcMain.on('audio:stream', (event, channel: unknown, utterance: unknown, pcm: unknown) => {
    if (!fromApp(event) || !listening || !isChannel(channel) || !isUtterance(utterance)) return;
    if (!(pcm instanceof Float32Array) || pcm.length === 0 || pcm.length > MAX_STREAM_SAMPLES) return;
    live.audio(channel, utterance, pcm);
  });
  ipcMain.on('audio:stream-end', (event, channel: unknown, utterance: unknown) => {
    if (!fromApp(event) || !isChannel(channel) || !isUtterance(utterance)) return;
    live.end(channel, utterance);
  });
}

// ── 파이프라인 ─────────────────────────────────────────────────

function createPipeline(): void {
  const userData = app.getPath('userData');
  quota = new QuotaTracker(fileQuotaStore(userData), () => {
    const s = settings.get();
    return { daily: s.dailyRequestLimit, perMinute: s.requestsPerMinute };
  });
  pool = new ModelPool(quota, filePoolStore(userData));
  refreshPool();
  pipeline = new Pipeline({
    getSettings: () => settings.get(),
    transcribe: async (model, wav, prompt, onPartial, signal) => {
      const key = await keys.get('gemini');
      if (!key) throw new ProviderError('auth', 'Gemini API 키가 없습니다');
      return geminiClient(key).transcribe(model, wav, prompt, onPartial, signal);
    },
    getTranslator: () => {
      const key = keys.peek('claude');
      if (!key) return null;
      const client = claudeClient(key);
      return (model, input) => client.translate(model, input);
    },
    quota,
    pool,
    onCaption: (caption: Caption) => {
      sendAll('caption', caption);
      studentLink.broadcast(caption);
    },
    onStatus: (message) => control?.webContents.send('status', message),
    onQuota: (q) => control?.webContents.send('quota', q),
    onFatal: (message) => {
      setListening(false);
      live.stop();
      status('error', message);
      control?.webContents.send('session:stopped', message);
    },
  });
  live = new LiveEngine({
    getSettings: () => settings.get(),
    connect: async (model, target, handlers) => {
      const key = await keys.get('gemini');
      if (!key) throw new ProviderError('auth', 'Gemini API 키가 없습니다');
      return connectLive(key, { model, target }, handlers);
    },
    onCaption: (caption: Caption) => {
      sendAll('caption', caption);
      studentLink.broadcast(caption);
    },
    onStatus: (message) => control?.webContents.send('status', message),
    onLiveStatus: (s) => control?.webContents.send('live', s),
    fallback: (channel, pcm, slot) => pipeline.enqueue(channel, pcm, slot),
    nextSeq: () => pipeline.nextSeq(),
    noteLatency: (ms) => {
      pipeline.noteLatency(ms);
      control?.webContents.send('quota', pipeline.quotaStatus());
    },
  });
}

// ── 시작 ───────────────────────────────────────────────────────

app.on('second-instance', () => {
  if (control) {
    if (control.isMinimized()) control.restore();
    control.focus();
  }
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');
  settings = new SettingsStore(userData);
  keys = new KeyStore(userData);
  await keys.status(); // 키를 미리 불러둔다

  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(RENDERER_DIR, rel));
    if (url.host !== 'ui' || !file.startsWith(RENDERER_DIR + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // 우리 화면에서만: 마이크(오디오만)와 링크 복사(클립보드 쓰기)
  const allowed = new Set(['media', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const audioOnly = 'mediaTypes' in details ? (details.mediaTypes ?? []).every((t) => t === 'audio') : true;
    callback(allowed.has(permission) && audioOnly && details.requestingUrl.startsWith(`${APP_ORIGIN}/`));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && origin.startsWith(APP_ORIGIN));

  studentLink = new StudentLinkServer(STUDENT_DIR, () => settings.get().studentLanguages, () => publishLink());
  createPipeline();
  registerIpc();
  createControl();
  createOverlay();
  keepOverlayOnTop();
  await applyStudentLink();

  const onDisplaysChanged = () => {
    control?.webContents.send('displays', displayList());
    if (overlay && !visibleBounds(overlay.getBounds())) overlay.setBounds(defaultOverlayBounds()); // 프로젝터를 뺀 경우
  };
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);

  globalShortcut.register('Control+Alt+H', toggleOverlay);
  globalShortcut.register('Control+Alt+M', () => setMoveMode(!moveMode));
  globalShortcut.register('Control+Alt+P', () => control?.webContents.send('session:toggle'));

});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  void studentLink?.stop();
});
