// 사용설명서 그림: 빌드한 실제 화면(apps/desktop/dist)을 Chromium 으로 띄워 찍는다.
// window.api 는 예시 데이터를 돌려주는 가짜로 바꿔 끼우고, 가짜 마이크로 소리 막대를 움직인다.
// 누를 곳에는 빨간 번호를 붙인다 (설명서 본문의 ①②③ 과 같은 번호).
//
// 사용: cd apps/desktop && npm run build && cd ../.. && node tools/manual/capture.mjs
// 필요: Playwright(Chromium), 한글 글꼴 Pretendard (Windows 의 맑은 고딕 대신)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RENDERER = path.join(ROOT, 'apps/desktop/dist/renderer');
const STAGE = path.join(ROOT, 'tools/manual/stage');
const OUT = path.join(ROOT, 'docs/manual/img');
const SCALE = 1.5;

// ── 예시 데이터 ──────────────────────────────────────────────────

const SETTINGS = {
  geminiModelMode: 'auto', modelPreference: 'fast', hedgeRequests: true,
  liveMode: false, liveModel: 'gemini-3.5-live-translate-preview',
  liveModels: ['gemini-3.1-flash-live-preview', 'gemini-3.5-live-translate-preview', 'gemini-3.5-transcribe-live', 'gemini-3.8-live'],
  onboarded: true, consentAcknowledged: true,
  geminiModel: 'gemini-3.1-flash-lite', geminiModels: [], geminiFallbackModel: '',
  translator: 'gemini', claudeModel: 'claude-opus-5-5',
  studentLanguages: ['vi', 'zh', 'ru'], overlayLanguages: ['vi', 'zh', 'ru'], showKoreanOnOverlay: true,
  teacherMicId: '', studentMicId: '', teacherMicMode: 'auto',
  dailyRequestLimit: 500, requestsPerMinute: 15,
  glossary: '광합성 = photosynthesis = quang hợp = 光合作用\n엽록체 = chloroplast = lục lạp = 叶绿体\n이산화 탄소 = carbon dioxide = khí cacbonic = 二氧化碳\n양분 = nutrients = chất dinh dưỡng = 养分',
  overlayFontSize: 30, overlayBounds: null, overlayAnchor: 'bottom-center', overlayDisplayId: null,
  overlayWidthPct: 90, overlayHeight: 280, latencyMode: 'fast',
  studentLinkEnabled: false, studentLinkPort: 8787, settingsVersion: 3,
};

const MODELS = [
  { id: 'gemini-3.1-flash-lite', state: 'ready', used: 46, dailyLimit: 1000, latencyMs: 1700 },
  { id: 'gemini-3.5-flash-lite', state: 'ready', used: 12, dailyLimit: 1000, latencyMs: 2300 },
  { id: 'gemini-3.1-flash', state: 'ready', used: 8, dailyLimit: 250, latencyMs: 2100 },
  { id: 'gemini-3.5-flash', state: 'limited', used: 21, dailyLimit: 250, latencyMs: 2600 },
];

function quota(extra = {}) {
  const resetAt = Date.parse('2026-10-26T07:00:00Z');
  return {
    used: 87, limit: 2500, remaining: 2413, minutesLeft: 201, day: '2026-10-25', resetAt, pressure: 'normal',
    waitUntil: null, queued: 0, model: 'gemini-3.1-flash-lite', models: MODELS, recentLatencyMs: null, ...extra,
  };
}

const BASE = {
  settings: SETTINGS,
  keys: { gemini: 'AIza…7Qx4', claude: null, aihub: null },
  quota: quota(),
  live: { state: 'off', model: SETTINGS.liveModel, ready: 0, wanted: 0, message: '' },
  link: { enabled: false, urls: [], clients: 0, error: null },
  listening: false,
  displays: [
    { id: 1, label: '화면 1 (주 모니터) · 1920×1080 · 150%', primary: true },
    { id: 2, label: '화면 2 · 1920×1080', primary: false },
  ],
  devices: [
    { deviceId: 'default', kind: 'audioinput', label: '기본값 - 마이크(Realtek(R) Audio)', groupId: 'a' },
    { deviceId: 'usb-1', kind: 'audioinput', label: '마이크(USB 무선 마이크)', groupId: 'b' },
  ],
  testKey: {
    ok: true,
    message: '연결되었습니다. 모델 4개를 묶어 가장 빠른 것을 자동으로 씁니다. Live 번역 모델도 쓸 수 있어요.',
    models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.1-flash', 'gemini-3.5-flash'],
  },
  testLive: { ok: true, message: 'Live 연결 성공 (gemini-3.5-live-translate-preview, 0.7초). 수업 중에는 연결을 4개 엽니다.' },
};

