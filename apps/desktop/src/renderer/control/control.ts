// 교사용 컨트롤 패널: 키·언어·마이크 설정, 수업 시작/정지, 실시간 자막 기록
import type { Caption, Channel, KeyProvider, QuotaStatus, Settings, StatusMessage, StudentLinkStatus } from '../../shared/types';
import { STUDENT_LANGUAGES, languageInfo } from '../../shared/languages';
import { MicCapture, listMicrophones } from '../audio/capture';
import { CLAUDE_MODELS } from '../../shared/claude-models';
import '../global';

const api = window.api;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let listening = false;
let captures: MicCapture[] = [];
const levels = { teacher: -90, student: -90 };

// ── 설정 저장 ──────────────────────────────────────────────────

async function save(patch: Partial<Settings>): Promise<void> {
  const micChanged = 'teacherMicId' in patch || 'studentMicId' in patch || 'teacherMicMode' in patch;
  settings = await api.updateSettings(patch);
  render();
  if (micChanged && listening) await restartCaptures();
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ── 화면 그리기 ────────────────────────────────────────────────

function checkbox(value: string, label: string, checked: boolean, onChange: (on: boolean) => void, disabled = false): HTMLLabelElement {
  const wrap = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = value;
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(input, document.createTextNode(label));
  return wrap;
}

function renderLanguages(): void {
  $('studentLangs').replaceChildren(
    ...STUDENT_LANGUAGES.map((l) =>
      checkbox(l.code, `${l.ko} (${l.native})`, settings.studentLanguages.includes(l.code), (on) => {
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
      return checkbox(code, languageInfo(code)?.ko ?? code, on, (checked) => {
        const next = checked ? [...settings.overlayLanguages, code] : settings.overlayLanguages.filter((c) => c !== code);
        void save({ overlayLanguages: next });
      }, !on && settings.overlayLanguages.length >= 3);
    }),
  );
  $<HTMLInputElement>('showKorean').checked = settings.showKoreanOnOverlay;
}

function setRadio(name: string, value: string): void {
  document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((r) => (r.checked = r.value === value));
}

function setValue(id: string, value: string | number): void {
  const el = $<HTMLInputElement>(id);
  if (document.activeElement !== el) el.value = String(value);
}

function render(): void {
  renderLanguages();
  setRadio('micMode', settings.teacherMicMode);
  setRadio('translator', settings.translator);
  $<HTMLSelectElement>('claudeModel').value = settings.claudeModel;
  setValue('geminiModel', settings.geminiModel);
  setValue('geminiFallback', settings.geminiFallbackModel);
  setValue('dailyLimit', settings.dailyRequestLimit);
  setValue('rpm', settings.requestsPerMinute);
  setValue('glossary', settings.glossary);
  setValue('fontSize', settings.overlayFontSize);
  $('fontSizeValue').textContent = `${settings.overlayFontSize}px`;
  $<HTMLInputElement>('linkEnabled').checked = settings.studentLinkEnabled;
  setValue('linkPort', settings.studentLinkPort);
  $<HTMLSelectElement>('teacherMic').value = settings.teacherMicId;
  $<HTMLSelectElement>('studentMic').value = settings.studentMicId;
  $('meterStudentWrap').classList.toggle('hidden', !settings.studentMicId);
}

async function renderMics(): Promise<void> {
  const mics = await listMicrophones();
  const option = (value: string, label: string) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  };
  const named = mics.map((m, i) => option(m.deviceId === 'default' ? '' : m.deviceId, m.label || `마이크 ${i + 1}`));
  const teacher = $<HTMLSelectElement>('teacherMic');
  teacher.replaceChildren(...(mics.some((m) => m.deviceId === 'default') ? [] : [option('', '시스템 기본 마이크')]), ...named);
  const student = $<HTMLSelectElement>('studentMic');
  student.replaceChildren(option('', '사용 안 함'), ...named.map((o) => o.cloneNode(true) as HTMLOptionElement).filter((o) => o.value !== ''));
  teacher.value = settings.teacherMicId;
  student.value = settings.studentMicId;
}

function renderQuota(q: QuotaStatus): void {
  const pct = q.limit > 0 ? Math.min(100, (q.used / q.limit) * 100) : 0;
  $('quotaBar').style.width = `${pct}%`;
  const wait = q.waitUntil ? ` · ${Math.max(1, Math.ceil((q.waitUntil - Date.now()) / 1000))}초 대기` : '';
  const queued = q.queued > 0 ? ` · 대기 ${q.queued}` : '';
  $('quotaText').textContent = `오늘 ${q.used} / ${q.limit}${queued}${wait}`;
  const box = $('quota');
  box.classList.toggle('saving', q.pressure === 'saving');
  box.classList.toggle('exhausted', q.pressure === 'exhausted');
  box.title = `모델 ${q.model} · ${q.pressure === 'saving' ? '절약 모드: 문장을 길게 묶는 중' : q.pressure === 'exhausted' ? '오늘 한도 소진' : '정상'}`;
  for (const c of captures) c.setPressure(q.pressure);
}

function renderLink(link: StudentLinkStatus): void {
  const box = $('linkBox');
  box.replaceChildren();
  if (link.error) {
    const p = document.createElement('p');
    p.className = 'result err';
    p.textContent = link.error;
    box.append(p);
    return;
  }
  if (!link.enabled) return;
  if (link.urls.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint warn';
    p.textContent = '네트워크 주소를 찾지 못했습니다. 교사 PC 가 학교 네트워크에 연결돼 있는지 확인하세요.';
    box.append(p);
  }
  for (const url of link.urls) {
    const row = document.createElement('div');
    row.className = 'url';
    const code = document.createElement('code');
    code.textContent = url;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '복사';
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(url).then(() => {
        copy.textContent = '복사됨';
        setTimeout(() => (copy.textContent = '복사'), 1500);
      });
    });
    row.append(code, copy);
    box.append(row);
  }
  const count = document.createElement('p');
  count.className = 'hint';
  count.textContent = `지금 접속한 학생 PC: ${link.clients}대`;
  box.append(count);
}

