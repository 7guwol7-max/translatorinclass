import { describe, expect, it } from 'vitest';
import { parsePartialJson } from '../src/shared/partial-json';
import { parsePartialSegment } from '../src/shared/prompts';
import { FAST_PARAMS, NORMAL_PARAMS, SAVING_PARAMS, paramsFor } from '../src/renderer/audio/segmenter';
import { boundsFor } from '../src/main/overlay-layout';
import { migrateSettings, sanitizeSettings } from '../src/main/settings';
import { DEFAULT_SETTINGS } from '../src/shared/types';

describe('parsePartialJson', () => {
  it('끊긴 문자열·배열·객체를 닫아서 읽는다', () => {
    expect(parsePartialJson('{"lang":"ko","transcript":"오늘은 광합')).toEqual({ lang: 'ko', transcript: '오늘은 광합' });
    expect(parsePartialJson('{"lang":"ko","transcript":"a","translations":[{"lang":"vi","text":"Hôm')).toEqual({
      lang: 'ko', transcript: 'a', translations: [{ lang: 'vi', text: 'Hôm' }],
    });
  });

  it('값이 아직 없는 키는 버린다', () => {
    expect(parsePartialJson('{"lang":"ko","transcript":')).toEqual({ lang: 'ko' });
    expect(parsePartialJson('{"lang":"ko","tran')).toEqual({ lang: 'ko' });
    expect(parsePartialJson('{"lang":"ko","translations":[{"lang":"vi","te')).toEqual({ lang: 'ko', translations: [{ lang: 'vi' }] });
  });

  it('끊긴 이스케이프와 따옴표 안의 쉼표·괄호를 안전하게 처리한다', () => {
    expect(parsePartialJson('{"transcript":"말했다 \\"안녕, {친구}')).toEqual({ transcript: '말했다 "안녕, {친구}' });
    expect(parsePartialJson('{"transcript":"줄\\')).toEqual({ transcript: '줄' });
  });

  it('완성된 JSON 은 그대로', () => {
    expect(parsePartialJson('{"a":[1,2,{"b":"c"}]}')).toEqual({ a: [1, 2, { b: 'c' }] });
    expect(parsePartialJson('')).toBeUndefined();
  });
});

describe('parsePartialSegment', () => {
  it('받는 중인 받아쓰기와 다 받은 번역만 보여준다', () => {
    const r = parsePartialSegment('{"lang":"ko","transcript":"광합성은","translations":[{"lang":"vi","text":"Quang hợp"},{"lang":"zh","te');
    expect(r).toEqual({ lang: 'ko', transcript: '광합성은', translations: { vi: 'Quang hợp' } });
  });

  it('받아쓰기가 아직 없으면 빈 결과', () => {
    expect(parsePartialSegment('{"lang":"k').transcript).toBe('');
  });
});

describe('속도 설정', () => {
  it('빠르게 < 보통 < 절약 순으로 구간이 길다', () => {
    expect(FAST_PARAMS.pauseMs).toBeLessThan(NORMAL_PARAMS.pauseMs);
    expect(FAST_PARAMS.minSegmentSec).toBeLessThan(NORMAL_PARAMS.minSegmentSec);
    expect(NORMAL_PARAMS.maxSegmentSec).toBeLessThan(SAVING_PARAMS.maxSegmentSec);
  });

  it('한도가 빠듯하면 속도 설정과 상관없이 절약', () => {
    expect(paramsFor('fast', 'normal')).toBe(FAST_PARAMS);
    expect(paramsFor('balanced', 'normal')).toBe(NORMAL_PARAMS);
    expect(paramsFor('fast', 'saving')).toBe(SAVING_PARAMS);
    expect(paramsFor('fast', 'exhausted')).toBe(SAVING_PARAMS);
  });
});

describe('자막 창 위치', () => {
  const area = { x: 1920, y: 0, width: 1280, height: 720 }; // 두 번째 화면(프로젝터)

  it('아래 가운데', () => {
    expect(boundsFor(area, 'bottom-center', 90, 280)).toEqual({ x: 1920 + 64, y: 720 - 280 - 16, width: 1152, height: 280 });
  });

  it('위 왼쪽 / 가운데 오른쪽', () => {
    expect(boundsFor(area, 'top-left', 50, 200)).toEqual({ x: 1936, y: 16, width: 640, height: 200 });
    expect(boundsFor(area, 'middle-right', 50, 200)).toEqual({ x: 1920 + 1280 - 640 - 16, y: 260, width: 640, height: 200 });
  });

  it('너비 100% 면 가장자리에 붙이고, 화면보다 크게는 안 된다', () => {
    expect(boundsFor(area, 'bottom-left', 100, 2000)).toEqual({ x: 1920, y: 0, width: 1280, height: 720 });
  });
});

describe('설정', () => {
  it('v0.1.0 의 분당 10회 기본값을 15회로 바꾼다 (직접 바꾼 값은 그대로)', () => {
    expect(migrateSettings({ requestsPerMinute: 10 }).requestsPerMinute).toBe(15);
    expect(migrateSettings({ requestsPerMinute: 8 }).requestsPerMinute).toBe(8);
    expect(migrateSettings({ requestsPerMinute: 10, settingsVersion: 2 }).requestsPerMinute).toBe(10);
  });

  it('새 항목을 검증한다', () => {
    const s = sanitizeSettings({ latencyMode: 'warp' as never, overlayAnchor: 'nowhere' as never, overlayWidthPct: 500, overlayHeight: 10 });
    expect(s.latencyMode).toBe(DEFAULT_SETTINGS.latencyMode);
    expect(s.overlayAnchor).toBe(DEFAULT_SETTINGS.overlayAnchor);
    expect(s.overlayWidthPct).toBe(100);
    expect(s.overlayHeight).toBe(100);
    expect(sanitizeSettings({ overlayAnchor: null }).overlayAnchor).toBeNull();
  });
});