const CAPTIONS = [
  {
    id: 'c1', seq: 1, ts: Date.parse('2026-10-25T00:31:05Z'), speaker: 'teacher', lang: 'ko', final: true, latencyMs: 600,
    transcript: '자, 오늘은 식물이 햇빛으로 양분을 만드는 광합성에 대해 배워 볼 거예요.',
    translations: {
      vi: 'Nào các em, hôm nay chúng ta sẽ học về quang hợp, quá trình cây dùng ánh nắng để tạo ra chất dinh dưỡng.',
      zh: '同学们，今天我们来学习光合作用，也就是植物利用阳光制造养分的过程。',
      ru: 'Итак, сегодня мы изучим фотосинтез — как растения создают питательные вещества с помощью солнечного света.',
    },
  },
  {
    id: 'c2', seq: 2, ts: Date.parse('2026-10-25T00:31:12Z'), speaker: 'teacher', lang: 'ko', final: true, latencyMs: 400,
    transcript: '교과서 32쪽을 펴고, 그림을 같이 봅시다.',
    translations: {
      vi: 'Các em mở sách giáo khoa trang 32 và cùng xem hình nhé.',
      zh: '请大家翻到课本第32页，一起看图。',
      ru: 'Откройте учебник на странице 32, давайте вместе посмотрим на рисунок.',
    },
  },
  {
    id: 'c3', seq: 3, ts: Date.parse('2026-10-25T00:31:20Z'), speaker: 'student', lang: 'vi', final: true, latencyMs: 700,
    transcript: 'Thưa cô, em không hiểu từ quang hợp nghĩa là gì ạ.',
    translations: { ko: '선생님, 광합성이라는 말이 무슨 뜻인지 모르겠어요.' },
  },
  {
    id: 'c4', seq: 4, ts: Date.parse('2026-10-25T00:31:26Z'), speaker: 'teacher', lang: 'ko', final: false, latencyMs: 0,
    transcript: '좋은 질문이에요. 광합성은 잎이 빛을 받아서',
    translations: { vi: 'Câu hỏi hay lắm. Quang hợp là khi lá cây nhận ánh sáng', zh: '问得好。光合作用就是叶子吸收阳光', ru: 'Хороший вопрос. Фотосинтез — это когда листья получают свет' },
  },
];

// ── 페이지 안에 넣을 가짜 window.api ──────────────────────────────

function installApi(state) {
  const listeners = {};
  const on = (ch) => (cb) => {
    (listeners[ch] = listeners[ch] || []).push(cb);
    return () => undefined;
  };
  window.__emit = (ch, payload) => (listeners[ch] || []).forEach((cb) => cb(payload));
  const s = state.settings;
  window.api = {
    getSettings: async () => s,
    updateSettings: async (patch) => Object.assign(s, patch),
    getKeyStatus: async () => state.keys,
    saveKey: async () => state.keys,
    clearKey: async () => state.keys,
    testKey: async () => state.testKey,
    startSession: async () => ({ ok: true, message: '듣는 중' }),
    stopSession: async () => undefined,
    sendSegment: () => undefined,
    sendAudio: () => undefined,
    endAudio: () => undefined,
    testLive: async () => state.testLive,
    getLiveStatus: async () => state.live,
    onLiveStatus: on('live'),
    getQuota: async () => state.quota,
    getStudentLink: async () => state.link,
    openExternal: async () => undefined,
    onCaption: on('caption'),
    onQuota: on('quota'),
    onStatus: on('status'),
    onSettings: on('settings'),
    onStudentLink: on('link'),
    onToggleListening: on('toggle'),
    onSessionStopped: on('stopped'),
    getListening: async () => state.listening,
    onListening: on('listening'),
    requestToggleListening: () => undefined,
    onOverlayMoveMode: on('move'),
    aihubSearch: async () => ({ ok: true, message: '', total: 0, items: [] }),
    aihubDetail: async () => ({ ok: false, message: '' }),
    getVersion: async () => '0.6.2',
    getOverlayReport: async () => '',
    getDisplays: async () => state.displays,
    onDisplays: on('displays'),
    placeOverlay: async () => undefined,
    setOverlayVisible: async () => undefined,
    onOverlayVisible: on('overlay-visible'),
    toggleMoveMode: async () => undefined,
    setOverlayTools: () => undefined,
    onOverlayHover: on('overlay-hover'),
    overlayPointer: () => undefined,
    nudgeOverlayFont: () => undefined,
  };
  // 마이크 이름은 한국어 Windows 처럼 (소리는 Chromium 가짜 마이크)
  if (navigator.mediaDevices) navigator.mediaDevices.enumerateDevices = async () => state.devices;
  // Windows 의 맑은 고딕 대신 비슷한 Pretendard 로
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = ':root:root { --font: "Pretendard", sans-serif; } textarea, table.models td.name { font-family: "DejaVu Sans Mono", "Pretendard", monospace !important; }';
    document.head.append(style);
  });
}