// ── 자막 기록·메시지 ───────────────────────────────────────────

const MAX_LOG = 200;

function addCaption(c: Caption): void {
  const log = $('log');
  log.querySelector('.empty')?.remove();
  const box = document.createElement('article');
  box.className = `cap ${c.speaker}`;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const who = c.speaker === 'teacher' ? '교사' : `학생 · ${languageInfo(c.lang)?.ko ?? c.lang}`;
  meta.textContent = `${new Date(c.ts).toLocaleTimeString('ko-KR')} · ${who} · ${(c.latencyMs / 1000).toFixed(1)}초`;
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = c.transcript;
  box.append(meta, text);
  for (const [code, value] of Object.entries(c.translations)) {
    const tr = document.createElement('div');
    tr.className = 'tr';
    const tag = document.createElement('b');
    tag.textContent = languageInfo(code)?.ko ?? code;
    tr.append(tag, document.createTextNode(value));
    if (languageInfo(code)?.rtl) tr.dir = 'rtl';
    box.append(tr);
  }
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 60;
  log.append(box);
  while (log.children.length > MAX_LOG) log.firstElementChild?.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function showEmptyLog(): void {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = "'수업 시작'을 누르고 말하면 여기에 자막이 나옵니다.";
  $('log').replaceChildren(p);
}

function addMessage(m: StatusMessage): void {
  const box = $('messages');
  const div = document.createElement('div');
  div.className = `msg ${m.level}`;
  const time = document.createElement('time');
  time.textContent = new Date(m.ts).toLocaleTimeString('ko-KR');
  div.append(time, document.createTextNode(m.text));
  box.append(div);
  while (box.children.length > 60) box.firstElementChild?.remove();
  box.scrollTop = box.scrollHeight;
}

function note(level: StatusMessage['level'], text: string): void {
  addMessage({ level, text, ts: Date.now() });
}

// ── 듣기 시작/정지 ─────────────────────────────────────────────

function renderListening(): void {
  const button = $('startStop');
  button.textContent = listening ? '■ 수업 끝내기' : '▶ 수업 시작';
  button.classList.toggle('stop', listening);
  const state = $('state');
  state.textContent = listening ? '듣는 중' : '멈춤';
  state.className = `chip ${listening ? 'on' : 'off'}`;
}

function meterUpdate(): void {
  const width = (db: number) => `${Math.max(0, Math.min(100, ((db + 70) / 60) * 100))}%`;
  $('meterTeacher').style.width = width(levels.teacher);
  $('meterStudent').style.width = width(levels.student);
  levels.teacher -= 3;
  levels.student -= 3;
  requestAnimationFrame(meterUpdate);
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
  if (studentMic && studentMic !== teacherMic) {
    specs.push({ deviceId: studentMic, channel: 'student', meter: 'student' });
  }
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
  const q = await api.getQuota();
  for (const c of captures) c.setPressure(q.pressure);
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
    $('secKeys').setAttribute('open', '');
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
  if (reason) note('error', reason);
  else note('info', '듣기 멈춤');
}

async function toggle(): Promise<void> {
  if (listening) await stop();
  else await start();
}

// ── 키 ─────────────────────────────────────────────────────────

function keyResult(ok: boolean, text: string): void {
  const el = $('keyResult');
  el.textContent = text;
  el.className = `result ${ok ? 'ok' : 'err'}`;
}

async function refreshKeys(): Promise<void> {
  const status = await api.getKeyStatus();
  $('geminiMasked').textContent = status.gemini ? `저장됨: ${status.gemini}` : '저장된 키 없음';
  $('claudeMasked').textContent = status.claude ? `저장됨: ${status.claude}` : '저장된 키 없음';
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
      $('geminiModels').replaceChildren(...result.models.map((m) => Object.assign(document.createElement('option'), { value: m })));
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
  $('startStop').addEventListener('click', () => void toggle());
  bindKey('gemini');
  bindKey('claude');

  $<HTMLInputElement>('showKorean').addEventListener('change', (e) => void save({ showKoreanOnOverlay: (e.target as HTMLInputElement).checked }));
  document.querySelectorAll<HTMLInputElement>('input[name="micMode"]').forEach((r) =>
    r.addEventListener('change', () => void save({ teacherMicMode: r.value as Settings['teacherMicMode'] })));
  document.querySelectorAll<HTMLInputElement>('input[name="translator"]').forEach((r) =>
    r.addEventListener('change', () => void save({ translator: r.value as Settings['translator'] })));
  $<HTMLSelectElement>('teacherMic').addEventListener('change', (e) => void save({ teacherMicId: (e.target as HTMLSelectElement).value }));
  $<HTMLSelectElement>('studentMic').addEventListener('change', (e) => void save({ studentMicId: (e.target as HTMLSelectElement).value }));
  $('refreshMics').addEventListener('click', () => void renderMics());

  const claudeSelect = $<HTMLSelectElement>('claudeModel');
  claudeSelect.replaceChildren(...CLAUDE_MODELS.map((m) => Object.assign(document.createElement('option'), { value: m.id, textContent: m.label })));
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

  const font = $<HTMLInputElement>('fontSize');
  const saveFont = debounce((v: number) => void save({ overlayFontSize: v }), 150);
  font.addEventListener('input', () => {
    $('fontSizeValue').textContent = `${font.value}px`;
    saveFont(Number(font.value));
  });
  $('resetOverlay').addEventListener('click', () => void save({ overlayBounds: null }));
  $('moveOverlay').addEventListener('click', () => note('info', 'Ctrl+Alt+M 을 누르면 자막을 끌어서 옮기고 가장자리로 크기를 바꿀 수 있어요. 다 되면 다시 Ctrl+Alt+M.'));

  $<HTMLInputElement>('linkEnabled').addEventListener('change', (e) => void save({ studentLinkEnabled: (e.target as HTMLInputElement).checked }));
  $('clearLog').addEventListener('click', showEmptyLog);

  document.querySelectorAll<HTMLElement>('[data-open]').forEach((el) =>
    el.addEventListener('click', () => void api.openExternal(el.dataset.open ?? '')));

  api.onCaption(addCaption);
  api.onQuota(renderQuota);
  api.onStatus(addMessage);
  api.onStudentLink(renderLink);
  api.onSettings((next) => {
    settings = next;
    render();
  });
  api.onToggleListening(() => void toggle());
  api.onSessionStopped(() => {
    void stopCaptures().then(() => {
      listening = false;
      renderListening();
    });
  });
  api.onOverlayMoveMode((on) => note('info', on ? '자막 위치·크기 바꾸기 모드 — 다 되면 Ctrl+Alt+M' : '자막 위치를 저장했습니다.'));
}

async function init(): Promise<void> {
  settings = await api.getSettings();
  bind();
  render();
  showEmptyLog();
  renderListening();
  await refreshKeys();
  renderQuota(await api.getQuota());
  renderLink(await api.getStudentLink());
  await renderMics();
  requestAnimationFrame(meterUpdate);
  const keysNow = await api.getKeyStatus();
  if (!keysNow.gemini) note('warn', '처음이라면 ① API 키에 Gemini 키를 저장하고 연결 테스트를 눌러 주세요.');
}

void init();
