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
import os from 'node:os';
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
import { boundsFor, placeWindow, pointerZone, sameBounds, type DpiConversion } from './overlay-layout';

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
  // 사용설명서·새 버전 받기
  'https://github.com/7guwol7-max/translatorinclass/',
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

// ── 자막 창 기록 (문제 보고용) ─────────────────────────────────
// 자막 창을 옮길 때 무엇을 했고 실제로 어디로 갔는지 최근 300줄을 남긴다. 화면에서 '문제 보고용 정보 복사'로 보낸다.

const overlayLog: string[] = [];

function olog(message: string): void {
  overlayLog.push(`${new Date().toTimeString().slice(0, 8)} ${message}`);
  if (overlayLog.length > 300) overlayLog.shift();
}

const rect = (b: Electron.Rectangle | null | undefined) => (b ? `${b.x},${b.y} ${b.width}×${b.height}` : '-');

function displaysText(): string[] {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) =>
    `화면 ${i + 1} id=${d.id}${d.id === primary.id ? ' 주' : ''} 영역 ${rect(d.bounds)} 작업 ${rect(d.workArea)} 배율 ${Math.round(d.scaleFactor * 100)}% 회전 ${d.rotation}${d.internal ? ' 내장' : ''}`);
}

function overlayReport(): string {
  const s = settings.get();
  const lines = [
    `교실 통역 ${app.getVersion()} · ${process.platform === 'win32' ? 'Windows' : process.platform} ${os.release()} · Electron ${process.versions.electron}`,
    ...displaysText(),
    overlay
      ? `자막 창 ${rect(overlay.getBounds())} 보임=${overlay.isVisible()} 화면=${screen.getDisplayMatching(overlay.getBounds()).id} 크기조절=${overlay.isResizable()} 이동=${overlay.isMovable()} 옮기기모드=${moveMode} 끄는중=${Boolean(pointerTimer)}`
      : '자막 창 없음',
    `설정 화면=${s.overlayDisplayId ?? '자동'} 자리=${s.overlayAnchor ?? '직접'} 너비=${s.overlayWidthPct}% 높이=${s.overlayHeight} 저장=${rect(s.overlayBounds)}`,
    '--- 최근 기록 ---',
    ...overlayLog.slice(-120),
  ];
  return lines.join('\n');
}

/** 점검: 자막 창을 화면마다 가운데로 잠깐 옮겨 실제로 어디로 가는지 기록하고 원래 자리로 돌린다 */
async function overlaySelfTest(): Promise<void> {
  if (!overlay || moveMode || pointerTimer) return;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const original = overlay.getBounds();
  olog(`점검 시작 (지금 ${rect(original)})`);
  for (const [i, d] of screen.getAllDisplays().entries()) {
    setOverlayBounds(boundsFor(d.workArea, 'middle-center', 50, 200), `점검 화면 ${i + 1}`);
    await wait(700);
    olog(`점검 화면 ${i + 1}: 0.7초 뒤 ${rect(overlay?.getBounds())}`);
  }
  setOverlayBounds(original, '점검 끝(원래 자리)');
  await wait(500);
}

/** 시작할 때 자리: 위치 버튼으로 둔 창은 그 화면·자리를 다시 계산하고, 직접 옮긴 창은 저장한 자리 (화면 밖이면 기본 자리) */
function initialOverlayBounds(): Electron.Rectangle {
  const s = settings.get();
  return s.overlayAnchor ? defaultOverlayBounds() : visibleBounds(s.overlayBounds) ?? defaultOverlayBounds();
}

/** Windows: 화면마다 다른 배율(DPI)을 맞춰 옮기는 데 쓴다 */
const dpi: DpiConversion | null = process.platform === 'win32'
  ? {
      toPhysical: (b) => screen.dipToScreenRect(null, b),
      toWindowDip: (b) => (overlay ? screen.screenToDipRect(overlay, b) : b),
    }
  : null;
let placedTarget: Electron.Rectangle | null = null;
let verifyTimer: NodeJS.Timeout | null = null;
let watchTimer: NodeJS.Timeout | null = null;

/** setBounds 로 안 맞으면: 크기 조절을 잠깐 허용하고 위치·크기를 따로 맞춘다 (크기를 못 바꾸게 막힌 창 대비) */
function forceBounds(win: BrowserWindow, target: Electron.Rectangle): void {
  const resizable = win.isResizable();
  if (!resizable) win.setResizable(true);
  win.setPosition(target.x, target.y);
  win.setSize(target.width, target.height);
  if (!resizable) win.setResizable(false);
}