/** 누를 곳에 빨간 테두리와 번호 */
function addMarks(items) {
  for (const it of items) {
    // 여러 곳을 한 번호로 묶을 수도 있다 (예: A− A+)
    const rects = [].concat(it.sel).map((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`표시할 곳이 없습니다: ${sel}`);
      return el.getBoundingClientRect();
    });
    const left = Math.min(...rects.map((x) => x.left));
    const top = Math.min(...rects.map((x) => x.top));
    const r = { left, top, right: Math.max(...rects.map((x) => x.right)), width: Math.max(...rects.map((x) => x.right)) - left, height: Math.max(...rects.map((x) => x.bottom)) - top };
    const pad = it.pad ?? 5;
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
      border: '3px solid #e5484d', borderRadius: '10px', zIndex: '99999', pointerEvents: 'none', boxShadow: '0 0 0 4px rgba(229,72,77,.15)',
    });
    const badge = document.createElement('div');
    badge.textContent = String(it.n);
    const bx = it.right ? r.right + pad - 14 : r.left - pad - 14;
    Object.assign(badge.style, {
      position: 'fixed', left: `${Math.max(2, bx)}px`, top: `${Math.max(2, r.top - pad - 14)}px`, width: '30px', height: '30px',
      borderRadius: '50%', background: '#e5484d', color: '#fff', font: '800 17px/30px Pretendard, sans-serif', textAlign: 'center',
      zIndex: '100000', boxShadow: '0 2px 6px rgba(0,0,0,.3)', pointerEvents: 'none',
    });
    document.body.append(box, badge);
  }
}

