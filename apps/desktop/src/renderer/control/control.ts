// 교사용 컨트롤 패널: 처음 설정 마법사, 수업 화면(큰 시작 버튼·실시간 자막·남은 무료 사용량), 설정 화면들
import type {
  AihubDataset,
  AihubDetail,
  Caption,
  ModelInfo,
  Channel,
  DisplayInfo,
  KeyProvider,
  LatencyMode,
  OverlayAnchor,
  QuotaPressure,
  QuotaStatus,
  Settings,
  StatusMessage,
  StudentLinkStatus,
} from '../../shared/types';
import { STUDENT_LANGUAGES, languageInfo } from '../../shared/languages';
import { MicCapture, listMicrophones } from '../audio/capture';
import { CLAUDE_MODELS } from '../../shared/claude-models';
import '../global';

const api = window.api;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let listening = false;
let captures: MicCapture[] = [];
let pressure: QuotaPressure = 'normal';
let overlayVisible = true;
let displays: DisplayInfo[] = [];
const levels = { teacher: -90, student: -90 };

const ANCHOR_LABEL: Record<OverlayAnchor, string> = {
  'top-left': '위 왼쪽', 'top-center': '위 가운데', 'top-right': '위 오른쪽',
  'middle-left': '가운데 왼쪽', 'middle-center': '한가운데', 'middle-right': '가운데 오른쪽',
  'bottom-left': '아래 왼쪽', 'bottom-center': '아래 가운데', 'bottom-right': '아래 오른쪽',
};

// ── 공통 ───────────────────────────────────────────────────────

async function save(patch: Partial<Settings>): Promise<void> {
  const micChanged = 'teacherMicId' in patch || 'studentMicId' in patch || 'teacherMicMode' in patch;
  settings = await api.updateSettings(patch);
  render();
  if ('latencyMode' in patch) applyTuning();
  if (micChanged && listening) await restartCaptures();
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function showPage(name: string): void {
  document.querySelectorAll<HTMLElement>('.nav').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  document.querySelectorAll<HTMLElement>('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === name));
}

// ── 화면 그리기 ────────────────────────────────────────────────

function chip(label: string, sub: string, checked: boolean, onChange: (on: boolean) => void, disabled = false): HTMLLabelElement {
  const wrap = el('label', 'chip');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));
  const span = el('span', '', label);
  if (sub) span.append(el('small', '', sub));
  wrap.append(input, span);
  return wrap;
}

function renderLanguages(): void {
  $('studentLangs').replaceChildren(
    ...STUDENT_LANGUAGES.map((l) =>
      chip(l.ko, l.native, settings.studentLanguages.includes(l.code), (on) => {
        const next = on ? [...settings.studentLanguages, l.code] : settings.studentLanguages.filter((c) => c !== l.code);
        if (next.length === 0) return render(); // 최소 하나는 남긴다
        const overlay = on && settings.overlayLanguages.length < 3 ? [...settings.overlayLanguages, l.code] : settings.overlayLanguages;
        void save({ studentLanguages: next, overlayLanguages: overlay });
      }),
    ),
  );
  $('overlayLangs').replaceChildren(
    ...settings.studentLanguages.map((code) => {
      const on = settings.overlayLanguages.includes(code);
      const info = languageInfo(code);
      return chip(info?.ko ?? code, info?.native ?? '', on, (checked) => {
        const next = checked ? [...settings.overlayLanguages, code] : settings.overlayLanguages.filter((c) => c !== code);
        void save({ overlayLanguages: next });
      }, !on && settings.overlayLanguages.length >= 3);
    }),
  );
}

function setRadio(name: string, value: string): void {
  document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((r) => (r.checked = r.value === value));
}

function setValue(id: string, value: string | number): void {
  const input = $<HTMLInputElement>(id);
  if (document.activeElement !== input) input.value = String(value);
}

function renderOverlaySettings(): void {
  setValue('widthPct', settings.overlayWidthPct);
  setValue('heightPx', settings.overlayHeight);
  setValue('fontSize', settings.overlayFontSize);
  $('widthValue').textContent = `${settings.overlayWidthPct}%`;
  $('heightValue').textContent = `${settings.overlayHeight}px`;
  $('fontSizeValue').textContent = `${settings.overlayFontSize}px`;
  $('fontNow').textContent = String(settings.overlayFontSize);
  $<HTMLInputElement>('showKorean').checked = settings.showKoreanOnOverlay;
  document.querySelectorAll<HTMLButtonElement>('#anchorGrid button').forEach((b) => b.classList.toggle('active', b.dataset.anchor === settings.overlayAnchor));
  $('anchorNote').textContent = settings.overlayAnchor ? `${ANCHOR_LABEL[settings.overlayAnchor]}에 붙어 있어요` : '직접 옮긴 위치에 있어요';
  renderDisplays();
}

function renderDisplays(): void {
  const box = $('displayList');
  if (displays.length <= 1) {
    box.replaceChildren(el('span', 'hint', displays[0] ? `${displays[0].label} (화면이 하나예요)` : '화면 정보를 불러오는 중'));
    return;
  }
  const current = settings.overlayDisplayId;
  box.replaceChildren(
    ...displays.map((d) => {
      const b = el('button', '', d.label);
      b.type = 'button';
      b.classList.toggle('active', d.id === current || (current === null && !d.primary));
      b.addEventListener('click', () => void place({ displayId: d.id, anchor: settings.overlayAnchor ?? 'bottom-center' }));
      return b;
    }),
  );
}

