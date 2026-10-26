import { describe, expect, it } from 'vitest';
import { boundsFor, placeWindow, pointerZone, sameBounds, type DpiConversion } from '../src/main/overlay-layout';
import type { Bounds } from '../src/shared/types';

// Windows 에서 화면마다 배율이 다를 때 Electron(Chromium) 창이 움직이는 방식을 흉내 낸다.
// - 화면 A: 노트북 1920×1080, 배율 150% (DIP 1280×720)
// - 화면 B: 프로젝터 1920×1080, 배율 100%, A 의 오른쪽
// - setBounds(DIP) 는 '지금 창이 있는 화면'의 배율로 실제 픽셀을 계산하고,
//   다른 배율의 화면으로 넘어가면 Windows(WM_DPICHANGED)가 크기를 배율 비율만큼 바꾼다.
interface Disp {
  phys: Bounds;
  dip: Bounds;
  scale: number;
}
const A: Disp = { phys: { x: 0, y: 0, width: 1920, height: 1080 }, dip: { x: 0, y: 0, width: 1280, height: 720 }, scale: 1.5 };
const B: Disp = { phys: { x: 1920, y: 0, width: 1920, height: 1080 }, dip: { x: 1280, y: 0, width: 1920, height: 1080 }, scale: 1 };
const DISPLAYS = [A, B];

function overlapArea(a: Bounds, b: Bounds): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function nearest(r: Bounds, key: 'phys' | 'dip'): Disp {
  const best = DISPLAYS.reduce((m, d) => (overlapArea(r, d[key]) > overlapArea(r, m[key]) ? d : m));
  if (overlapArea(r, best[key]) > 0) return best;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const dist = (d: Disp) => Math.hypot(cx - (d[key].x + d[key].width / 2), cy - (d[key].y + d[key].height / 2));
  return DISPLAYS.reduce((m, d) => (dist(d) < dist(m) ? d : m));
}

const dipToPhys = (d: Disp, r: Bounds): Bounds => ({
  x: d.phys.x + (r.x - d.dip.x) * d.scale,
  y: d.phys.y + (r.y - d.dip.y) * d.scale,
  width: r.width * d.scale,
  height: r.height * d.scale,
});
const physToDip = (d: Disp, r: Bounds): Bounds => ({
  x: d.dip.x + (r.x - d.phys.x) / d.scale,
  y: d.dip.y + (r.y - d.phys.y) / d.scale,
  width: r.width / d.scale,
  height: r.height / d.scale,
});
const round = (b: Bounds): Bounds => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });

class SimWindow {
  phys: Bounds;
  calls = 0;
  constructor(dip: Bounds, on: Disp) {
    this.phys = dipToPhys(on, dip);
  }
  display(): Disp {
    return nearest(this.phys, 'phys');
  }
  setBounds(dip: Bounds): void {
    this.calls++;
    const before = this.display();
    let p = dipToPhys(before, dip);
    const after = nearest(p, 'phys');
    if (after.scale !== before.scale) {
      const k = after.scale / before.scale;
      p = { ...p, width: p.width * k, height: p.height * k };
    }
    this.phys = p;
  }
  getBounds(): Bounds {
    return round(physToDip(this.display(), this.phys));
  }
}

function dpiFor(win: SimWindow): DpiConversion {
  return {
    toPhysical: (dip) => dipToPhys(nearest(dip, 'dip'), dip),
    toWindowDip: (phys) => physToDip(win.display(), phys),
  };
}

const onA = boundsFor(A.dip, 'bottom-center', 90, 280);
const onB = boundsFor(B.dip, 'bottom-center', 90, 280);

