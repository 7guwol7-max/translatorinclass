import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pipeline, type PipelineDeps } from '../src/main/pipeline';
import { QuotaTracker, type QuotaState } from '../src/main/quota';
import { ModelPool } from '../src/main/model-pool';
import { ProviderError, classifyGeminiError, parseQuotaHint } from '../src/main/providers/errors';
import { rankGeminiCandidates } from '../src/shared/models';
import { migrateSettings } from '../src/main/settings';
import { DEFAULT_SETTINGS, type Caption, type Settings, type StatusMessage } from '../src/shared/types';
import type { SegmentResult } from '../src/shared/prompts';
import { FAST_PARAMS, Segmenter } from '../src/renderer/audio/segmenter';

const second = (n: number) => new Float32Array(16000 * n);

function memoryStore() {
  let saved: QuotaState | null = null;
  return { load: () => saved, save: (s: QuotaState) => { saved = JSON.parse(JSON.stringify(s)); }, peek: () => saved };
}

interface Call {
  model: string;
  signal?: AbortSignal;
}

/** 모델마다 응답 방식을 정하는 가짜 Gemini */
type Behavior = (call: Call, onPartial?: (p: SegmentResult) => void) => Promise<SegmentResult>;

const ok = (text: string): SegmentResult => ({ lang: 'ko', transcript: text, translations: { vi: `vi:${text}` } });
const after = (ms: number, fn: () => SegmentResult | Promise<SegmentResult>, signal?: AbortSignal) =>
  new Promise<SegmentResult>((resolve, reject) => {
    const t = setTimeout(() => Promise.resolve().then(fn).then(resolve, reject), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('aborted', 'aborted'));
    });
  });

