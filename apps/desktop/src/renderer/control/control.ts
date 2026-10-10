// 교사용 컨트롤 패널: 왼쪽 메뉴로 화면을 바꾸고, 수업 시작/정지·실시간 자막·설정을 다룬다
import type {
  Caption,
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

const SPEED_LABEL: Record<LatencyMode, string> = { fast: '빠르게', balanced: '보통', saving: '절약' };
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
  $('statSpeed').textContent = pressure === 'normal' ? SPEED_LABEL[settings.latencyMode] : `${SPEED_LABEL[settings.latencyMode]} → 절약 (한도 아낌)`;
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

function renderQuota(q: QuotaStatus): void {
  pressure = q.pressure;
  const pct = q.limit > 0 ? Math.min(100, (q.used / q.limit) * 100) : 0;
  $('quotaBar').style.width = `${pct}%`;
  $('quotaText').textContent = `${q.used} / ${q.limit}`;
  const box = $('quota');
  box.classList.toggle('saving', q.pressure === 'saving');
  box.classList.toggle('exhausted', q.pressure === 'exhausted');
  box.title = `모델 ${q.model}`;
  const wait = q.waitUntil ? ` · ${Math.max(1, Math.ceil((q.waitUntil - Date.now()) / 1000))}초 대기` : '';
  $('statQueue').textContent = `${q.queued}개${wait}`;
  $('statModel').textContent = q.model;
  if (settings) $('statSpeed').textContent = pressure === 'normal' ? SPEED_LABEL[settings.latencyMode] : `${SPEED_LABEL[settings.latencyMode]} → 절약 (한도 아낌)`;
  applyTuning();
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
  if (c.final) $('statLatency').textContent = `말 끝나고 ${(c.latencyMs / 1000).toFixed(1)}초`;
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
}

function meterUpdate(): void {
  const width = (db: number) => `${Math.max(0, Math.min(100, ((db + 70) / 60) * 100))}%`;
  $('meterTeacher').style.width = width(levels.teacher);
  $('meterStudent').style.width = width(levels.student);
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
  const result = await api.startSession();
  if (!result.ok) {
    note('error', result.message);
    if (result.message.includes('키')) showPage('keys');
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
}

// ── 키 ─────────────────────────────────────────────────────────

function keyResult(ok: boolean, text: string): void {
  const node = $('keyResult');
  node.textContent = text;
  node.className = `result ${ok ? 'ok' : 'err'}`;
}

async function refreshKeys(): Promise<void> {
  const status = await api.getKeyStatus();
  for (const p of ['gemini', 'claude'] as const) {
    const badge = $(`${p}Masked`);
    badge.textContent = status[p] ? `저장됨 · ${status[p]}` : '없음';
    badge.classList.toggle('ok', Boolean(status[p]));
  }
  $('setupCard').classList.toggle('hidden', Boolean(status.gemini));
  $('keyDot').classList.toggle('hidden', Boolean(status.gemini));
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
      if (result.recommendedModel && !result.models.includes(settings.geminiModel)) {
        await save({ geminiModel: result.recommendedModel });
        keyResult(true, `${result.message} 추천 모델(${result.recommendedModel})로 바꿨습니다.`);
      }
    }
  });
}

/** IPC 오류 메시지에서 Electron 이 붙이는 앞부분을 뗀다 */
function cleanError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ── 이벤트 연결 ────────────────────────────────────────────────

function bind(): void {
  document.querySelectorAll<HTMLElement>('.nav').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page ?? 'live')));
  document.querySelectorAll<HTMLElement>('[data-goto]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.goto ?? 'live')));
  document.querySelectorAll<HTMLElement>('[data-open]').forEach((b) => b.addEventListener('click', () => void api.openExternal(b.dataset.open ?? '')));

  $('startStop').addEventListener('click', () => void toggle());
  bindKey('gemini');
  bindKey('claude');

  const radios = (name: string, fn: (value: string) => void) =>
    document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((r) => r.addEventListener('change', () => fn(r.value)));
  radios('micMode', (v) => void save({ teacherMicMode: v as Settings['teacherMicMode'] }));
  radios('translator', (v) => void save({ translator: v as Settings['translator'] }));
  radios('latency', (v) => void save({ latencyMode: v as LatencyMode }));

  $<HTMLSelectElement>('teacherMic').addEventListener('change', (e) => void save({ teacherMicId: (e.target as HTMLSelectElement).value }));
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
  bind();
  render();
  showEmptyLog();
  renderListening();
  await refreshKeys();
  renderQuota(await api.getQuota());
  renderLink(await api.getStudentLink());
  await renderMics();
  requestAnimationFrame(meterUpdate);
}

void init();
