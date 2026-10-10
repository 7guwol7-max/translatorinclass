// 학생 PC 화면: 내 언어를 골라 교사 자막을 실시간으로 본다 (읽기 전용)

interface StudentLanguage { code: string; native: string; ko: string; rtl: boolean }
interface CaptionData {
  id: string;
  seq: number;
  final: boolean;
  ts: number;
  speaker: 'teacher' | 'student';
  lang: string;
  transcript: string;
  translations: Record<string, string>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = $<HTMLSelectElement>('language');
const list = $<HTMLElement>('captions');
const empty = $<HTMLElement>('empty');
const conn = $<HTMLElement>('conn');
const connText = $<HTMLElement>('connText');
const showKorean = $<HTMLInputElement>('showKorean');

const MAX_SHOWN = 30;
const captions: CaptionData[] = [];
let languages: StudentLanguage[] = [];

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 저장소를 못 쓰면 이번 접속에만 적용 */ }
}

let fontSize = Number(load('fontSize')) || 28;
document.documentElement.style.setProperty('--size', `${fontSize}px`);
showKorean.checked = load('showKorean') !== '0';

function chosen(): string {
  return select.value || languages[0]?.code || 'ko';
}

function renderLanguages(): void {
  const previous = load('language');
  select.replaceChildren(...languages.map((l) => {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = `${l.native} · ${l.ko}`;
    return o;
  }));
  if (previous && languages.some((l) => l.code === previous)) select.value = previous;
}

function line(className: string, text: string, rtl = false): HTMLElement {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text; // 항상 textContent (HTML 로 해석하지 않음)
  if (rtl) div.dir = 'rtl';
  return div;
}

function renderCaption(c: CaptionData): HTMLElement {
  const lang = chosen();
  const rtl = languages.find((l) => l.code === lang)?.rtl ?? false;
  const box = document.createElement('article');
  box.className = `cap ${c.speaker}${c.final === false ? ' partial' : ''}`;
  if (c.speaker === 'teacher') {
    box.append(line('main', c.translations[lang] ?? c.transcript, rtl && Boolean(c.translations[lang])));
    if (showKorean.checked && c.translations[lang]) box.append(line('sub', c.transcript));
  } else {
    box.append(line('who', '🙋'));
    if (c.lang === lang) {
      box.append(line('main', c.transcript, rtl));
      if (showKorean.checked && c.translations.ko) box.append(line('sub', c.translations.ko));
    } else {
      box.append(line('main', c.translations.ko ?? c.transcript));
      box.append(line('sub', c.transcript));
    }
  }
  return box;
}

function renderAll(): void {
  captions.sort((a, b) => a.seq - b.seq);
  list.replaceChildren(...captions.map(renderCaption));
  empty.classList.toggle('hidden', captions.length > 0);
  window.scrollTo({ top: document.body.scrollHeight });
}

/** 새 자막은 말한 순서대로 끼워 넣고, 같은 id(받는 중 → 확정)는 그 자리에서 바꾼다 */
function addCaption(c: CaptionData): void {
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  const index = captions.findIndex((x) => x.id === c.id);
  if (index >= 0) {
    captions[index] = c;
    const node = list.children[index];
    if (node) node.replaceWith(renderCaption(c));
    else renderAll();
  } else {
    captions.push(c);
    captions.sort((a, b) => a.seq - b.seq);
    while (captions.length > MAX_SHOWN) captions.shift();
    renderAll();
  }
  empty.classList.add('hidden');
  if (nearBottom) window.scrollTo({ top: document.body.scrollHeight, behavior: index >= 0 ? 'auto' : 'smooth' });
}

select.addEventListener('change', () => { save('language', select.value); renderAll(); });
showKorean.addEventListener('change', () => { save('showKorean', showKorean.checked ? '1' : '0'); renderAll(); });
$('smaller').addEventListener('click', () => resize(-4));
$('bigger').addEventListener('click', () => resize(4));

function resize(delta: number): void {
  fontSize = Math.max(16, Math.min(72, fontSize + delta));
  document.documentElement.style.setProperty('--size', `${fontSize}px`);
  save('fontSize', String(fontSize));
}

const events = new EventSource('events');
events.addEventListener('open', () => {
  conn.classList.add('ok');
  connText.textContent = '연결됨';
});
events.addEventListener('error', () => {
  conn.classList.remove('ok');
  connText.textContent = '다시 연결 중…';
});
events.addEventListener('config', (e) => {
  languages = (JSON.parse((e as MessageEvent<string>).data) as { languages: StudentLanguage[] }).languages;
  renderLanguages();
  renderAll();
});
events.addEventListener('caption', (e) => addCaption(JSON.parse((e as MessageEvent<string>).data) as CaptionData));
