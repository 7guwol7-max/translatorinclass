import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pipeline, type PipelineDeps } from '../src/main/pipeline';
import { QuotaTracker, nextPacificMidnight, pacificDay, type QuotaState } from '../src/main/quota';
import { ProviderError, classifyGeminiError } from '../src/main/providers/errors';
import type { Caption, Settings, StatusMessage } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import type { SegmentResult } from '../src/shared/prompts';

const second = (n: number) => new Float32Array(16000 * n);

function memoryStore() {
  let saved: QuotaState | null = null;
  return { load: () => saved, save: (s: QuotaState) => { saved = JSON.parse(JSON.stringify(s)); }, peek: () => saved };
}

function setup(overrides: Partial<Settings> = {}, transcribe?: PipelineDeps['transcribe']) {
  const settings: Settings = { ...DEFAULT_SETTINGS, requestsPerMinute: 60, dailyRequestLimit: 100, ...overrides };
  const quota = new QuotaTracker(memoryStore(), () => ({ daily: settings.dailyRequestLimit, perMinute: settings.requestsPerMinute }));
  const captions: Caption[] = [];
  const statuses: StatusMessage[] = [];
  const fatal: string[] = [];
  const calls: { model: string; prompt: string; wavBytes: number }[] = [];
  const defaultTranscribe: PipelineDeps['transcribe'] = async (model, wav, prompt) => {
    calls.push({ model, prompt, wavBytes: wav.length });
    return { lang: 'ko', transcript: `문장 ${calls.length}`, translations: { vi: `câu ${calls.length}`, zh: `句子 ${calls.length}`, en: 'extra' } };
  };
  const pipeline = new Pipeline({
    getSettings: () => settings,
    transcribe: transcribe ?? defaultTranscribe,
    getTranslator: () => null,
    quota,
    onCaption: (c) => captions.push(c),
    onStatus: (m) => statuses.push(m),
    onQuota: () => undefined,
    onFatal: (m) => fatal.push(m),
  });
  return { pipeline, settings, quota, captions, statuses, fatal, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T01:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('Pipeline', () => {
  it('구간 하나를 받아쓰고 학생 언어로만 번역한 자막을 낸다', async () => {
    const { pipeline, captions, calls } = setup();
    pipeline.enqueue('teacher', second(3));
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('teacher speaking Korean');
    expect(captions).toHaveLength(1);
    expect(captions[0]).toMatchObject({ speaker: 'teacher', lang: 'ko', transcript: '문장 1', translations: { vi: 'câu 1', zh: '句子 1' }, final: true, seq: 0 });
    expect(captions[0].translations.en).toBeUndefined();
  });

  it('요청 2개를 동시에 보내 앞 요청이 끝나길 기다리지 않는다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started: number[] = [];
    const { pipeline, captions } = setup({}, async () => {
      started.push(Date.now());
      if (started.length === 1) await gate; // 첫 요청이 오래 걸려도
      return { lang: 'ko', transcript: `t${started.length}`, translations: {} };
    });
    pipeline.enqueue('teacher', second(2));
    await vi.advanceTimersByTimeAsync(0);
    pipeline.enqueue('teacher', second(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(2); // 두 번째는 바로 출발
    expect(captions.filter((c) => c.final).map((c) => c.seq)).toEqual([1]); // 뒤 문장이 먼저 끝날 수 있어 seq 로 정렬
    release();
    await vi.runAllTimersAsync();
    expect(captions.filter((c) => c.final).map((c) => c.seq).sort()).toEqual([0, 1]);
  });

  it('두 요청이 다 바쁜 동안 쌓인 같은 채널 구간은 한 요청으로 합친다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls: number[] = [];
    const { pipeline } = setup({}, async (_m, wav) => {
      calls.push(wav.length);
      if (calls.length <= 2) await gate;
      return { lang: 'ko', transcript: 'x', translations: {} };
    });
    pipeline.enqueue('teacher', second(3));
    pipeline.enqueue('teacher', second(3));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i++) pipeline.enqueue('teacher', second(3));
    release();
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(3); // 6개 구간 → 요청 3번
    expect(calls[2]).toBeGreaterThan(calls[0] * 3.5);
  });

  it('받는 중인 받아쓰기·번역을 먼저 보내고 마지막에 확정본을 보낸다', async () => {
    const { pipeline, captions } = setup({}, async (_m, _w, _p, onPartial) => {
      onPartial?.({ lang: 'ko', transcript: '오늘은', translations: {} });
      onPartial?.({ lang: 'ko', transcript: '오늘은 광', translations: {} }); // 120ms 안에 또 오면 건너뜀
      vi.setSystemTime(Date.now() + 200);
      onPartial?.({ lang: 'ko', transcript: '오늘은 광합성을 배워요', translations: { vi: 'Hôm nay' } });
      vi.setSystemTime(Date.now() + 200);
      return { lang: 'ko', transcript: '오늘은 광합성을 배워요', translations: { vi: 'Hôm nay học quang hợp', zh: '今天学习光合作用' } };
    });
    pipeline.enqueue('teacher', second(2));
    await vi.runAllTimersAsync();
    expect(captions.map((c) => [c.final, c.transcript])).toEqual([
      [false, '오늘은'],
      [false, '오늘은 광합성을 배워요'],
      [true, '오늘은 광합성을 배워요'],
    ]);
    expect(new Set(captions.map((c) => c.id)).size).toBe(1); // 같은 자막을 고쳐 쓴다
    expect(captions[2].translations).toEqual({ vi: 'Hôm nay học quang hợp', zh: '今天学习光合作用' });
  });

  it('다른 채널은 합치지 않고 말한 순서를 지킨다', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { pipeline } = setup({}, async (_m, _w, prompt) => {
      order.push(prompt.includes('This clip is a student') ? 'student' : 'teacher');
      if (order.length === 1) await gate;
      return { lang: 'vi', transcript: 'y', translations: {} };
    });
    pipeline.enqueue('teacher', second(2));
    await vi.advanceTimersByTimeAsync(0);
    pipeline.enqueue('student', second(2));
    pipeline.enqueue('teacher', second(2));
    release();
    await vi.runAllTimersAsync();
    expect(order).toEqual(['teacher', 'student', 'teacher']);
  });

  it('분당 한도 안에서는 기다리지 않고, 넘으면 60초 창이 빌 때까지 기다린다', async () => {
    const times: number[] = [];
    const { pipeline } = setup({ requestsPerMinute: 2 }, async () => {
      times.push(Date.now());
      return { lang: 'ko', transcript: 'z', translations: {} };
    });
    const t0 = Date.now();
    for (const ch of ['teacher', 'student', 'teacher'] as const) {
      pipeline.enqueue(ch, second(1));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.runAllTimersAsync();
    expect(times).toHaveLength(3);
    expect(times[1] - t0).toBeLessThan(100); // 두 번째도 바로
    expect(times[2] - t0).toBeGreaterThanOrEqual(60_000); // 세 번째는 첫 요청 60초 뒤
  });

  it('429 를 받으면 안내된 시간만큼 기다렸다가 같은 구간을 다시 보낸다', async () => {
    let n = 0;
    const times: number[] = [];
    const { pipeline, captions, statuses, quota } = setup({}, async () => {
      times.push(Date.now());
      if (n++ === 0) throw new ProviderError('rate_limit', 'busy', 20_000);
      return { lang: 'ko', transcript: 'ok', translations: {} };
    });
    pipeline.enqueue('teacher', second(2));
    await vi.runAllTimersAsync();
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(20_000);
    expect(captions).toHaveLength(1);
    expect(statuses.some((s) => s.text.includes('20초'))).toBe(true);
    expect(quota.used(DEFAULT_SETTINGS.geminiModel)).toBe(1); // 429 는 사용량에 안 잡힘
  });

  it('일일 한도를 다 쓰면 대체 모델로 넘어간다', async () => {
    const models: string[] = [];
    const { pipeline, captions } = setup({ geminiFallbackModel: 'gemini-backup' }, async (model) => {
      models.push(model);
      if (model === DEFAULT_SETTINGS.geminiModel) throw new ProviderError('daily_quota', 'done');
      return { lang: 'ko', transcript: 'ok', translations: {} };
    });
    pipeline.enqueue('teacher', second(2));
    await vi.runAllTimersAsync();
    expect(models).toEqual([DEFAULT_SETTINGS.geminiModel, 'gemini-backup']);
    expect(captions).toHaveLength(1);
  });

  it('설정한 일일 한도에 닿으면 더 보내지 않고 알린다', async () => {
    const { pipeline, calls, statuses } = setup({ dailyRequestLimit: 2 });
    for (let i = 0; i < 4; i++) {
      pipeline.enqueue(i % 2 ? 'student' : 'teacher', second(1));
      await vi.runAllTimersAsync();
    }
    expect(calls).toHaveLength(2);
    expect(statuses.some((s) => s.level === 'error' && s.text.includes('한도'))).toBe(true);
    expect(pipeline.quotaStatus().pressure).toBe('exhausted');
  });

  it('키 오류는 대기열을 비우고 치명적 오류로 알린다', async () => {
    const { pipeline, fatal } = setup({}, async () => { throw new ProviderError('auth', '키가 올바르지 않습니다'); });
    pipeline.enqueue('teacher', second(1));
    pipeline.enqueue('teacher', second(1));
    await vi.runAllTimersAsync();
    expect(fatal).toHaveLength(1);
    expect(pipeline.quotaStatus().queued).toBe(0);
    expect(pipeline.quotaStatus().used).toBe(0); // 잘못된 키 요청은 사용량에 안 잡힘
  });

  it('네트워크 오류는 한 번 다시 시도한다', async () => {
    let n = 0;
    const { pipeline, captions } = setup({}, async () => {
      if (n++ === 0) throw new ProviderError('network', 'offline');
      return { lang: 'ko', transcript: 'back', translations: {} };
    });
    pipeline.enqueue('teacher', second(1));
    await vi.runAllTimersAsync();
    expect(n).toBe(2);
    expect(captions[0].transcript).toBe('back');
  });

  it('말소리가 없으면 자막을 내지 않지만 사용량에는 잡힌다', async () => {
    const { pipeline, captions, quota } = setup({}, async () => ({ lang: '', transcript: '', translations: {} }));
    pipeline.enqueue('teacher', second(1));
    await vi.runAllTimersAsync();
    expect(captions).toHaveLength(0);
    expect(quota.used(DEFAULT_SETTINGS.geminiModel)).toBe(1);
  });

  it('자동 채널에서 외국어면 학생 자막(→한국어)으로 낸다', async () => {
    const { pipeline, captions } = setup({}, async () => ({ lang: 'vi', transcript: 'Em không hiểu', translations: { ko: '이해가 안 돼요' } }));
    pipeline.enqueue('auto', second(2));
    await vi.runAllTimersAsync();
    expect(captions[0]).toMatchObject({ speaker: 'student', lang: 'vi', translations: { ko: '이해가 안 돼요' } });
  });

  it('끊긴 교사 문장은 다음 구간이 이어받아 문장 전체 번역으로 같은 자막을 바꾼다', async () => {
    const prompts: string[] = [];
    const replies: SegmentResult[] = [
      { lang: 'ko', transcript: '오늘은 식물이', translations: { vi: 'Hôm nay cây' }, complete: false },
      { lang: 'ko', transcript: '햇빛으로 양분을 만들어요.', translations: { vi: 'Hôm nay cây tạo chất dinh dưỡng từ ánh sáng.' }, complete: true },
      { lang: 'ko', transcript: '다음 문장이에요.', translations: { vi: 'Câu tiếp theo.' }, complete: true },
    ];
    const { pipeline, captions } = setup({}, async (_m, _w, prompt) => {
      prompts.push(prompt);
      return replies[prompts.length - 1];
    });
    for (let i = 0; i < 3; i++) {
      pipeline.enqueue('auto', second(2));
      await vi.runAllTimersAsync();
    }
    const finals = captions.filter((c) => c.final);
    expect(prompts[1]).toContain('«오늘은 식물이»');
    expect(prompts[2]).not.toContain('«'); // 앞 문장이 끝났으므로 이어받지 않음
    expect(finals[1].id).toBe(finals[0].id); // 같은 자막 자리
    expect(finals[1].transcript).toBe('오늘은 식물이 햇빛으로 양분을 만들어요.');
    expect(finals[1].translations.vi).toBe('Hôm nay cây tạo chất dinh dưỡng từ ánh sáng.');
    expect(finals[2].id).not.toBe(finals[0].id);
    expect(prompts[2]).toContain('오늘은 식물이 햇빛으로 양분을 만들어요. | vi: Hôm nay cây tạo'); // 문맥엔 합친 문장과 번역
  });

  it('학생이 끼어들거나 오래 쉬면 이어받지 않는다', async () => {
    const prompts: string[] = [];
    const replies: SegmentResult[] = [
      { lang: 'ko', transcript: '그러니까', translations: {}, complete: false },
      { lang: 'vi', transcript: 'Em hỏi ạ', translations: { ko: '질문 있어요' }, complete: true },
      { lang: 'ko', transcript: '좋아요', translations: {}, complete: false },
      { lang: 'ko', transcript: '시작해요', translations: {}, complete: true },
    ];
    const { pipeline } = setup({}, async (_m, _w, prompt) => {
      prompts.push(prompt);
      return replies[prompts.length - 1];
    });
    pipeline.enqueue('auto', second(1));
    await vi.runAllTimersAsync();
    pipeline.enqueue('auto', second(1)); // 학생 → 교사 문장을 이어받지 않는다 (학생 말은 학생 말로)
    await vi.runAllTimersAsync();
    pipeline.enqueue('auto', second(1));
    await vi.runAllTimersAsync();
    vi.setSystemTime(Date.now() + 10_000); // 10초 쉼
    pipeline.enqueue('auto', second(1));
    await vi.runAllTimersAsync();
    expect(prompts[1]).toContain('«그러니까»'); // 보내는 쪽은 이어받을 수 있다고 알려주지만
    expect(prompts[2]).not.toContain('«'); // 학생 말이 오면 끊긴 문장은 버린다
    expect(prompts[3]).not.toContain('«좋아요»'); // 오래 쉬면 새 문장
  });

  it('Claude 번역을 켜면 Gemini 에는 받아쓰기만 요청하고 Claude 결과를 쓴다', async () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, translator: 'claude', requestsPerMinute: 60 };
    const prompts: string[] = [];
    const translateCalls: { model: string; targets: string[] }[] = [];
    const captions: Caption[] = [];
    const pipeline = new Pipeline({
      getSettings: () => settings,
      transcribe: async (_m, _w, prompt): Promise<SegmentResult> => {
        prompts.push(prompt);
        return { lang: 'ko', transcript: '광합성을 배워요', translations: {} };
      },
      getTranslator: () => async (model, input) => {
        translateCalls.push({ model, targets: input.targets });
        return { vi: 'Học quang hợp', zh: '学习光合作用' };
      },
      quota: new QuotaTracker(memoryStore(), () => ({ daily: 100, perMinute: 60 })),
      onCaption: (c) => captions.push(c),
      onStatus: () => undefined,
      onQuota: () => undefined,
      onFatal: () => undefined,
    });
    pipeline.enqueue('teacher', second(2));
    await vi.runAllTimersAsync();
    expect(prompts[0]).toContain('Do not translate');
    expect(translateCalls).toEqual([{ model: 'claude-opus-5-5', targets: ['vi', 'zh'] }]);
    expect(captions.map((c) => c.final)).toEqual([false, true]); // 받아쓰기가 Claude 를 기다리지 않고 먼저
    expect(captions[0].translations).toEqual({});
    expect(captions[1].translations).toEqual({ vi: 'Học quang hợp', zh: '学习光合作用' });
  });
});

