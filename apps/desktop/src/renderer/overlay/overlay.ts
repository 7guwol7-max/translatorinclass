// 자막 오버레이: 다른 창 위에 떠 있는 투명 창. 최근 자막 2개를 말한 순서대로 보여준다.
// 마우스를 올리면 도구 막대(이동·크기·글자·숨기기)가 나타나고, 그 위에서만 클릭을 받는다.
import type { Caption, Settings } from '../../shared/types';
import { languageInfo } from '../../shared/languages';
import '../global';

const api = window.api;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const stack = $('stack');
const frame = $('frame');

const SHOWN = 2;
/** 이 시간 동안 새 자막이 없으면 자막을 숨겨 화면을 가리지 않는다 */
const FADE_AFTER_MS = 20_000;
const HOVER_HIDE_MS = 1800;

let settings: Settings | null = null;
const captions = new Map<string, Caption>();
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
  const body = document.createElement('span');
  body.textContent = text;
  div.append(body);
  if (rtl) div.dir = 'rtl';
  return div;
}

function renderCaption(c: Caption, old: boolean): HTMLElement {
  const box = document.createElement('div');
  box.className = `cap ${c.speaker}${old ? ' old' : ''}${c.final ? '' : ' partial'}`;
  const s = settings;
  if (!s) return box;
  if (c.speaker === 'teacher') {
    if (s.showKoreanOnOverlay || s.overlayLanguages.length === 0) box.append(line('ko', c.transcript));
    s.overlayLanguages.forEach((code, i) => {
      const text = c.translations[code];
      const info = languageInfo(code);
      if (text) box.append(line(`tr c${i}`, text, info?.native ?? code, info?.rtl));
    });
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
  const recent = [...captions.values()].sort((a, b) => a.seq - b.seq).slice(-SHOWN);
  stack.replaceChildren(...recent.map((c, i) => renderCaption(c, i < recent.length - 1)));
}

function show(c: Caption): void {
  captions.set(c.id, c);
  // 오래된 자막은 지운다
  const keep = new Set([...captions.values()].sort((a, b) => b.seq - a.seq).slice(0, SHOWN + 2).map((x) => x.id));
  for (const id of captions.keys()) if (!keep.has(id)) captions.delete(id);
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

// ── 마우스를 올리면 도구 막대 ──────────────────────────────────
// 창은 평소 클릭을 아래로 통과시키지만(Windows 에서도 마우스 움직임은 전달됨),
// 도구 막대·모서리 위에 있을 때만 클릭을 받도록 바꾼다.

let interactive = false;
let dragging: 'move' | 'resize' | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | undefined;

function setInteractive(on: boolean): void {
  if (on === interactive) return;
  interactive = on;
  api.setOverlayInteractive(on);
}

function showTools(): void {
  frame.classList.add('hover');
  stack.classList.remove('faded');
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (!dragging && !interactive) frame.classList.remove('hover');
  }, HOVER_HIDE_MS);
}

document.addEventListener('mousemove', (e) => {
  showTools();
  if (dragging) return;
  const overTool = (e.target as Element | null)?.closest('.tool') !== null;
  setInteractive(overTool);
});

document.addEventListener('mouseleave', () => {
  if (dragging) return;
  setInteractive(false);
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => frame.classList.remove('hover'), 400);
});

function pointerDrag(handle: HTMLElement, kind: 'move' | 'resize'): void {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId); // 창 밖으로 나가도 손을 뗀 것을 놓치지 않게
    dragging = kind;
    frame.classList.add('dragging');
    api.overlayPointer(kind, 'start');
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    dragging = null;
    frame.classList.remove('dragging');
    api.overlayPointer(kind, 'end');
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  // 배율이 다른 화면으로 넘어가며 마우스 잡기가 풀리면 손을 뗀 것을 못 받을 수 있어 그때도 끝낸다
  handle.addEventListener('lostpointercapture', end);
}

pointerDrag($('dragHandle'), 'move');
pointerDrag($('resizeGrip'), 'resize');
$('fontDown').addEventListener('click', () => api.nudgeOverlayFont(-1));
$('fontUp').addEventListener('click', () => api.nudgeOverlayFont(1));
// ── 듣기 멈춤 / 다시 시작 ──────────────────────────────────────
function renderListening(on: boolean): void {
  frame.classList.toggle('listening', on);
  $('listenLabel').textContent = on ? '멈춤' : '다시 시작';
  $('listenBtn').title = on ? '듣기 멈춤 (Ctrl+Alt+P) — 쉬는 시간이나 개인적인 이야기를 할 때' : '다시 듣기 시작 (Ctrl+Alt+P)';
}
$('listenBtn').addEventListener('click', () => api.requestToggleListening());
api.onListening(renderListening);
void api.getListening().then(renderListening);

$('hide').addEventListener('click', () => {
  setInteractive(false);
  void api.setOverlayVisible(false);
});

api.onSettings(applySettings);
api.onCaption(show);
api.onOverlayMoveMode((on) => {
  frame.classList.toggle('moving', on);
  $('moveHint').classList.toggle('hidden', !on);
  if (on) stack.classList.remove('faded');
});
void api.getSettings().then(applySettings);
