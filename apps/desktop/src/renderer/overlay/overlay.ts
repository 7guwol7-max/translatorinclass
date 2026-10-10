// 자막 오버레이: 다른 창 위에 떠 있는 투명 창. 최근 자막 2개를 보여준다.
import type { Caption, Settings } from '../../shared/types';
import { languageInfo } from '../../shared/languages';
import '../global';

const api = window.api;
const stack = document.getElementById('stack') as HTMLElement;
const frame = document.getElementById('frame') as HTMLElement;
const moveHint = document.getElementById('moveHint') as HTMLElement;

const SHOWN = 2;
/** 이 시간 동안 새 자막이 없으면 자막을 숨겨 화면을 가리지 않는다 */
const FADE_AFTER_MS = 20_000;

let settings: Settings | null = null;
let recent: Caption[] = [];
let fadeTimer: ReturnType<typeof setTimeout> | undefined;

function line(className: string, text: string, tag?: string, rtl = false): HTMLElement {
  const div = document.createElement('div');
  div.className = `line ${className}`;
  if (tag) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = tag;
    div.append(t);
  }
  div.append(document.createTextNode(text));
  if (rtl) div.dir = 'rtl';
  return div;
}

function renderCaption(c: Caption, old: boolean): HTMLElement {
  const box = document.createElement('div');
  box.className = `cap ${c.speaker}${old ? ' old' : ''}`;
  const s = settings;
  if (!s) return box;
  if (c.speaker === 'teacher') {
    if (s.showKoreanOnOverlay || s.overlayLanguages.length === 0) box.append(line('ko', c.transcript));
    for (const code of s.overlayLanguages) {
      const text = c.translations[code];
      const info = languageInfo(code);
      if (text) box.append(line('tr', text, info?.native ?? code, info?.rtl));
    }
  } else {
    const info = languageInfo(c.lang);
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = `🙋 학생 · ${info?.ko ?? c.lang}`;
    box.append(who, line('ko', c.translations.ko ?? c.transcript));
    if (c.translations.ko) box.append(line('orig', c.transcript, undefined, info?.rtl));
  }
  return box;
}

function render(): void {
  stack.replaceChildren(...recent.map((c, i) => renderCaption(c, i < recent.length - 1)));
}

function show(c: Caption): void {
  recent = [...recent, c].slice(-SHOWN);
  render();
  stack.classList.remove('faded');
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => stack.classList.add('faded'), FADE_AFTER_MS);
}

function applySettings(next: Settings): void {
  settings = next;
  document.documentElement.style.setProperty('--size', `${next.overlayFontSize}px`);
  render();
}

api.onSettings(applySettings);
api.onCaption(show);
api.onOverlayMoveMode((on) => {
  frame.classList.toggle('moving', on);
  moveHint.classList.toggle('hidden', !on);
  if (on) stack.classList.remove('faded');
});
void api.getSettings().then(applySettings);
