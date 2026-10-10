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
import type { Caption, Channel, KeyProvider, Settings, StatusMessage, StudentLinkStatus, TestResult } from '../shared/types';
import { pickRecommendedGeminiModel } from '../shared/prompts';
import { SettingsStore } from './settings';
import { KeyStore, looksLikeKey } from './keystore';
import { QuotaTracker, nextPacificMidnight, type QuotaState, type QuotaStore } from './quota';
import { Pipeline } from './pipeline';
import { GeminiClient } from './providers/gemini';
import { ClaudeTranslator } from './providers/claude';
import { ProviderError } from './providers/errors';
import { StudentLinkServer } from './lan/server';

const DIST = __dirname;
const RENDERER_DIR = path.join(DIST, 'renderer');
const STUDENT_DIR = path.join(DIST, 'student');
const APP_ORIGIN = 'app://ui';
const MAX_SEGMENT_SAMPLES = 16000 * 60;

const EXTERNAL_ALLOWLIST = ['https://aistudio.google.com/', 'https://ai.google.dev/', 'https://console.anthropic.com/', 'https://platform.claude.com/'];

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
let pipeline: Pipeline;
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

function defaultOverlayBounds(): Electron.Rectangle {
  const primary = screen.getPrimaryDisplay();
  // 프로젝터·TV 가 확장 모니터로 연결돼 있으면 그쪽에 띄운다
  const target = screen.getAllDisplays().find((d) => d.id !== primary.id) ?? primary;
  const area = target.workArea;
  const width = Math.round(area.width * 0.9);
  const height = 280;
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + area.height - height - 24, width, height };
}

function visibleBounds(b: Settings['overlayBounds']): Electron.Rectangle | null {
  if (!b) return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
  return onScreen ? b : null;
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
    if (overlay && overlay.isVisible() && !moveMode) {
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
  if (!on) void settings.update({ overlayBounds: overlay.getBounds() });
}

function toggleOverlay(): void {
  if (!overlay) return;
  if (overlay.isVisible()) overlay.hide();
  else overlay.showInactive();
}

// ── 이벤트 전달 ────────────────────────────────────────────────

function sendAll(channel: string, payload: unknown): void {
  for (const win of [control, overlay]) if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
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

function isProvider(v: unknown): v is KeyProvider {
  return v === 'gemini' || v === 'claude';
}

async function testKey(provider: KeyProvider): Promise<TestResult> {
  const key = await keys.get(provider);
  if (!key) return { ok: false, message: '저장된 키가 없습니다.' };
  try {
    if (provider === 'gemini') {
      const models = await geminiClient(key).listModels();
      const recommended = pickRecommendedGeminiModel(models);
      const current = settings.get().geminiModel;
      const hasCurrent = models.includes(current);
      return {
        ok: true,
        models,
        recommendedModel: recommended,
        message: hasCurrent
          ? `연결되었습니다. 현재 모델(${current})을 쓸 수 있습니다.`
          : `연결되었습니다. 현재 모델(${current})은 이 키로 쓸 수 없어요${recommended ? ` — 추천: ${recommended}` : ''}.`,
      };
    }
    const model = settings.get().claudeModel;
    await claudeClient(key).check(model);
    return { ok: true, message: `연결되었습니다. ${model} 을(를) 쓸 수 있습니다.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function registerIpc(): void {
  handle('settings:get', () => settings.get());
  handle('settings:update', async (patch: Partial<Settings>) => {
    const before = settings.get();
    const next = await settings.update(patch ?? {});
    sendAll('settings', next);
    if (before.studentLanguages.join() !== next.studentLanguages.join()) studentLink.refreshConfig();
    if (before.studentLinkEnabled !== next.studentLinkEnabled || (next.studentLinkEnabled && before.studentLinkPort !== next.studentLinkPort)) {
      if (studentLink.running && before.studentLinkPort !== next.studentLinkPort) await studentLink.stop();
      await applyStudentLink();
    }
    if (before.overlayBounds !== null && next.overlayBounds === null && overlay) overlay.setBounds(defaultOverlayBounds());
    control?.webContents.send('quota', pipeline.quotaStatus());
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
    if (!(await keys.get('gemini'))) return { ok: false, message: '먼저 설정에서 Gemini API 키를 저장해 주세요.' };
    const s = settings.get();
    if (s.translator === 'claude' && !(await keys.get('claude'))) {
      return { ok: false, message: '번역 엔진이 Claude 로 되어 있지만 Claude API 키가 없습니다.' };
    }
    listening = true;
    pipeline.resetContext();
    return { ok: true, message: '듣는 중' };
  });
  handle('session:stop', () => {
    listening = false;
  });
  handle('quota:get', () => pipeline.quotaStatus());
  handle('link:get', () => linkStatus());
  handle('shell:open', async (url: unknown) => {
    if (typeof url === 'string' && EXTERNAL_ALLOWLIST.some((prefix) => url.startsWith(prefix))) await shell.openExternal(url);
  });

  ipcMain.on('audio:segment', (event, channel: unknown, pcm: unknown) => {
    if (!fromApp(event) || !listening) return;
    if (channel !== 'teacher' && channel !== 'student' && channel !== 'auto') return;
    if (!(pcm instanceof Float32Array) || pcm.length === 0 || pcm.length > MAX_SEGMENT_SAMPLES) return;
    pipeline.enqueue(channel as Channel, pcm);
  });
}

// ── 파이프라인 ─────────────────────────────────────────────────

function createPipeline(): void {
  quota = new QuotaTracker(fileQuotaStore(app.getPath('userData')), () => {
    const s = settings.get();
    return { daily: s.dailyRequestLimit, perMinute: s.requestsPerMinute };
  });
  pipeline = new Pipeline({
    getSettings: () => settings.get(),
    transcribe: async (model, wav, prompt) => {
      const key = await keys.get('gemini');
      if (!key) throw new ProviderError('auth', 'Gemini API 키가 없습니다');
      return geminiClient(key).transcribe(model, wav, prompt);
    },
    getTranslator: () => {
      const key = keys.peek('claude');
      if (!key) return null;
      const client = claudeClient(key);
      return (model, input) => client.translate(model, input);
    },
    quota,
    onCaption: (caption: Caption) => {
      sendAll('caption', caption);
      studentLink.broadcast(caption);
    },
    onStatus: (message) => control?.webContents.send('status', message),
    onQuota: (q) => control?.webContents.send('quota', q),
    onFatal: (message) => {
      listening = false;
      status('error', message);
      control?.webContents.send('session:stopped', message);
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

  globalShortcut.register('Control+Alt+H', toggleOverlay);
  globalShortcut.register('Control+Alt+M', () => setMoveMode(!moveMode));
  globalShortcut.register('Control+Alt+P', () => control?.webContents.send('session:toggle'));

});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  void studentLink?.stop();
});
