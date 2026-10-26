// 자막 창 위치 계산 (순수 함수 — 테스트 대상)
import type { Bounds, OverlayAnchor } from '../shared/types';

/** 위치 버튼(3×3)·너비(%)·높이로 자막 창 위치 계산 */
export function boundsFor(area: Bounds, anchor: OverlayAnchor, widthPct: number, heightPx: number): Bounds {
  const width = Math.round((area.width * Math.min(100, Math.max(30, widthPct))) / 100);
  const height = Math.min(area.height, Math.max(100, heightPx));
  const margin = width >= area.width ? 0 : 16;
  const [v, h] = anchor.split('-');
  const x = h === 'left' ? area.x + margin : h === 'right' ? area.x + area.width - width - margin : area.x + Math.round((area.width - width) / 2);
  const y = v === 'top' ? area.y + margin : v === 'middle' ? area.y + Math.round((area.height - height) / 2) : area.y + area.height - height - margin;
  return { x, y, width, height };
}

/** 두 위치·크기가 tolerance(px) 안에서 같은지 */
export function sameBounds(a: Bounds, b: Bounds, tolerance = 1): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}

export interface MovableWindow {
  setBounds(bounds: Bounds): void;
  getBounds(): Bounds;
}

/** Windows 배율(DPI) 변환 */
export interface DpiConversion {
  /** DIP → 실제 픽셀 (그 자리 화면의 배율로) */
  toPhysical(dip: Bounds): Bounds;
  /** 실제 픽셀 → '지금 창이 있는 화면' 배율의 DIP */
  toWindowDip(physical: Bounds): Bounds;
}

function roundBounds(b: Bounds): Bounds {
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

/**
 * 창을 target(DIP)에 놓는다. 맞췄으면 true.
 * Windows 는 setBounds 의 DIP 를 '지금 창이 있는 화면'의 배율로 바꾼다. 그래서 배율이 다른 화면
 * (예: 노트북 150% → 프로젝터 100%)으로 한 번에 옮기면 화면 밖이나 엉뚱한 곳으로 가고 크기도 배율만큼 바뀐다.
 * 목표의 실제 픽셀 자리를 지금 화면 기준 DIP 로 바꿔 먼저 그 화면으로 옮긴 뒤, 맞을 때까지(최대 3번) 다시 놓는다.
 */
export function placeWindow(win: MovableWindow, target: Bounds, dpi: DpiConversion | null): boolean {
  if (sameBounds(win.getBounds(), target)) return true;
  if (dpi) win.setBounds(roundBounds(dpi.toWindowDip(dpi.toPhysical(target))));
  for (let i = 0; i < 3 && !sameBounds(win.getBounds(), target); i++) win.setBounds(target);
  return sameBounds(win.getBounds(), target);
}
