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