function setup(models: string[], behaviors: Record<string, Behavior>, overrides: Partial<Settings> = {}) {
  const settings: Settings = { ...DEFAULT_SETTINGS, requestsPerMinute: 60, dailyRequestLimit: 100, hedgeRequests: true, ...overrides };
  const store = memoryStore();
  const quota = new QuotaTracker(store, () => ({ daily: settings.dailyRequestLimit, perMinute: settings.requestsPerMinute }));
  const pool = new ModelPool(quota, { load: () => null, save: () => undefined });
  pool.setCandidates(models, settings.modelPreference);
  const calls: Call[] = [];
  const captions: Caption[] = [];
  const statuses: StatusMessage[] = [];
  const fatal: string[] = [];
  const transcribe: PipelineDeps['transcribe'] = (model, _wav, _prompt, onPartial, signal) => {
    const call = { model, signal };
    calls.push(call);
    return behaviors[model](call, onPartial);
  };
  const pipeline = new Pipeline({
    getSettings: () => settings,
    transcribe,
    getTranslator: () => null,
    quota,
    pool,
    onCaption: (c) => captions.push(c),
    onStatus: (m) => statuses.push(m),
    onQuota: () => undefined,
    onFatal: (m) => fatal.push(m),
  });
  return { pipeline, quota, pool, calls, captions, statuses, fatal, store, settings };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T01:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('ModelPool', () => {
  const quota = () => new QuotaTracker(memoryStore(), () => ({ daily: 100, perMinute: 10 }));

  it('잰 값이 없으면 처음 순서대로, 재면 더 빠른 모델을 고른다', () => {
    const pool = new ModelPool(quota(), { load: () => null, save: () => undefined });
    pool.setCandidates(['a', 'b', 'c'], 'fast');
    expect(pool.pick()).toBe('a');
    pool.recordSuccess('a', 11_000, 12_000);
    pool.recordSuccess('a', 11_000, 12_000);
    pool.recordSuccess('b', 1_200, 1_600);
    expect(pool.pick()).toBe('b');
    expect(pool.pick(new Set(['b']))).toBe('c'); // 잰 적 없는 c(처음 짐작 3.3초)가 느린 a(12초)보다 먼저
  });

  it('오류가 두 번 이어지면 30초 쉬고, 없어진 모델은 빼고, 저장된 속도를 이어 쓴다', () => {
    const pool = new ModelPool(quota(), { load: () => ({ b: { ttftMs: 900, totalMs: 1_000, samples: 5, updatedAt: Date.now() } }), save: () => undefined });
    pool.setCandidates(['a', 'b'], 'fast');
    expect(pool.pick()).toBe('b');
    pool.recordFailure('b');
    expect(pool.pick()).toBe('b');
    pool.recordFailure('b');
    expect(pool.pick()).toBe('a');
    vi.advanceTimersByTime(31_000);
    expect(pool.pick()).toBe('b');
    pool.markGone('b');
    expect(pool.list()).toEqual(['a']);
    expect(pool.info().find((m) => m.id === 'b')?.state).toBe('gone');
  });

  it('없어진 모델은 저장해 두고 다음 실행에서도 빼며, 7일 뒤 다시 써 본다', () => {
    let saved: Record<string, import('../src/main/model-pool').ModelStat> = {};
    const store = { load: () => saved, save: (s: typeof saved) => { saved = JSON.parse(JSON.stringify(s)); } };
    const q = quota();
    const first = new ModelPool(q, store);
    first.setCandidates(['a', 'b'], 'fast');
    first.markGone('a');
    const second = new ModelPool(q, store);
    second.setCandidates(['a', 'b'], 'fast');
    expect(second.list()).toEqual(['b']);
    vi.advanceTimersByTime(8 * 86_400_000);
    const later = new ModelPool(q, store);
    later.setCandidates(['a', 'b'], 'fast');
    expect(later.list()).toEqual(['a', 'b']);
  });

  it('더 자연스러운 번역을 고르면 빠른 Lite 보다 Flash 를 먼저 쓴다', () => {
    const pool = new ModelPool(quota(), { load: () => null, save: () => undefined });
    pool.setCandidates(['gemini-3.6-flash', 'gemini-3.1-flash-lite'], 'quality');
    pool.recordSuccess('gemini-3.1-flash-lite', 1_000, 1_500);
    pool.recordSuccess('gemini-3.1-flash-lite', 1_000, 1_500);
    pool.recordSuccess('gemini-3.6-flash', 1_800, 2_400);
    pool.recordSuccess('gemini-3.6-flash', 1_800, 2_400);
    expect(pool.pick()).toBe('gemini-3.6-flash');
  });

  it('다른 모델로 한 번 더 보내기까지 2.5~5초 사이에서 그 모델의 첫 글자 시간의 2배로 정한다', () => {
    const pool = new ModelPool(quota(), { load: () => null, save: () => undefined });
    pool.setCandidates(['a', 'b', 'c'], 'fast');
    pool.recordSuccess('a', 1_000, 1_400);
    pool.recordSuccess('a', 1_000, 1_400);
    expect(pool.hedgeDelayMs('a')).toBe(2_500);
    pool.recordSuccess('c', 2_000, 2_400);
    pool.recordSuccess('c', 2_000, 2_400);
    expect(pool.hedgeDelayMs('c')).toBe(4_000);
    pool.recordSuccess('b', 9_000, 9_500);
    pool.recordSuccess('b', 9_000, 9_500);
    expect(pool.hedgeDelayMs('b')).toBe(5_000);
  });
});

describe('Pipeline + 모델 묶음', () => {
  it('첫 글자가 늦으면 다른 모델로 한 번 더 보내 먼저 온 답을 쓰고, 늦은 요청은 끊는다', async () => {
    const { pipeline, calls, captions, pool, quota } = setup(['slow', 'fast'], {
      slow: (c) => after(12_000, () => ok('느린 답'), c.signal),
      fast: (_c, onPartial) => after(1_000, () => { onPartial?.(ok('빠른')); return ok('빠른 답'); }),
    });
    pipeline.enqueue('teacher', second(3));
    await vi.advanceTimersByTimeAsync(7_000);
    expect(calls.map((c) => c.model)).toEqual(['slow', 'fast']);
    expect(captions.filter((c) => c.final).map((c) => c.transcript)).toEqual(['빠른 답']);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(quota.used('slow') + quota.used('fast')).toBe(2); // 끊은 요청도 사용량에 넣는다
    expect(pool.pick()).toBe('fast'); // 다음부터는 빠른 모델 먼저
    await vi.runAllTimersAsync();
    expect(captions.filter((c) => c.final)).toHaveLength(1);
  });

  it('한 번 더 보내기는 최근 요청의 25%까지만 한다', async () => {
    const { pipeline, calls } = setup(['slow', 'fast'], {
      slow: (c) => after(9_000, () => ok('늦음'), c.signal),
      fast: (c) => after(9_000, () => ok('이쪽도 늦음'), c.signal),
    }, { requestsPerMinute: 1000 });
    for (let i = 0; i < 20; i++) {
      pipeline.enqueue('teacher', second(1));
      await vi.advanceTimersByTimeAsync(20_000);
    }
    const hedges = calls.length - 20;
    expect(hedges).toBeGreaterThan(0);
    expect(hedges).toBeLessThanOrEqual(5);
  });

  it('첫 글자가 제때 오면 한 번 더 보내지 않는다', async () => {
    const { pipeline, calls, captions } = setup(['a', 'b'], {
      a: (_c, onPartial) => after(800, () => { onPartial?.(ok('부분')); return after(3_000, () => ok('다 받음')); }),
      b: () => after(500, () => ok('b')),
    });
    pipeline.enqueue('teacher', second(3));
    await vi.runAllTimersAsync();
    expect(calls.map((c) => c.model)).toEqual(['a']);
    expect(captions.at(-1)?.transcript).toBe('다 받음');
  });

  it('무료 한도가 빠듯하거나 설정에서 끄면 한 번 더 보내지 않는다', async () => {
    const slow: Behavior = (c) => after(6_000, () => ok('a'), c.signal);
    const off = setup(['a', 'b'], { a: slow, b: () => after(100, () => ok('b')) }, { hedgeRequests: false });
    off.pipeline.enqueue('teacher', second(3));
    await vi.runAllTimersAsync();
    expect(off.calls.map((c) => c.model)).toEqual(['a']);

    const tight = setup(['a', 'b'], { a: slow, b: () => after(100, () => ok('b')) }, { dailyRequestLimit: 10 });
    for (let i = 0; i < 9; i++) { tight.quota.count('a'); tight.quota.count('b'); }
    tight.pipeline.enqueue('teacher', second(3));
    await vi.runAllTimersAsync();
    expect(tight.calls.map((c) => c.model)).toEqual(['a']);
  });

  it('연결·서버 오류는 기다리지 않고 다른 모델로 바로 넘긴다', async () => {
    const { pipeline, calls, captions, statuses } = setup(['a', 'b'], {
      a: () => after(300, () => { throw new ProviderError('server', '503'); }),
      b: () => after(500, () => ok('b 가 받음')),
    });
    pipeline.enqueue('teacher', second(3));
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.map((c) => c.model)).toEqual(['a', 'b']);
    expect(captions.at(-1)).toMatchObject({ transcript: 'b 가 받음', final: true });
    expect(statuses.filter((s) => s.level === 'error')).toHaveLength(0);
  });

  it('분당 한도(429)에 걸린 모델은 쉬게 하고 다른 모델로 바로 보내며, 알려준 한도 값을 배운다', async () => {
    let first = true;
    const { pipeline, calls, captions, quota } = setup(['a', 'b'], {
      a: () => {
        if (first) { first = false; return Promise.reject(new ProviderError('rate_limit', '429', 40_000, { scope: 'perMinute', limit: 15 })); }
        return Promise.resolve(ok('a'));
      },
      b: () => Promise.resolve(ok('b 가 받음')),
    });
    pipeline.enqueue('teacher', second(3));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.map((c) => c.model)).toEqual(['a', 'b']);
    expect(captions.at(-1)?.transcript).toBe('b 가 받음');
    expect(quota.limits('a').perMinute).toBe(15);
    expect(quota.waitUntil('a')).not.toBeNull();
  });

  it('일일 한도(429)는 그 모델만 오늘 끝으로 보고, 알려준 하루 한도를 저장한다', async () => {
    const { pipeline, calls, quota, store, statuses } = setup(['a', 'b'], {
      a: () => Promise.reject(new ProviderError('daily_quota', '429', undefined, { scope: 'daily', limit: 20 })),
      b: () => Promise.resolve(ok('b')),
    });
    pipeline.enqueue('teacher', second(3));
    await vi.runAllTimersAsync();
    expect(calls.map((c) => c.model)).toEqual(['a', 'b']);
    expect(quota.isExhausted('a')).toBe(true);
    expect(store.peek()?.limits?.a?.daily).toBe(20);
    expect(statuses.some((s) => s.text.includes('a 의 오늘 무료 한도를 다 써서 b 로'))).toBe(true);
  });

  it('없어진 모델(404)은 빼고 다른 모델로 이어가며, 하나도 안 남을 때만 멈춘다', async () => {
    const gone: Behavior = () => Promise.reject(new ProviderError('model_not_found', '404'));
    const two = setup(['a', 'b'], { a: gone, b: () => Promise.resolve(ok('b')) });
    two.pipeline.enqueue('teacher', second(3));
    await vi.runAllTimersAsync();
    expect(two.captions.at(-1)?.transcript).toBe('b');
    expect(two.fatal).toEqual([]);
    expect(two.pool.list()).toEqual(['b']);

    const one = setup(['a'], { a: gone });
    one.pipeline.enqueue('teacher', second(3));
    await vi.runAllTimersAsync();
    expect(one.fatal).toHaveLength(1);
  });

  it('첫 글자가 10초 안에 안 오면 그 요청을 끊고 다른 모델로 넘긴다 (한 번 더 보내기를 꺼도)', async () => {
    const { pipeline, calls, captions } = setup(['stuck', 'b'], {
      stuck: (c) => after(60_000, () => ok('너무 늦은 답'), c.signal),
      b: () => after(800, () => ok('b 가 받음')),
    }, { hedgeRequests: false });
    pipeline.enqueue('teacher', second(3));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(calls.map((c) => c.model)).toEqual(['stuck', 'b']);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(captions.at(-1)).toMatchObject({ transcript: 'b 가 받음', final: true });
  });

  it('자동 채널에서 외국어 문장을 ko 로 잘못 붙이면 학생 말로 한 번 더 물어 한국어 번역을 받는다', async () => {
    const prompts: string[] = [];
    const settings: Settings = { ...DEFAULT_SETTINGS, requestsPerMinute: 60, dailyRequestLimit: 100, hedgeRequests: false };
    const quota = new QuotaTracker(memoryStore(), () => ({ daily: 100, perMinute: 60 }));
    const pool = new ModelPool(quota, { load: () => null, save: () => undefined });
    pool.setCandidates(['a'], 'fast');
    const captions: Caption[] = [];
    const pipeline = new Pipeline({
      getSettings: () => settings,
      transcribe: async (_m, _w, prompt): Promise<SegmentResult> => {
        prompts.push(prompt);
        return prompts.length === 1
          ? { lang: 'ko', transcript: 'Thưa cô, em chưa hiểu phần này ạ.', translations: { vi: 'Thưa cô, em chưa hiểu phần này ạ.' } }
          : { lang: 'vi', transcript: 'Thưa cô, em chưa hiểu phần này ạ.', translations: { ko: '선생님, 이 부분을 아직 이해 못 했어요.' } };
      },
      getTranslator: () => null,
      quota,
      pool,
      onCaption: (c) => captions.push(c),
      onStatus: () => undefined,
      onQuota: () => undefined,
      onFatal: () => undefined,
    });
    pipeline.enqueue('auto', second(3));
    await vi.runAllTimersAsync();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('student');
    expect(captions.at(-1)).toMatchObject({ speaker: 'student', lang: 'vi', translations: { ko: '선생님, 이 부분을 아직 이해 못 했어요.' } });
  });

  it('남은 사용량은 묶음 전체로, 남은 수업 시간은 분당 요청 수로 짐작한다', async () => {
    const { pipeline, quota } = setup(['a', 'b'], { a: () => Promise.resolve(ok('a')), b: () => Promise.resolve(ok('b')) }, { dailyRequestLimit: 120 });
    for (let i = 0; i < 20; i++) quota.count('a');
    const q = pipeline.quotaStatus();
    expect(q).toMatchObject({ used: 20, limit: 240, remaining: 220, pressure: 'normal' });
    expect(q.minutesLeft).toBe(Math.floor(220 / 12)); // 빠르게: 분당 약 12회
    expect(q.models.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('자막 지연은 구간이 들어온 때(말이 끝난 직후)부터 잰다', async () => {
    const { pipeline, captions } = setup(['a'], { a: () => after(1_500, () => ok('x')) });
    pipeline.enqueue('teacher', second(2));
    await vi.runAllTimersAsync();
    expect(captions.at(-1)?.latencyMs).toBe(1_500);
    expect(pipeline.quotaStatus().recentLatencyMs).toBe(1_500);
  });
});

describe('429 한도 정보·후보 모델·설정 옮기기', () => {
  it('quotaId·quotaValue 에서 어떤 한도인지와 값을 읽는다', () => {
    const body = '{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"1000"}]},{"retryDelay":"20s"}]}}';
    expect(parseQuotaHint(body)).toEqual({ scope: 'daily', limit: 1000 });
    const e = classifyGeminiError({ status: 429, message: body });
    expect(e.kind).toBe('daily_quota');
    expect(e.quota?.limit).toBe(1000);
    expect(classifyGeminiError({ status: 429, message: '"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "quotaValue": "15"' }).quota).toEqual({ scope: 'perMinute', limit: 15 });
    expect(parseQuotaHint('"quotaId":"GenerateContentInputTokensPerModelPerMinute-FreeTier"')?.scope).toBe('tokens');
  });

  it('끊긴 스트림·502·없어진 모델을 알맞게 나눈다', () => {
    expect(classifyGeminiError(new Error('Incomplete JSON segment at the end')).kind).toBe('server');
    expect(classifyGeminiError({ message: '{"error":{"message":"upstream request failed","code":502}}' }).kind).toBe('server');
    expect(classifyGeminiError({ message: 'This model models/gemini-2.5-flash-lite is no longer available to new users.' }).kind).toBe('model_not_found');
  });

  it('후보: 오디오를 받는 Flash 계열만, 선호에 따라 Lite 또는 Flash 먼저', () => {
    const names = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3.5-flash', 'gemini-3-flash-preview',
      'gemini-flash-lite-latest', 'gemini-3.8-flash-tts', 'gemini-3.8-live', 'gemini-3.5-transcribe', 'gemini-2.0-flash', 'gemini-3.1-pro-preview'];
    expect(rankGeminiCandidates(names, 'fast')).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3.5-flash', 'gemini-3-flash-preview']);
    expect(rankGeminiCandidates(names, 'quality').slice(0, 2)).toEqual(['gemini-3.5-flash', 'gemini-3-flash-preview']);
  });

  it('v0.4 설정을 옮기면 자동 모델 묶음을 켜고, 예전에 고른 Flash 는 "자연스러운 번역" 선호로 옮긴다', () => {
    expect(migrateSettings({ settingsVersion: 2, geminiModel: 'gemini-3.5-flash' })).toMatchObject({ geminiModelMode: 'auto', modelPreference: 'quality', onboarded: true, settingsVersion: 3 });
    expect(migrateSettings({ settingsVersion: 2, geminiModel: 'gemini-3.5-flash-lite' })).toMatchObject({ modelPreference: 'fast', onboarded: true });
    expect(migrateSettings({})).toMatchObject({ settingsVersion: 3 });
    expect(migrateSettings({}).onboarded).toBeUndefined(); // 처음 설치는 처음 설정 화면을 보여준다
  });
});

describe('Segmenter 빠르게', () => {
  /** 음절처럼 크기가 오르내리는 소리 */
  function speech(sec: number): Float32Array {
    const out = new Float32Array(Math.round(16000 * sec));
    for (let i = 0; i < out.length; i++) out[i] = Math.sin(i / 8) * (0.2 + 0.15 * Math.sin(i / 1600));
    return out;
  }

  it('쉬지 않고 말해도 5초 안에 보내고, 끝에 가까우면 짧은 숨 쉼(0.15초)에서 자른다', () => {
    const lens: number[] = [];
    const seg = new Segmenter(FAST_PARAMS, (pcm) => lens.push(pcm.length / 16000));
    seg.push(new Float32Array(16000)); // 소음 측정
    seg.push(speech(4)); // 4초 말하고
    seg.push(new Float32Array(16000 * 0.15)); // 짧게 숨 쉬고
    seg.push(speech(3));
    seg.flush();
    expect(lens[0]).toBeGreaterThan(4);
    expect(lens[0]).toBeLessThan(4.7); // 최대 5초 전에 숨 쉼에서 잘림
    expect(lens.every((l) => l <= 5.4)).toBe(true);
  });
});