/**
 * 자막 창을 옮긴다. 배율이 다른 화면(예: 노트북 150% → 프로젝터 100%)으로도 정확히 가도록 placeWindow 로 맞추고,
 * 그래도 안 맞으면 위치·크기를 따로 맞춘다. Windows 가 배율 변경을 늦게 처리하는 경우가 있어 잠시 뒤 다시 확인하고,
 * 2초 뒤에도 그 자리에 있는지 기록한다 (무언가 되돌리는지 알 수 있게).
 */
function setOverlayBounds(target: Electron.Rectangle, why: string): void {
  if (!overlay) return;
  const win = overlay;
  const before = win.getBounds();
  let ok = false;
  try {
    ok = placeWindow(win, target, dpi);
    if (!ok) {
      olog(`${why}: 맞지 않음 ${rect(win.getBounds())} → 위치·크기 따로`);
      forceBounds(win, target);
      ok = sameBounds(win.getBounds(), target);
    }
  } catch (error) {
    olog(`${why}: 오류 ${String(error)}`);
  }
  olog(`${why}: ${rect(before)} → 목표 ${rect(target)} → ${rect(win.getBounds())}${ok ? '' : ' (어긋남)'}`);
  placedTarget = target;
  if (verifyTimer) clearTimeout(verifyTimer);
  verifyTimer = setTimeout(() => {
    verifyTimer = null;
    if (overlay !== win || win.isDestroyed() || placedTarget !== target || pointerTimer || moveMode) return;
    if (!sameBounds(win.getBounds(), target)) {
      olog(`${why}: 0.4초 뒤 ${rect(win.getBounds())} — 다시 맞춤`);
      if (!placeWindow(win, target, dpi)) forceBounds(win, target);
    }
  }, 400);
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    watchTimer = null;
    if (overlay === win && !win.isDestroyed() && placedTarget === target && !sameBounds(win.getBounds(), target)) {
      olog(`${why}: 2초 뒤 자리가 바뀜 ${rect(win.getBounds())}`);
    }
  }, 2000);
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
  if (!overlay.isVisible()) setOverlayVisible(true);
  setOverlayBounds(bounds, `버튼(화면 ${placement.displayId ?? '지금'}, ${placement.anchor ?? '크기'})`);
  await saveOverlayBounds(placement.anchor);
}

// 자막 창 위 도구 막대로 끌어서 옮기기·크기 바꾸기 (마우스 위치를 따라간다)
let pointerTimer: NodeJS.Timeout | null = null;
let pointerStop: NodeJS.Timeout | null = null;

let dragTarget: Electron.Rectangle | null = null;
let dragKind: 'move' | 'resize' = 'move';
/** 끄는 동안 본 횟수·옮긴 횟수·마지막 커서 (문제 보고용) */
let dragStats = { ticks: 0, moves: 0, cursor: { x: 0, y: 0 } };
let dragRestoreResizable = false;

function startPointerTrack(kind: 'move' | 'resize'): void {
  if (!overlay) return;
  stopPointerTrack(false);
  const start = screen.getCursorScreenPoint();
  const from = overlay.getBounds();
  dragKind = kind;
  olog(`끌기 시작(${kind === 'move' ? '이동' : '크기'}) 창 ${rect(from)} 커서 ${start.x},${start.y}`);
  // 크기를 못 바꾸게 막힌 창이면 끄는 동안만 허용한다
  dragRestoreResizable = kind === 'resize' && !overlay.isResizable();
  if (dragRestoreResizable) overlay.setResizable(true);
  // 잡은 곳(창 안의 점)을 기억해 커서 자리에서 바로 계산한다. 시작점과의 차이를 쌓지 않으므로
  // 배율이 다른 화면으로 넘어가도 창이 커서에서 멀어지지 않고, 크기는 처음 크기(DIP)로 계속 맞춘다.
  const grab = { x: start.x - from.x, y: start.y - from.y };
  dragTarget = from;
  dragStats = { ticks: 0, moves: 0, cursor: start };
  pointerTimer = setInterval(() => {
    if (!overlay) return;
    const p = screen.getCursorScreenPoint();
    dragStats.ticks++;
    dragStats.cursor = p;
    const next = kind === 'move'
      ? { x: p.x - grab.x, y: p.y - grab.y, width: from.width, height: from.height }
      : { ...from, width: Math.max(360, from.width + p.x - start.x), height: Math.max(120, from.height + p.y - start.y) };
    if (dragTarget && sameBounds(next, dragTarget, 0)) return; // 커서가 멈춰 있으면 그대로
    dragTarget = next;
    dragStats.moves++;
    overlay.setBounds(next);
  }, 16);
  pointerStop = setTimeout(() => stopPointerTrack(true), 60_000); // 혹시 놓친 경우 대비
}