function render(): void {
  renderLanguages();
  renderOverlaySettings();
  setRadio('micMode', settings.teacherMicMode);
  setRadio('translator', settings.translator);
  setRadio('latency', settings.latencyMode);
  setRadio('modelPref', settings.modelPreference);
  $<HTMLInputElement>('hedge').checked = settings.hedgeRequests;
  const manual = settings.geminiModelMode === 'manual';
  $<HTMLInputElement>('manualModel').checked = manual;
  $<HTMLInputElement>('geminiModel').disabled = !manual;
  $<HTMLInputElement>('geminiFallback').disabled = !manual;
  $<HTMLSelectElement>('claudeModel').value = settings.claudeModel;
  $<HTMLSelectElement>('claudeModel').disabled = settings.translator !== 'claude';
  setValue('geminiModel', settings.geminiModel);
  setValue('geminiFallback', settings.geminiFallbackModel);
  setValue('dailyLimit', settings.dailyRequestLimit);
  setValue('rpm', settings.requestsPerMinute);
  setValue('glossary', settings.glossary);
  $<HTMLInputElement>('linkEnabled').checked = settings.studentLinkEnabled;
  setValue('linkPort', settings.studentLinkPort);
  $<HTMLSelectElement>('teacherMic').value = settings.teacherMicId;
  $<HTMLSelectElement>('studentMic').value = settings.studentMicId;
  $('meterStudentWrap').classList.toggle('hidden', !settings.studentMicId);
  renderQuick();
  renderReady();
}

/** 수업 화면 위쪽 빠른 설정 칸 */
function renderQuick(): void {
  const langs = settings.studentLanguages.map((c) => languageInfo(c)?.ko ?? c);
  $('quickLangs').textContent = langs.length > 3 ? `${langs.slice(0, 3).join(' · ')} 외 ${langs.length - 3}` : langs.join(' · ');
  const mic = $<HTMLSelectElement>('teacherMic');
  const micName = mic.selectedOptions[0]?.textContent || '기본 마이크';
  $('quickMic').textContent = `${micName}${settings.teacherMicMode === 'auto' ? ' · 교사+학생' : ' · 교사 전용'}`;
  const where = settings.overlayAnchor ? ANCHOR_LABEL[settings.overlayAnchor] : '직접 옮긴 곳';
  $('quickOverlay').textContent = `${where}${overlayVisible ? '' : ' · 숨김'}`;
}

async function renderMics(): Promise<void> {
  const mics = await listMicrophones();
  const option = (value: string, label: string) => Object.assign(el('option'), { value, textContent: label });
  const named = mics.map((m, i) => option(m.deviceId === 'default' ? '' : m.deviceId, m.label || `마이크 ${i + 1}`));
  const teacher = $<HTMLSelectElement>('teacherMic');
  teacher.replaceChildren(...(mics.some((m) => m.deviceId === 'default') ? [] : [option('', '시스템 기본 마이크')]), ...named);
  const student = $<HTMLSelectElement>('studentMic');
  student.replaceChildren(option('', '사용 안 함'), ...named.map((o) => o.cloneNode(true) as HTMLOptionElement).filter((o) => o.value !== ''));
  teacher.value = settings.teacherMicId;
  student.value = settings.studentMicId;
}

let lastQuota: QuotaStatus | null = null;

/** 152 → "2시간 32분", 40 → "40분" */
function formatMinutes(m: number): string {
  if (m <= 0) return '거의 없음';
  if (m < 60) return `약 ${m}분`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest >= 5 ? `약 ${h}시간 ${rest}분` : `약 ${h}시간`;
}

const MODEL_STATE: Record<ModelInfo['state'], string> = {
  ready: '사용 가능',
  limited: '잠시 대기 (분당 한도)',
  cooldown: '잠시 쉼 (오류)',
  exhausted: '오늘 다 씀',
  gone: '이 키로 못 씀',
};

function renderQuota(q: QuotaStatus): void {
  lastQuota = q;
  pressure = q.pressure;
  const leftPct = q.limit > 0 ? Math.max(0, Math.min(100, (q.remaining / q.limit) * 100)) : 0;
  const reset = new Date(q.resetAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  const minutes = q.pressure === 'exhausted' ? '오늘 다 씀' : formatMinutes(q.minutesLeft);

  $('quotaBar').style.width = `${leftPct}%`;
  $('quotaText').textContent = minutes;
  const box = $('quota');
  box.classList.toggle('saving', q.pressure === 'saving');
  box.classList.toggle('exhausted', q.pressure === 'exhausted');
  box.title = `오늘 ${q.used.toLocaleString()} / ${q.limit.toLocaleString()}회 사용 · ${reset}에 다시 채워짐`;

  const ring = $('usageRing');
  ring.style.setProperty('--p', String(Math.round(leftPct)));
  ring.classList.toggle('saving', q.pressure === 'saving');
  ring.classList.toggle('exhausted', q.pressure === 'exhausted');
  $('usagePct').textContent = `${Math.round(leftPct)}%`;
  $('usageMinutes').textContent = minutes === '오늘 다 씀' ? minutes : `${minutes} 수업`;
  $('usageDetail').textContent = `${q.used.toLocaleString()} / ${q.limit.toLocaleString()}회 사용 · ${reset} 초기화`;

  $('usageReset').textContent = `오늘 ${reset}에 다시 채워짐`;
  const ready = q.models.filter((m) => m.state !== 'gone' && m.state !== 'exhausted').length;
  $('usageSummary').textContent = q.pressure === 'exhausted'
    ? `오늘 무료 사용량을 모두 썼어요. ${reset}에 다시 채워집니다.`
    : `지금 속도로 ${formatMinutes(q.minutesLeft)} 더 수업할 수 있어요 · 모델 ${ready}개 사용 중`;
  $('modelRows').replaceChildren(
    ...q.models.map((m) => {
      const tr = el('tr', `st-${m.state}${m.id === q.model ? ' current' : ''}`);
      const name = el('td', 'name', m.id);
      if (m.id === q.model) name.append(el('em', 'tag free', '지금'));
      tr.append(
        name,
        el('td', 'state', MODEL_STATE[m.state]),
        el('td', 'num', `${m.used.toLocaleString()} / ${m.dailyLimit.toLocaleString()}`),
        el('td', 'num', m.latencyMs === null ? '—' : `${(m.latencyMs / 1000).toFixed(1)}초`),
      );
      return tr;
    }),
  );

  renderLatency(q.recentLatencyMs);
  applyTuning();
}

function renderLatency(ms: number | null): void {
  const text = listening && ms !== null ? `자막이 말 끝나고 약 ${(ms / 1000).toFixed(1)}초 뒤 나와요` : '';
  $('topLatency').textContent = text;
  if (listening) $('heroSub').textContent = text || '말하면 몇 초 안에 자막이 떠요. 자막 창 위에 마우스를 올리면 멈출 수 있어요.';
}

function renderLink(link: StudentLinkStatus): void {
  const box = $('linkBox');
  box.replaceChildren();
  if (link.error) {
    box.append(el('p', 'notice warn', link.error));
    return;
  }
  if (!link.enabled) return;
  if (link.urls.length === 0) {
    box.append(el('p', 'notice warn', '네트워크 주소를 찾지 못했습니다. 교사 PC 가 학교 네트워크에 연결돼 있는지 확인하세요.'));
  }
  for (const url of link.urls) {
    const row = el('div', 'url');
    const code = el('code', '', url);
    const copy = el('button', 'btn primary', '복사');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(url).then(() => {
        copy.textContent = '복사됨 ✓';
        setTimeout(() => (copy.textContent = '복사'), 1500);
      });
    });
    row.append(code, copy);
    box.append(row);
  }
  box.append(el('span', 'count', `지금 접속한 학생 PC ${link.clients}대`));
}