describe('배율이 다른 두 번째 화면으로 자막 창 옮기기', () => {
  it('(문제 재현) 한 번에 옮기면 프로젝터 화면 아래로 벗어난다', () => {
    const win = new SimWindow(onA, A);
    win.setBounds(onB);
    const got = win.getBounds();
    expect(win.display()).toBe(B);
    expect(got.y).toBeGreaterThan(B.dip.y + B.dip.height - 50); // 화면 밖 (아래)
    expect(sameBounds(got, onB)).toBe(false);
  });

  it('노트북(150%) → 프로젝터(100%): 목표 자리에 정확히 놓는다', () => {
    const win = new SimWindow(onA, A);
    expect(placeWindow(win, onB, dpiFor(win))).toBe(true);
    expect(win.getBounds()).toEqual(onB);
    expect(win.display()).toBe(B);
  });

  it('프로젝터(100%) → 노트북(150%) 도 정확히', () => {
    const win = new SimWindow(onB, B);
    expect(placeWindow(win, onA, dpiFor(win))).toBe(true);
    expect(win.getBounds()).toEqual(onA);
  });

  it('프로젝터의 위 오른쪽 등 다른 자리도', () => {
    for (const anchor of ['top-left', 'top-right', 'middle-center', 'bottom-right'] as const) {
      const win = new SimWindow(onA, A);
      const target = boundsFor(B.dip, anchor, 60, 200);
      expect(placeWindow(win, target, dpiFor(win))).toBe(true);
      expect(win.getBounds()).toEqual(target);
    }
  });

  it('같은 화면 안에서는 한 번만 옮긴다, 이미 그 자리면 건드리지 않는다', () => {
    const win = new SimWindow(onB, B);
    const target = boundsFor(B.dip, 'top-center', 90, 280);
    placeWindow(win, target, dpiFor(win));
    expect(win.getBounds()).toEqual(target);
    expect(win.calls).toBe(1);
    placeWindow(win, target, dpiFor(win));
    expect(win.calls).toBe(1);
  });

  it('배율 변환이 없는 환경에서도 다시 놓아 맞춘다', () => {
    const win = new SimWindow(onA, A);
    expect(placeWindow(win, onB, null)).toBe(true);
    expect(win.getBounds()).toEqual(onB);
  });

  it('배율 변환이 오류를 내도 다시 놓아 맞춘다', () => {
    const win = new SimWindow(onA, A);
    const broken: DpiConversion = {
      toPhysical: () => {
        throw new Error('not supported');
      },
      toWindowDip: (b) => b,
    };
    expect(placeWindow(win, onB, broken)).toBe(true);
    expect(win.getBounds()).toEqual(onB);
  });

  it('sameBounds 는 1px 차이는 같은 것으로 본다', () => {
    expect(sameBounds({ x: 0, y: 0, width: 100, height: 50 }, { x: 1, y: -1, width: 101, height: 49 })).toBe(true);
    expect(sameBounds({ x: 0, y: 0, width: 100, height: 50 }, { x: 3, y: 0, width: 100, height: 50 })).toBe(false);
  });
});

describe('도구 막대 위에서만 클릭 받기 (커서 자리로 판단)', () => {
  const win = { x: 1376, y: 784, width: 1728, height: 280 }; // 두 번째 화면의 자막 창
  const tools = [
    { x: 1440, y: 8, width: 280, height: 40 }, // 도구 막대 (창 안 좌표)
    { x: 1700, y: 252, width: 22, height: 22 }, // 오른쪽 아래 모서리
  ];

  it('도구 막대 위면 클릭을 받는다', () => {
    expect(pointerZone({ x: 1376 + 1500, y: 784 + 20 }, win, tools)).toEqual({ inside: true, overTool: true });
    expect(pointerZone({ x: 1376 + 1710, y: 784 + 260 }, win, tools)).toEqual({ inside: true, overTool: true });
  });

  it('자막 글자 위는 창 안이지만 클릭은 통과', () => {
    expect(pointerZone({ x: 1376 + 400, y: 784 + 150 }, win, tools)).toEqual({ inside: true, overTool: false });
  });

  it('도구 가장자리는 6px 넉넉히 본다', () => {
    expect(pointerZone({ x: 1376 + 1436, y: 784 + 4 }, win, tools).overTool).toBe(true);
    expect(pointerZone({ x: 1376 + 1430, y: 784 + 20 }, win, tools).overTool).toBe(false);
  });

  it('창 밖이면 어느 쪽도 아니다 (도구 막대 바로 바깥 포함)', () => {
    expect(pointerZone({ x: 1376 + 1500, y: 780 }, win, tools)).toEqual({ inside: false, overTool: false });
    expect(pointerZone({ x: 100, y: 100 }, win, tools)).toEqual({ inside: false, overTool: false });
  });
});