function stopPointerTrack(save: boolean): void {
  if (pointerStop) clearTimeout(pointerStop);
  pointerStop = null;
  if (!pointerTimer) return;
  clearInterval(pointerTimer);
  pointerTimer = null;
  const target = dragTarget;
  dragTarget = null;
  if (dragRestoreResizable && overlay) overlay.setResizable(false);
  dragRestoreResizable = false;
  olog(`끌기 끝 → ${rect(target)} 실제 ${rect(overlay?.getBounds())} (커서 ${dragStats.cursor.x},${dragStats.cursor.y}, 확인 ${dragStats.ticks}번, 옮김 ${dragStats.moves}번)`);
  if (!save) return;
  if (target) setOverlayBounds(target, dragKind === 'move' ? '끌어서 이동' : '끌어서 크기'); // 다른 배율의 화면에 놓았으면 마저 맞춘다
  void saveOverlayBounds(null);
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
    // 실제 해상도와 Windows 배율 (예: 1920×1080 · 150%) — 배율이 다른 화면이 섞여 있는지 알 수 있게
    label: `화면 ${i + 1}${d.id === primary.id ? ' (주 모니터)' : ''} · ${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}${d.scaleFactor !== 1 ? ` · ${Math.round(d.scaleFactor * 100)}%` : ''}`,
  }));
}

function createOverlay(): void {
  const bounds = initialOverlayBounds();
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
  overlay.setIgnoreMouseEvents(true); // 클릭은 아래 창으로 통과 (도구 막대 위에서만 받음: watchOverlayPointer)
  overlayInteractive = false;
  void overlay.loadURL(`${APP_ORIGIN}/overlay/index.html`);
  // 창을 만들 때의 자리는 주 모니터 배율로 계산돼, 배율이 다른 두 번째 화면이면 어긋난다. 보이기 전후로 다시 맞춘다.
  olog(`시작: ${displaysText().join(' / ')}`);
  setOverlayBounds(bounds, '시작(만들 때)');
  const reveal = () => {
    if (!overlay || overlay.isVisible()) return;
    overlay.showInactive();
    setOverlayBounds(bounds, '시작(보인 뒤)');
  };
  overlay.once('ready-to-show', reveal);
  overlay.webContents.once('did-finish-load', reveal); // 투명 창에서 ready-to-show 가 늦거나 안 오는 경우 대비
  overlay.on('closed', () => {
    overlay = null;
  });
}

/** 일부 전체화면 프로그램이 위로 올라오는 경우를 대비해 주기적으로 다시 맨 위로 */
function keepOverlayOnTop(): void {
  // moveTop() 은 쓰지 않는다: Windows 에서 창 자리를 DIP 그대로 실제 픽셀로 다시 놓아,
  // 배율이 100% 가 아닌 화면에서는 자막 창을 3초마다 엉뚱한 곳으로 옮긴다.
  setInterval(() => {
    if (overlay && overlay.isVisible() && !moveMode && !pointerTimer) overlay.setAlwaysOnTop(true, 'screen-saver');
  }, 3000);
}

// ── 도구 막대 위에서만 클릭 받기 ───────────────────────────────
// 커서가 도구 막대·모서리 위에 있는지 30ms 마다 커서 자리로 판단해 클릭 통과를 켜고 끈다.
// (화면 안의 마우스 이벤트로 판단하면 클릭 통과를 바꿀 때마다 '나감' 이벤트가 와서 상태가 계속 뒤집힌다)

let toolRects: Electron.Rectangle[] = [];
let overlayHover = false;
let overlayInteractive = false;

function setOverlayInteractive(on: boolean, why: string): void {
  if (!overlay || on === overlayInteractive) return;
  overlayInteractive = on;
  overlay.setIgnoreMouseEvents(!on);
  olog(`도구 막대 ${on ? '누를 수 있음' : '클릭 통과'} (${why})`);
}