// ── 실시간 자막 기록 ───────────────────────────────────────────

const MAX_LOG = 200;
const shown = new Map<string, HTMLElement>();

function captionCard(c: Caption): HTMLElement {
  const box = el('article', `cap ${c.speaker}${c.final ? '' : ' partial'}`);
  box.dataset.seq = String(c.seq);
  const meta = el('div', 'meta');
  meta.append(
    el('span', 'who', c.speaker === 'teacher' ? '교사' : `학생 · ${languageInfo(c.lang)?.ko ?? c.lang}`),
    el('span', '', new Date(c.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
  );
  if (c.final) meta.append(el('span', '', `${(c.latencyMs / 1000).toFixed(1)}초`));
  box.append(meta, el('div', 'text', c.transcript));
  for (const [code, value] of Object.entries(c.translations)) {
    const tr = el('div', 'tr');
    tr.append(el('b', '', languageInfo(code)?.ko ?? code), el('span', '', value));
    if (languageInfo(code)?.rtl) tr.dir = 'rtl';
    box.append(tr);
  }
  return box;
}

function addCaption(c: Caption): void {
  const log = $('log');
  log.querySelector('.empty-state')?.remove();
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 60;
  const card = captionCard(c);
  const existing = shown.get(c.id);
  if (existing) {
    existing.replaceWith(card);
  } else {
    // 동시에 보낸 요청은 끝나는 순서가 바뀔 수 있으므로 말한 순서(seq)대로 끼워 넣는다
    const after = [...log.children].find((n) => Number((n as HTMLElement).dataset.seq) > c.seq);
    if (after) log.insertBefore(card, after);
    else log.append(card);
  }
  shown.set(c.id, card);
  while (log.children.length > MAX_LOG) {
    const first = log.firstElementChild as HTMLElement;
    for (const [id, node] of shown) if (node === first) shown.delete(id);
    first.remove();
  }
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function showEmptyLog(): void {
  shown.clear();
  const empty = el('div', 'empty-state');
  empty.innerHTML = '<svg viewBox="0 0 24 24"><rect width="18" height="14" x="3" y="5" rx="3"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>';
  empty.append(el('p', '', "'수업 시작'을 누르고 말하면 여기에 자막이 나와요."));
  $('log').replaceChildren(empty);
}

function addMessage(m: StatusMessage): void {
  const box = $('messages');
  const div = el('div', `msg ${m.level}`);
  div.append(el('time', '', new Date(m.ts).toLocaleTimeString('ko-KR')), document.createTextNode(m.text));
  box.prepend(div); // 최신이 위로
  while (box.children.length > 60) box.lastElementChild?.remove();
  if (m.level !== 'info') toast(m.level, m.text);
}

/** 어느 화면에 있든 보이도록 오른쪽 아래에 잠깐 띄운다 (같은 문구는 겹쳐 띄우지 않음) */
function toast(level: 'warn' | 'error' | 'ok', text: string): void {
  const box = $('toasts');
  if ([...box.children].some((n) => n.textContent === text)) return;
  const t = el('div', `toast ${level}`, text);
  box.append(t);
  while (box.children.length > 3) box.firstElementChild?.remove();
  setTimeout(() => t.classList.add('out'), level === 'error' ? 9000 : 6000);
  setTimeout(() => t.remove(), level === 'error' ? 9400 : 6400);
}

function note(level: StatusMessage['level'], text: string): void {
  addMessage({ level, text, ts: Date.now() });
}

// ── 듣기 시작/정지 ─────────────────────────────────────────────

function renderListening(): void {
  $('startStop').classList.toggle('stop', listening);
  $('startStopLabel').textContent = listening ? '수업 끝내기' : '수업 시작';
  $('state').className = `status-pill ${listening ? 'on' : 'off'}`;
  $('stateText').textContent = listening ? '듣는 중' : '대기 중';
  const big = $('bigStart');
  big.classList.toggle('stop', listening);
  big.setAttribute('aria-label', listening ? '수업 끝내기' : '수업 시작');
  document.querySelector('.hero')?.classList.toggle('on', listening);
  $('heroTitle').textContent = listening ? '듣고 있어요' : hasGeminiKey ? '수업을 시작할 준비가 됐어요' : '먼저 Gemini 키가 필요해요';
  $('heroSub').textContent = listening
    ? '말하면 몇 초 안에 자막이 떠요. 자막 창 위에 마우스를 올리면 멈출 수 있어요.'
    : hasGeminiKey ? '가운데 버튼을 누르면 선생님 말이 학생 언어 자막으로 떠요.' : '처음 설정에서 무료 키를 넣으면 바로 쓸 수 있어요 (약 3분).';
  renderLatency(lastQuota?.recentLatencyMs ?? null);
}

/** 수업을 시작하기 전에 할 일 */
function renderReady(): void {
  const items: { text: string; action: string; go: () => void }[] = [];
  if (!hasGeminiKey) items.push({ text: 'Gemini 무료 키를 넣어 주세요', action: '처음 설정 열기', go: () => openWizard(1) });
  $('readyList').classList.toggle('hidden', items.length === 0);
  $('readyItems').replaceChildren(
    ...items.map((i) => {
      const row = el('div', 'ready-item');
      const b = el('button', 'btn primary sm', i.action);
      b.type = 'button';
      b.addEventListener('click', i.go);
      row.append(el('span', '', i.text), b);
      return row;
    }),
  );
}

// ── 소리 크기 막대 ─────────────────────────────────────────────

const BAR_COUNT = 24;

function makeBars(id: string): HTMLElement[] {
  const box = $(id);
  const bars = Array.from({ length: BAR_COUNT }, () => el('i'));
  box.replaceChildren(...bars);
  return bars;
}

/** dB 를 막대 높이로. 오래된 값이 왼쪽으로 흘러가게 그린다 */
function pushLevel(bars: HTMLElement[], history: number[], db: number): void {
  history.push(Math.max(0, Math.min(1, (db + 65) / 50)));
  while (history.length > bars.length) history.shift();
  bars.forEach((b, i) => {
    const v = history[i] ?? 0;
    b.style.height = `${Math.round(8 + v * 92)}%`;
  });
}

let heroBars: HTMLElement[] = [];
const heroHistory: number[] = [];
let frameCount = 0;

function meterUpdate(): void {
  const width = (db: number) => `${Math.max(0, Math.min(100, ((db + 70) / 60) * 100))}%`;
  $('meterTeacher').style.width = width(levels.teacher);
  $('meterStudent').style.width = width(levels.student);
  // 수업 화면의 큰 막대는 초당 15번쯤만 옮긴다
  if (++frameCount % 4 === 0) pushLevel(heroBars, heroHistory, listening ? Math.max(levels.teacher, levels.student) : -90);
  levels.teacher -= 3;
  levels.student -= 3;
  requestAnimationFrame(meterUpdate);
}

function applyTuning(): void {
  if (!settings) return;
  for (const c of captures) c.setTuning(settings.latencyMode, pressure);
}

async function startCaptures(): Promise<void> {
  // 저장된 마이크가 빠져 있으면: 교사 마이크는 기본 마이크로, 학생 마이크는 건너뛴다
  const present = new Set((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d) => d.deviceId));
  let teacherMic = settings.teacherMicId;
  if (teacherMic && !present.has(teacherMic)) {
    note('warn', '설정한 교사 마이크를 찾지 못해 기본 마이크를 씁니다.');
    teacherMic = '';
  }
  let studentMic = settings.studentMicId;
  if (studentMic && !present.has(studentMic)) {
    note('warn', '설정한 학생 마이크를 찾지 못해 학생 마이크 없이 시작합니다.');
    studentMic = '';
  }
  const teacherChannel: Channel = settings.teacherMicMode === 'auto' ? 'auto' : 'teacher';
  const specs: { deviceId: string; channel: Channel; meter: 'teacher' | 'student' }[] = [
    { deviceId: teacherMic, channel: teacherChannel, meter: 'teacher' },
  ];
  if (studentMic && studentMic !== teacherMic) specs.push({ deviceId: studentMic, channel: 'student', meter: 'student' });
  for (const spec of specs) {
    const capture = new MicCapture({
      deviceId: spec.deviceId,
      onSegment: (pcm) => api.sendSegment(spec.channel, pcm),
      onLevel: (db) => {
        levels[spec.meter] = Math.max(levels[spec.meter], db);
      },
    });
    await capture.start();
    captures.push(capture);
  }
  renderQuota(await api.getQuota());
}

async function stopCaptures(): Promise<void> {
  const current = captures;
  captures = [];
  await Promise.all(current.map((c) => c.stop()));
}

async function restartCaptures(): Promise<void> {
  await stopCaptures();
  try {
    await startCaptures();
    note('info', '마이크 설정을 바꿔 다시 연결했습니다.');
  } catch (error) {
    await stop(`마이크를 열지 못했습니다: ${String(error)}`);
  }
}

async function start(): Promise<void> {
  await stopMicTest();
  await stopWizMic();
  const result = await api.startSession();
  if (!result.ok) {
    note('error', result.message);
    if (result.message.includes('Gemini API 키')) openWizard(1);
    else if (result.message.includes('키')) showPage('keys');
    return;
  }
  try {
    await startCaptures();
  } catch (error) {
    await stopCaptures();
    await api.stopSession();
    note('error', `마이크를 열지 못했습니다. 마이크 연결과 Windows 개인정보 설정(마이크 접근 허용)을 확인하세요. (${String(error)})`);
    return;
  }
  listening = true;
  renderListening();
  note('info', '듣기 시작');
}

async function stop(reason?: string): Promise<void> {
  await stopCaptures(); // 남은 말을 먼저 보내고
  await api.stopSession();
  listening = false;
  renderListening();
  note(reason ? 'error' : 'info', reason ?? '듣기 멈춤');
}

async function toggle(): Promise<void> {
  if (listening) await stop();
  else await start();
}

// ── AI 허브 데이터 ─────────────────────────────────────────────

let hasAihubKey = false;
let hasGeminiKey = false;
let aihubSelected: string | null = null;

function formatBytes(n: number | null): string {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

/** "필리핀어(타갈로그어)" → "필리핀어": 괄호 설명은 검색어에서 뺀다 */
function aihubLanguageWord(code: string): string {
  return (languageInfo(code)?.ko ?? code).replace(/\(.*\)/, '').trim();
}

function renderAihubChips(): void {
  const words = [
    // AI 허브 검색은 낱말이 그대로 들어간 데이터만 찾아서, 언어 이름만 쓰는 편이 더 많이 찾는다
    ...settings.studentLanguages.map(aihubLanguageWord),
    '다국어 통번역',
    '통번역',
    '병렬 말뭉치',
  ];
  $('aihubChips').replaceChildren(
    ...words.map((w) => {
      const b = el('button', '', w);
      b.type = 'button';
      b.addEventListener('click', () => {
        $<HTMLInputElement>('aihubQuery').value = w;
        void aihubSearch(w);
      });
      return b;
    }),
  );
}

function datasetRow(d: AihubDataset): HTMLElement {
  const row = el('button', `ds${d.id === aihubSelected ? ' active' : ''}`);
  row.type = 'button';
  row.dataset.id = d.id;
  const icon = el('span', 'ds-icon');
  icon.innerHTML = '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>';
  const body = el('div', 'ds-body');
  body.append(el('div', 'ds-name', d.name));
  const meta = el('div', 'ds-meta');
  for (const t of [d.realm, d.year && `${d.year}년`, ...d.types, formatBytes(d.fileSizeBytes), d.downloads && `다운로드 ${d.downloads}`]) {
    if (t) meta.append(el('span', '', t));
  }
  body.append(meta);
  row.append(icon, body);
  row.addEventListener('click', () => void aihubShow(d.id));
  return row;
}

async function aihubSearch(keyword: string): Promise<void> {
  const status = $('aihubStatus');
  if (!hasAihubKey) {
    status.textContent = '먼저 API 키 화면에서 AI 허브 키를 저장해 주세요.';
    return;
  }
  if (!keyword) {
    status.textContent = '찾을 말을 입력해 주세요. 예: 러시아어';
    return;
  }
  status.textContent = '찾는 중…';
  const result = await api.aihubSearch(keyword);
  if (!result.ok) status.textContent = result.message;
  else status.textContent = result.items.length ? `'${keyword}' 검색: ${result.message}` : `'${keyword}' 이(가) 들어간 데이터셋이 없어요. '다국어 통번역' 처럼 여러 언어를 묶은 데이터도 찾아 보세요.`;
  $('aihubResults').replaceChildren(...result.items.map(datasetRow));
}

/** 파일 경로에서 모든 파일에 공통인 앞 폴더(데이터셋 이름)는 뺀다 */
function trimCommonFolder(paths: string[]): string[] {
  const first = paths[0]?.split('/') ?? [];
  let n = 0;
  while (n < first.length - 1 && paths.every((p) => p.split('/')[n] === first[n])) n++;
  return paths.map((p) => p.split('/').slice(n).join('/'));
}

function renderAihubFiles(d: AihubDetail): HTMLElement {
  const det = el('details');
  det.open = true;
  det.append(el('summary', '', `파일 ${d.fileCount}개 · ${formatBytes(d.fileTotalBytes) || '크기 정보 없음'}`));
  if (d.fileCount === 0) {
    det.append(el('p', 'hint', 'API 로 받을 수 있는 파일 정보가 없어요. AI 허브 페이지에서 확인해 주세요.'));
    return det;
  }
  const list = el('ul', 'files');
  const names = trimCommonFolder(d.files.map((f) => f.path));
  d.files.forEach((f, i) => {
    const li = el('li');
    li.append(el('span', 'path', names[i]), el('span', 'size', formatBytes(f.size)));
    list.append(li);
  });
  det.append(list);
  if (d.fileCount > d.files.length) det.append(el('p', 'hint', `… 외 ${d.fileCount - d.files.length}개는 AI 허브 페이지에서 볼 수 있어요.`));
  det.append(el('p', 'hint', '데이터 파일은 AI 허브에서 이용 신청 후 받습니다. 대부분 재배포가 금지되어 있으니 이 PC 안에서만 쓰세요.'));
  return det;
}

function renderAihubDetail(d: AihubDetail): void {
  const box = $('aihubDetail');
  box.replaceChildren();
  box.append(el('h2', '', d.name));
  if (d.keywords.length) {
    const kw = el('div', 'ds-meta');
    for (const k of d.keywords.slice(0, 12)) kw.append(el('span', '', k));
    box.append(kw);
  }
  if (d.intro) box.append(el('p', 'intro', d.intro));
  const actions = el('div', 'btn-row');
  const open = el('button', 'btn primary', 'AI 허브에서 열기·이용 신청 ↗');
  open.type = 'button';
  open.addEventListener('click', () => void api.openExternal(d.url));
  actions.append(open);
  box.append(actions);
  for (const section of d.sections) {
    const det = el('details');
    // 구축량·라벨링 형식이 담긴 묶음을 먼저 펼쳐 둔다
    if (section.title.includes('메타데이터')) det.open = true;
    det.append(el('summary', '', section.title));
    const dl = el('dl');
    for (const item of section.items.slice(0, 80)) dl.append(el('dt', '', item.label), el('dd', '', item.value));
    det.append(dl);
    box.append(det);
  }
  box.append(renderAihubFiles(d));
}

async function aihubShow(id: string): Promise<void> {
  aihubSelected = id;
  document.querySelectorAll<HTMLElement>('#aihubResults .ds').forEach((n) => n.classList.toggle('active', n.dataset.id === id));
  const box = $('aihubDetail');
  box.classList.remove('hidden');
  document.querySelector('.aihub-grid')?.classList.add('with-detail');
  box.replaceChildren(el('p', 'hint', '불러오는 중…'));
  const result = await api.aihubDetail(id);
  if (!result.ok || !result.detail) {
    box.replaceChildren(el('p', 'notice warn', result.message || '불러오지 못했습니다.'));
    return;
  }
  renderAihubDetail(result.detail);
}

function bindAihub(): void {
  const input = $<HTMLInputElement>('aihubQuery');
  $('aihubSearch').addEventListener('click', () => void aihubSearch(input.value.trim()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void aihubSearch(input.value.trim());
  });
  document.querySelector<HTMLElement>('.nav[data-page="aihub"]')?.addEventListener('click', () => {
    renderAihubChips();
    if (!input.value && hasAihubKey && settings.studentLanguages[0]) {
      input.value = aihubLanguageWord(settings.studentLanguages[0]);
      void aihubSearch(input.value);
    }
  });
}

// ── 자막 창 위치 ───────────────────────────────────────────────

async function place(patch: { displayId?: number | null; anchor?: OverlayAnchor | null; widthPct?: number; height?: number }): Promise<void> {
  await api.placeOverlay({
    displayId: patch.displayId !== undefined ? patch.displayId : settings.overlayDisplayId,
    anchor: patch.anchor !== undefined ? patch.anchor : settings.overlayAnchor,
    widthPct: patch.widthPct ?? settings.overlayWidthPct,
    height: patch.height ?? settings.overlayHeight,
  });
}

function renderOverlayVisible(visible: boolean): void {
  overlayVisible = visible;
  const b = $('toggleOverlay');
  b.querySelector('span')!.textContent = visible ? '자막 숨기기' : '자막 보이기';
  if (settings) renderQuick();
}

// ── 키 ─────────────────────────────────────────────────────────

function keyResult(ok: boolean, text: string): void {
  const node = $('keyResult');
  node.textContent = text;
  node.className = `result ${ok ? 'ok' : 'err'}`;
}

async function refreshKeys(): Promise<void> {
  const status = await api.getKeyStatus();
  for (const p of ['gemini', 'claude', 'aihub'] as const) {
    const badge = $(`${p}Masked`);
    badge.textContent = status[p] ? `저장됨 · ${status[p]}` : '없음';
    badge.classList.toggle('ok', Boolean(status[p]));
  }
  hasGeminiKey = Boolean(status.gemini);
  $('aihubNoKey').classList.toggle('hidden', Boolean(status.aihub));
  hasAihubKey = Boolean(status.aihub);
  $('keyDot').classList.toggle('hidden', Boolean(status.gemini));
  if (settings) {
    renderReady();
    renderListening();
  }
}

function bindKey(provider: KeyProvider): void {
  const input = $<HTMLInputElement>(`${provider}Key`);
  $(`${provider}Save`).addEventListener('click', async () => {
    try {
      await api.saveKey(provider, input.value);
      input.value = '';
      await refreshKeys();
      keyResult(true, '키를 이 PC 에 암호화해 저장했습니다. 연결 테스트를 눌러 확인하세요.');
    } catch (error) {
      keyResult(false, cleanError(error));
    }
  });
  $(`${provider}Clear`).addEventListener('click', async () => {
    await api.clearKey(provider);
    await refreshKeys();
    keyResult(true, '키를 삭제했습니다.');
  });
  $(`${provider}Test`).addEventListener('click', async () => {
    keyResult(true, '확인 중…');
    const result = await api.testKey(provider);
    keyResult(result.ok, result.message);
    if (provider === 'gemini' && result.models) {
      $('geminiModels').replaceChildren(...result.models.map((m) => Object.assign(el('option'), { value: m })));
      if (settings.geminiModelMode === 'manual' && result.recommendedModel && !result.models.includes(settings.geminiModel)) {
        await save({ geminiModel: result.recommendedModel });
        keyResult(true, `${result.message} 추천 모델(${result.recommendedModel})로 바꿨습니다.`);
      }
      renderQuota(await api.getQuota());
    }
  });
}

/** IPC 오류 메시지에서 Electron 이 붙이는 앞부분을 뗀다 */
function cleanError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ── 처음 설정 (마법사) ─────────────────────────────────────────

const WIZ_STEPS = 5;
let wizStep = 0;
let wizKeyOk = false;
let wizCapture: MicCapture | null = null;
let wizBars: HTMLElement[] = [];
const wizHistory: number[] = [];

function openWizard(step = 0): void {
  wizKeyOk = hasGeminiKey;
  $('wizard').classList.remove('hidden');
  $<HTMLInputElement>('wizConsent').checked = settings.consentAcknowledged;
  wizGo(step);
}

async function closeWizard(done: boolean): Promise<void> {
  await stopWizMic();
  $('wizard').classList.add('hidden');
  if (done || !settings.onboarded) await save({ onboarded: true });
}

function wizCanNext(): boolean {
  if (wizStep === 0) return $<HTMLInputElement>('wizConsent').checked;
  if (wizStep === 1) return wizKeyOk;
  if (wizStep === 2) return settings.studentLanguages.length > 0;
  return true;
}

function wizRender(): void {
  document.querySelectorAll<HTMLElement>('.wiz-step').forEach((sec) => sec.classList.toggle('active', Number(sec.dataset.step) === wizStep));
  [...$('wizSteps').children].forEach((li, i) => {
    li.classList.toggle('done', i < wizStep);
    li.classList.toggle('active', i === wizStep);
  });
  $('wizBack').classList.toggle('hidden', wizStep === 0);
  const next = $<HTMLButtonElement>('wizNext');
  next.textContent = wizStep === WIZ_STEPS - 1 ? '수업 화면으로' : '다음';
  next.disabled = !wizCanNext();
  if (wizStep === 1) {
    const r = $('wizKeyResult');
    if (wizKeyOk && !r.textContent) {
      r.textContent = '저장된 키가 있어요 ✓ 그대로 다음으로 가도 됩니다.';
      r.className = 'result ok';
    }
  }
}

function wizGo(step: number): void {
  const prev = wizStep;
  wizStep = Math.max(0, Math.min(WIZ_STEPS - 1, step));
  if (prev === 3 && wizStep !== 3) void stopWizMic();
  if (wizStep === 2) renderWizLangs();
  if (wizStep === 3) void startWizMic();
  wizRender();
}

function renderWizLangs(): void {
  $('wizLangs').replaceChildren(
    ...STUDENT_LANGUAGES.map((l) =>
      chip(l.ko, l.native, settings.studentLanguages.includes(l.code), (on) => {
        const next = on ? [...settings.studentLanguages, l.code] : settings.studentLanguages.filter((c) => c !== l.code);
        if (next.length === 0) return renderWizLangs();
        const overlay = on && settings.overlayLanguages.length < 3 ? [...settings.overlayLanguages, l.code] : settings.overlayLanguages.filter((c) => next.includes(c));
        void save({ studentLanguages: next, overlayLanguages: overlay }).then(wizRender);
      }),
    ),
  );
}

async function startWizMic(): Promise<void> {
  await stopWizMic();
  const select = $<HTMLSelectElement>('wizMic');
  select.replaceChildren(...[...$<HTMLSelectElement>('teacherMic').options].map((o) => o.cloneNode(true) as HTMLOptionElement));
  select.value = settings.teacherMicId;
  setRadio('wizMicMode', settings.teacherMicMode);
  if (listening) {
    $('wizMicNote').textContent = '수업 중에는 마이크 시험을 건너뜁니다.';
    return;
  }
  wizCapture = new MicCapture({
    deviceId: settings.teacherMicId,
    onSegment: () => undefined, // 시험 중에는 아무것도 보내지 않는다
    onLevel: (db) => pushLevel(wizBars, wizHistory, db),
  });
  try {
    await wizCapture.start();
    $('wizMicNote').textContent = '';
  } catch (error) {
    wizCapture = null;
    $('wizMicNote').textContent = `마이크를 열지 못했어요. 연결과 Windows 마이크 권한을 확인해 주세요. (${String(error)})`;
  }
}

async function stopWizMic(): Promise<void> {
  const c = wizCapture;
  wizCapture = null;
  if (c) await c.stop();
}

function bindWizard(): void {
  wizBars = makeBars('wizLevel');
  $<HTMLInputElement>('wizConsent').addEventListener('change', (e) => {
    void save({ consentAcknowledged: (e.target as HTMLInputElement).checked });
    wizRender();
  });
  $('wizBack').addEventListener('click', () => wizGo(wizStep - 1));
  $('wizNext').addEventListener('click', () => {
    if (!wizCanNext()) return;
    if (wizStep === WIZ_STEPS - 1) {
      void closeWizard(true);
      showPage('live');
    } else {
      wizGo(wizStep + 1);
    }
  });
  $('wizSkip').addEventListener('click', () => void closeWizard(false));
  $('wizKeySave').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('wizKey');
    const r = $('wizKeyResult');
    r.className = 'result';
    r.textContent = '저장하고 연결을 확인하는 중…';
    try {
      await api.saveKey('gemini', input.value);
      input.value = '';
      const result = await api.testKey('gemini');
      wizKeyOk = result.ok;
      r.className = `result ${result.ok ? 'ok' : 'err'}`;
      r.textContent = result.ok ? `연결됐어요 ✓ ${result.message}` : result.message;
      await refreshKeys();
      if (result.ok) renderQuota(await api.getQuota());
    } catch (error) {
      wizKeyOk = false;
      r.className = 'result err';
      r.textContent = cleanError(error);
    }
    wizRender();
  });
  $<HTMLSelectElement>('wizMic').addEventListener('change', (e) => {
    void save({ teacherMicId: (e.target as HTMLSelectElement).value }).then(() => startWizMic());
  });
  document.querySelectorAll<HTMLInputElement>('input[name="wizMicMode"]').forEach((r) =>
    r.addEventListener('change', () => void save({ teacherMicMode: r.value as Settings['teacherMicMode'] })));
  document.addEventListener('keydown', (e) => {
    if ($('wizard').classList.contains('hidden')) return;
    if (e.key === 'Escape') void closeWizard(false);
  });
}

// ── 마이크 시험 (마이크 화면) ──────────────────────────────────

let micTest: MicCapture | null = null;
let micTestBars: HTMLElement[] = [];
const micTestHistory: number[] = [];
let micTestPeak = -90;

async function stopMicTest(): Promise<void> {
  const c = micTest;
  micTest = null;
  if (c) await c.stop();
  $('micTest').textContent = '마이크 시험하기';
}

function bindMicTest(): void {
  micTestBars = makeBars('micTestLevel');
  $('micTest').addEventListener('click', async () => {
    if (micTest) {
      await stopMicTest();
      $('micTestNote').textContent = micTestPeak > -45 ? '잘 들려요 ✓' : '소리가 작게 들려요. 마이크를 가까이 하거나 다른 마이크를 골라 보세요.';
      return;
    }
    if (listening) {
      $('micTestNote').textContent = '수업 중에는 위쪽 막대로 소리 크기를 볼 수 있어요.';
      return;
    }
    micTestPeak = -90;
    micTest = new MicCapture({
      deviceId: settings.teacherMicId,
      onSegment: () => undefined,
      onLevel: (db) => {
        micTestPeak = Math.max(micTestPeak, db);
        pushLevel(micTestBars, micTestHistory, db);
      },
    });
    try {
      await micTest.start();
      $('micTest').textContent = '시험 끝내기';
      $('micTestNote').textContent = '아무 말이나 해 보세요.';
    } catch (error) {
      micTest = null;
      $('micTestNote').textContent = `마이크를 열지 못했어요 (${String(error)})`;
    }
  });
}

// ── 이벤트 연결 ────────────────────────────────────────────────

function bind(): void {
  document.querySelectorAll<HTMLElement>('.nav').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page ?? 'live')));
  document.querySelectorAll<HTMLElement>('[data-goto]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.goto ?? 'live')));
  document.querySelectorAll<HTMLElement>('[data-open]').forEach((b) => b.addEventListener('click', () => void api.openExternal(b.dataset.open ?? '')));

  $('startStop').addEventListener('click', () => void toggle());
  $('bigStart').addEventListener('click', () => {
    if (!hasGeminiKey && !listening) openWizard(1);
    else void toggle();
  });
  $('reopenWizard').addEventListener('click', () => openWizard(0));
  bindWizard();
  bindMicTest();
  bindKey('gemini');
  bindKey('claude');
  bindKey('aihub');
  bindAihub();

  const radios = (name: string, fn: (value: string) => void) =>
    document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((r) => r.addEventListener('change', () => fn(r.value)));
  radios('micMode', (v) => void save({ teacherMicMode: v as Settings['teacherMicMode'] }));
  radios('translator', (v) => void save({ translator: v as Settings['translator'] }));
  radios('latency', (v) => void save({ latencyMode: v as LatencyMode }));
  radios('modelPref', (v) => void save({ modelPreference: v as Settings['modelPreference'] }));
  $<HTMLInputElement>('hedge').addEventListener('change', (e) => void save({ hedgeRequests: (e.target as HTMLInputElement).checked }));
  $<HTMLInputElement>('manualModel').addEventListener('change', (e) => void save({ geminiModelMode: (e.target as HTMLInputElement).checked ? 'manual' : 'auto' }));

  $<HTMLSelectElement>('teacherMic').addEventListener('change', (e) => void save({ teacherMicId: (e.target as HTMLSelectElement).value }));
  document.querySelectorAll<HTMLElement>('.nav').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.page !== 'mic') void stopMicTest();
  }));
  $<HTMLSelectElement>('studentMic').addEventListener('change', (e) => void save({ studentMicId: (e.target as HTMLSelectElement).value }));
  $('refreshMics').addEventListener('click', () => void renderMics());

  const claudeSelect = $<HTMLSelectElement>('claudeModel');
  claudeSelect.replaceChildren(...CLAUDE_MODELS.map((m) => Object.assign(el('option'), { value: m.id, textContent: m.label })));
  claudeSelect.addEventListener('change', () => void save({ claudeModel: claudeSelect.value }));

  const text = (id: string, key: keyof Settings) =>
    $<HTMLInputElement>(id).addEventListener('change', (e) => void save({ [key]: (e.target as HTMLInputElement).value.trim() }));
  text('geminiModel', 'geminiModel');
  text('geminiFallback', 'geminiFallbackModel');
  const num = (id: string, key: keyof Settings) =>
    $<HTMLInputElement>(id).addEventListener('change', (e) => void save({ [key]: Number((e.target as HTMLInputElement).value) }));
  num('dailyLimit', 'dailyRequestLimit');
  num('rpm', 'requestsPerMinute');
  num('linkPort', 'studentLinkPort');

  const saveGlossary = debounce((value: string) => void save({ glossary: value }), 600);
  $<HTMLTextAreaElement>('glossary').addEventListener('input', (e) => saveGlossary((e.target as HTMLTextAreaElement).value));

  // 자막 창
  $('showKorean').addEventListener('change', (e) => void save({ showKoreanOnOverlay: (e.target as HTMLInputElement).checked }));
  document.querySelectorAll<HTMLButtonElement>('#anchorGrid button').forEach((b) =>
    b.addEventListener('click', () => void place({ anchor: b.dataset.anchor as OverlayAnchor })));
  const placeSize = debounce((patch: { widthPct?: number; height?: number }) => void place(patch), 120);
  const width = $<HTMLInputElement>('widthPct');
  width.addEventListener('input', () => {
    $('widthValue').textContent = `${width.value}%`;
    placeSize({ widthPct: Number(width.value) });
  });
  const height = $<HTMLInputElement>('heightPx');
  height.addEventListener('input', () => {
    $('heightValue').textContent = `${height.value}px`;
    placeSize({ height: Number(height.value) });
  });
  const font = $<HTMLInputElement>('fontSize');
  const saveFont = debounce((v: number) => void save({ overlayFontSize: v }), 120);
  font.addEventListener('input', () => {
    $('fontSizeValue').textContent = `${font.value}px`;
    saveFont(Number(font.value));
  });
  $('fontDown').addEventListener('click', () => void save({ overlayFontSize: settings.overlayFontSize - 2 }));
  $('fontUp').addEventListener('click', () => void save({ overlayFontSize: settings.overlayFontSize + 2 }));
  $('toggleOverlay').addEventListener('click', () => void api.setOverlayVisible(!overlayVisible));
  $('resetOverlay').addEventListener('click', () => void place({ displayId: null, anchor: 'bottom-center', widthPct: 90, height: 280 }));
  $('moveOverlay').addEventListener('click', () => void api.toggleMoveMode());

  $('linkEnabled').addEventListener('change', (e) => void save({ studentLinkEnabled: (e.target as HTMLInputElement).checked }));
  $('clearLog').addEventListener('click', showEmptyLog);

  api.onCaption(addCaption);
  api.onQuota(renderQuota);
  api.onStatus(addMessage);
  api.onStudentLink(renderLink);
  api.onSettings((next) => {
    settings = next;
    render();
  });
  api.onDisplays((list) => {
    displays = list;
    renderDisplays();
  });
  api.onOverlayVisible(renderOverlayVisible);
  api.onToggleListening(() => void toggle());
  api.onSessionStopped(() => {
    void stopCaptures().then(() => {
      listening = false;
      renderListening();
    });
  });
  api.onOverlayMoveMode((on) => note('info', on ? '자막 전체를 끌어 옮기고 가장자리로 크기를 바꾸세요. 다 되면 Ctrl+Alt+M' : '자막 위치를 저장했습니다.'));
}

async function init(): Promise<void> {
  settings = await api.getSettings();
  displays = await api.getDisplays();
  heroBars = makeBars('heroLevel');
  bind();
  await renderMics();
  render();
  showEmptyLog();
  await refreshKeys();
  renderListening();
  renderQuota(await api.getQuota());
  renderLink(await api.getStudentLink());
  requestAnimationFrame(meterUpdate);
  if (!settings.onboarded) openWizard(0);
}

void init();