describe('QuotaTracker', () => {
  it('태평양 시간 자정에 사용량을 초기화한다', () => {
    const store = memoryStore();
    let now = Date.parse('2026-10-12T06:30:00Z'); // LA 10/11 23:30
    const q = new QuotaTracker(store, () => ({ daily: 10, perMinute: 10 }), () => now);
    q.count('m');
    q.count('m');
    expect(q.used('m')).toBe(2);
    now = Date.parse('2026-10-12T07:30:00Z'); // LA 10/12 00:30
    expect(q.used('m')).toBe(0);
    expect(store.peek()?.day).toBe('2026-10-12');
  });

  it('저장된 오늘 사용량을 이어서 쓴다', () => {
    const store = memoryStore();
    const now = () => Date.parse('2026-10-12T01:00:00Z');
    store.save({ day: pacificDay(now()), used: { m: 8 } });
    const q = new QuotaTracker(store, () => ({ daily: 10, perMinute: 10 }), now);
    expect(q.used('m')).toBe(8);
    expect(q.pressure('m')).toBe('saving');
  });

  it('다음 초기화 시각은 한국 시간 오후 4시(서머타임) 또는 5시', () => {
    const summer = nextPacificMidnight(Date.parse('2026-07-01T03:00:00Z'));
    const winter = nextPacificMidnight(Date.parse('2026-12-01T03:00:00Z'));
    expect(new Date(summer).getUTCHours()).toBe(7); // KST 16시
    expect(new Date(winter).getUTCHours()).toBe(8); // KST 17시
  });
});

describe('classifyGeminiError', () => {
  it('분당 한도와 재시도 시간을 읽는다', () => {
    const e = classifyGeminiError({ status: 429, message: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"41s"}]}}' });
    expect(e.kind).toBe('rate_limit');
    expect(e.retryAfterMs).toBe(41_000);
  });

  it('일일 한도를 구분한다', () => {
    const e = classifyGeminiError({ status: 429, message: 'quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier' });
    expect(e.kind).toBe('daily_quota');
  });

  it('잘못된 키를 구분한다', () => {
    expect(classifyGeminiError({ status: 400, message: 'API key not valid. Please pass a valid API key.' }).kind).toBe('auth');
    expect(classifyGeminiError({ status: 404, message: 'models/x is not found' }).kind).toBe('model_not_found');
    expect(classifyGeminiError(new TypeError('fetch failed')).kind).toBe('network');
  });
});
