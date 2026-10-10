// 학생 PC 화면: 내 언어를 골라 교사 자막을 실시간으로 본다 (읽기 전용)

interface StudentLanguage { code: string; native: string; ko: string; rtl: boolean }
interface CaptionData {
  id: string;
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
  box.className = `cap ${c.speaker}`;
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
  list.replaceChildren(...captions.map(renderCaption));
  empty.classList.toggle('hidden', captions.length > 0);
  window.scrollTo({ top: document.body.scrollHeight });
}

function addCaption(c: CaptionData): void {
  if (captions.some((x) => x.id === c.id)) return; // 다시 연결될 때 받은 지난 자막은 건너뜀
  captions.push(c);
  while (captions.length > MAX_SHOWN) captions.shift();
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
  list.append(renderCaption(c));
  while (list.children.length > MAX_SHOWN) list.firstElementChild?.remove();
  empty.classList.add('hidden');
  if (nearBottom) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
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
events.addEventListener('open', () => conn.classList.add('ok'));
events.addEventListener('error', () => conn.classList.remove('ok'));
events.addEventListener('config', (e) => {
  languages = (JSON.parse((e as MessageEvent<string>).data) as { languages: StudentLanguage[] }).languages;
  renderLanguages();
  renderAll();
});
events.addEventListener('caption', (e) => addCaption(JSON.parse((e as MessageEvent<string>).data) as CaptionData));