function watchOverlayPointer(): void {
  setInterval(() => {
    if (!overlay || overlay.isDestroyed() || moveMode) return;
    const visible = overlay.isVisible();
    const zone = visible ? pointerZone(screen.getCursorScreenPoint(), overlay.getBounds(), toolRects) : { inside: false, overTool: false };
    if (zone.inside !== overlayHover) {
      overlayHover = zone.inside;
      overlay.webContents.send('overlay:hover', zone.inside);
    }
    // 끄는 중에는 손을 뗄 때까지 클릭을 받는다
    if (pointerTimer) setOverlayInteractive(true, '끄는 중');
    else setOverlayInteractive(zone.overTool, zone.overTool ? '커서가 도구 위' : '커서가 벗어남');
  }, 30);
}

function setMoveMode(on: boolean): void {
  if (!overlay) return;
  if (on && !overlay.isVisible()) overlay.showInactive();
  moveMode = on;
  overlay.setIgnoreMouseEvents(!on);
  overlayInteractive = on;
  overlay.setFocusable(on);
  overlay.setResizable(on);
  if (on) overlay.focus();
  overlay.webContents.send('overlay:move-mode', on);
  control?.webContents.send('overlay:move-mode', on);
  olog(`옮기기 모드 ${on ? '켬' : '끔'} 창 ${rect(overlay.getBounds())}`);
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
  handle('overlay:report', async () => {
    await overlaySelfTest();
    return overlayReport();
  });
  handle('app:version', () => app.getVersion());
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
  ipcMain.on('overlay:tools', (event, rects: unknown) => {
    if (!fromApp(event) || !Array.isArray(rects)) return;
    const ok = (r: unknown): r is Electron.Rectangle =>
      !!r && typeof r === 'object' && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((r as Record<string, number>)[k]));
    toolRects = rects.filter(ok).slice(0, 10).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
  });
  ipcMain.on('overlay:pointer', (event, kind: unknown, phase: unknown) => {
    if (!fromApp(event) || (kind !== 'move' && kind !== 'resize')) return;
    olog(`도구 막대 ${kind === 'move' ? '이동' : '모서리'} ${phase === 'start' ? '누름' : '뗌'}`);
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
  watchOverlayPointer();
  await applyStudentLink();

  // 화면을 꽂거나 빼면: 화면을 따로 고르지 않고 위치 버튼으로 둔 자막 창은 새 화면 배치의 그 자리로(프로젝터가 있으면 프로젝터),
  // 그 밖에는 화면 밖으로 나갔을 때만 기본 자리로. 해상도·배율이 바뀐 것만으로는 옮기지 않는다
  // (어떤 PC 는 이 알림이 자주 와서, 선생님이 옮긴 창을 되돌려 버리기 때문).
  let relayoutTimer: NodeJS.Timeout | null = null;
  let relayoutAdded = false; // 0.5초 안에 화면을 꽂거나 뺀 알림이 하나라도 있었는지
  let layoutKey = displaysText().join('|');
  const relayoutOverlay = (added: boolean) => {
    if (!overlay || moveMode || pointerTimer) return;
    const s = settings.get();
    if (added && s.overlayAnchor && s.overlayDisplayId === null) setOverlayBounds(defaultOverlayBounds(), '화면 바뀜(자동 자리)');
    else if (!visibleBounds(overlay.getBounds())) setOverlayBounds(defaultOverlayBounds(), '화면 밖으로 나감');
  };
  const onDisplaysChanged = (kind: string) => () => {
    const key = displaysText().join('|');
    if (key === layoutKey) return;
    layoutKey = key;
    olog(`화면 ${kind}: ${displaysText().join(' / ')}`);
    control?.webContents.send('displays', displayList());
    relayoutAdded ||= kind !== '바뀜';
    if (relayoutTimer) clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      relayoutTimer = null;
      const added = relayoutAdded;
      relayoutAdded = false;
      relayoutOverlay(added);
    }, 500); // 화면을 꽂으면 이벤트가 몇 번 이어서 온다
  };
  screen.on('display-added', onDisplaysChanged('추가'));
  screen.on('display-removed', onDisplaysChanged('빠짐'));
  screen.on('display-metrics-changed', onDisplaysChanged('바뀜'));

  globalShortcut.register('Control+Alt+H', toggleOverlay);
  globalShortcut.register('Control+Alt+M', () => setMoveMode(!moveMode));
  globalShortcut.register('Control+Alt+P', () => control?.webContents.send('session:toggle'));

});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  void studentLink?.stop();
});