// ── 정적 서버 (dist/renderer + 슬라이드) ─────────────────────────

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = decodeURIComponent(url.pathname);
    const base = rel.startsWith('/stage/') ? STAGE : RENDERER;
    const file = path.normalize(path.join(base, rel.replace(/^\/stage\//, '/')));
    if (!file.startsWith(base)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ── 찍기 ─────────────────────────────────────────────────────────

const clone = (v) => JSON.parse(JSON.stringify(v));

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

  async function open(state, { width = 1180, height = 820, url = '/control/index.html' } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: SCALE, bypassCSP: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    await context.addInitScript(installApi, state);
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-10-25T00:31:30Z')); // 오전 9시 31분 수업 중
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(origin + url);
    await page.waitForTimeout(700);
    return { page, context, errors };
  }
  const shots = [];
  async function shot(page, name, { clip, marks = [], frame } = {}) {
    if (marks.length) await (frame ?? page).evaluate(addMarks, marks);
    await page.waitForTimeout(150);
    const opts = { path: path.join(OUT, `${name}.png`), animations: 'disabled', caret: 'hide' };
    if (clip) opts.clip = typeof clip === 'string' ? await clipOf(page, clip, clip.startsWith('.page[') ? 6 : 22) : clip;
    await page.screenshot(opts);
    shots.push(name);
  }
  async function clipOf(page, sel, margin = 22) {
    const box = await page.locator(sel).first().boundingBox();
    const vp = page.viewportSize();
    const x = Math.max(0, box.x - margin);
    const y = Math.max(0, box.y - margin);
    return { x, y, width: Math.min(vp.width - x, box.width + margin * 2), height: Math.min(vp.height - y, box.height + margin * 2) };
  }
  async function done({ page, context, errors }) {
    if (errors.length) throw new Error(`화면 오류: ${errors.join(' / ')}`);
    await page.close();
    await context.close();
  }

  // 1) 처음 설정
  {
    const state = clone(BASE);
    state.settings.onboarded = false;
    state.keys = { gemini: null, claude: null, aihub: null };
    const s = await open(state);
    const { page } = s;
    await shot(page, 'wizard-1-start', { clip: '.wiz-card', marks: [{ sel: '.consent', n: 1 }, { sel: '#wizNext', n: 2 }] });
    await page.reload();
    await page.waitForTimeout(600);
    await page.click('#wizNext');
    await page.fill('#wizKey', 'AIzaSyD-example-key-0000000000000000');
    await page.click('#wizKeySave');
    await page.waitForTimeout(300);
    await page.fill('#wizKey', 'AIzaSyD-example-key-0000000000000000');
    await shot(page, 'wizard-2-key', { clip: '.wiz-card', marks: [{ sel: '.wiz-step[data-step="1"] .howto .btn.link', n: 1, pad: 3 }, { sel: '#wizKey', n: 2 }, { sel: '#wizKeySave', n: 3 }] });
    await done(s);
  }
  {
    // 키를 저장한 뒤의 단계들
    const state = clone(BASE);
    state.settings.onboarded = false;
    const s = await open(state);
    const { page } = s;
    await page.click('#wizNext');
    await page.click('#wizNext');
    await page.waitForTimeout(200);
    await shot(page, 'wizard-3-langs', { clip: '.wiz-card', marks: [{ sel: '#wizLangs', n: 1, pad: 8 }] });
    await page.reload();
    await page.waitForTimeout(600);
    for (let i = 0; i < 3; i++) await page.click('#wizNext');
    await page.waitForTimeout(1800); // 가짜 마이크 소리로 막대가 움직이게
    await shot(page, 'wizard-4-mic', { clip: '.wiz-card', marks: [{ sel: '#wizMic', n: 1 }, { sel: '.wiz-step[data-step="3"] .seg', n: 2 }, { sel: '#wizLevel', n: 3 }] });
    await page.reload();
    await page.waitForTimeout(600);
    for (let i = 0; i < 4; i++) await page.click('#wizNext');
    await page.waitForTimeout(300);
    await shot(page, 'wizard-5-done', { clip: '.wiz-card', marks: [{ sel: '#wizNext', n: 1 }] });
    await done(s);
  }

  // 2) 수업 화면: 시작 전
  {
    const s = await open(clone(BASE));
    await shot(s.page, 'class-ready', { marks: [{ sel: '#bigStart', n: 1, pad: 8 }, { sel: '.hero-quick', n: 2 }, { sel: '.card.usage', n: 3 }, { sel: '.sidebar', n: 4, pad: -2, right: true }] });
    await done(s);
  }

  // 3) 수업 화면: 듣는 중 (Live 모드)
  {
    const state = clone(BASE);
    state.settings.liveMode = true;
    const s = await open(state);
    const { page } = s;
    await page.click('#bigStart');
    await page.waitForTimeout(1500);
    await page.evaluate((caps) => {
      for (const c of caps) window.__emit('caption', c);
      window.__emit('live', { state: 'on', model: 'gemini-3.5-live-translate-preview', ready: 4, wanted: 4, message: '' });
    }, CAPTIONS);
    await page.evaluate((q) => window.__emit('quota', q), quota({ recentLatencyMs: 600 }));
    await page.waitForTimeout(700);
    await shot(page, 'class-listening', { marks: [{ sel: '#bigStart', n: 1, pad: 8 }, { sel: '#topLatency', n: 2 }, { sel: '#log', n: 3, pad: -4 }] });
    await done(s);
  }

  // 4) 자막 창: 수업 슬라이드 위에 뜬 모습, 마우스를 올렸을 때 도구 막대
  {
    const state = clone(BASE);
    state.listening = true;
    const s = await open(state, { width: 1600, height: 900, url: '/stage/slide.html' });
    const { page } = s;
    const frame = page.frame({ url: /overlay\/index\.html/ });
    await frame.evaluate((caps) => {
      window.__emit('caption', caps[1]);
      window.__emit('caption', caps[2]);
    }, CAPTIONS);
    await page.waitForTimeout(500);
    await shot(page, 'overlay-on-slide');
    // 앱에서는 main 이 커서 자리를 보고 'overlay:hover' 를 보낸다
    await frame.evaluate(() => window.__emit('overlay-hover', true));
    await page.waitForTimeout(300);
    await shot(page, 'overlay-toolbar', {
      frame,
      clip: { x: 60, y: 470, width: 1480, height: 420 },
      marks: [{ sel: '#listenBtn', n: 1, pad: 3 }, { sel: '#dragHandle', n: 2, pad: 3 }, { sel: ['#fontDown', '#fontUp'], n: 3, pad: 3 }, { sel: '#hide', n: 4, pad: 3 }, { sel: '#resizeGrip', n: 5, pad: 2 }],
    });
    await done(s);
  }

  // 5) 설정 화면들
  const pageShot = async (pageName, name, state, { prepare, marks, clip } = {}) => {
    const s = await open(state);
    await s.page.click(`.nav[data-page="${pageName}"]`);
    await s.page.waitForTimeout(250);
    if (prepare) await prepare(s.page);
    await shot(s.page, name, { marks, clip: clip ?? `.page[data-page="${pageName}"]` });
    await done(s);
  };

  await pageShot('overlay', 'page-overlay', clone(BASE), {
    marks: [{ sel: '#displayList', n: 1 }, { sel: '#anchorGrid', n: 2, pad: 8 }, { sel: '#fontSize', n: 3 }, { sel: '#resetOverlay', n: 4 }, { sel: '#overlayReport', n: 5 }],
  });
  await pageShot('langs', 'page-langs', clone(BASE), {
    marks: [{ sel: '#studentLangs', n: 1, pad: 8 }, { sel: '#overlayLangs', n: 2, pad: 8 }],
  });
  await pageShot('mic', 'page-mic', clone(BASE), {
    prepare: async (page) => {
      await page.click('#micTest');
      await page.waitForTimeout(1500);
    },
    marks: [{ sel: '#teacherMic', n: 1 }, { sel: '.page[data-page="mic"] .seg', n: 2 }, { sel: '#micTest', n: 3 }, { sel: '#studentMic', n: 4 }],
  });
  await pageShot('glossary', 'page-glossary', clone(BASE), { marks: [{ sel: '#glossary', n: 1 }] });
  await pageShot('keys', 'page-keys', clone(BASE), {
    prepare: async (page) => {
      await page.click('#geminiTest');
      await page.waitForTimeout(300);
    },
    marks: [{ sel: '#geminiKey', n: 1 }, { sel: '#geminiSave', n: 2 }, { sel: '#geminiTest', n: 3 }, { sel: '#keyResult', n: 4 }],
  });
  {
    const state = clone(BASE);
    state.settings.liveMode = true;
    state.live = { state: 'idle', model: state.settings.liveModel, ready: 0, wanted: 0, message: '' };
    await pageShot('speed', 'page-speed-live', state, {
      prepare: async (page) => {
        await page.click('#liveTest');
        await page.waitForTimeout(300);
      },
      clip: '.page[data-page="speed"] .card:nth-of-type(1)',
      marks: [{ sel: '#liveMode', n: 1, pad: 6 }, { sel: '#liveModel', n: 2 }, { sel: '#liveTest', n: 3 }, { sel: '#liveBadge', n: 4, right: true }],
    });
  }
  await pageShot('speed', 'page-speed', clone(BASE), {
    prepare: async (page) => page.evaluate(() => document.querySelector('.page[data-page="speed"] .card:nth-of-type(2)').scrollIntoView()),
    marks: [{ sel: 'input[name="latency"][value="fast"]', n: 1, pad: 2 }],
    clip: '.content',
  });
  {
    const state = clone(BASE);
    state.settings.studentLinkEnabled = true;
    state.link = { enabled: true, urls: ['http://192.168.0.23:8787/s/k3f9q2/'], clients: 3, error: null };
    await pageShot('link', 'page-link', state, { marks: [{ sel: '#linkEnabled', n: 1, pad: 6 }, { sel: '#linkBox .url', n: 2 }] });
  }

  await browser.close();
  server.close();
  console.log(`${shots.length}장: ${shots.join(', ')}`);
}

await main();
