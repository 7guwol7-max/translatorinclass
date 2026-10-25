// 발화 구간 대기열 → Gemini(받아쓰기·번역) → (선택) Claude 번역 → 자막.
// - 요청을 최대 2개까지 동시에 보내고, 응답은 스트리밍으로 받아 받아쓰기부터 바로 보여준다.
// - 모델 묶음(ModelPool)에서 지금 가장 빠른 모델로 보내고, 첫 글자가 늦으면 다른 모델로 한 번 더 보내
//   먼저 온 답을 쓴다 (무료 등급은 같은 모델도 요청마다 1~13초까지 들쭉날쭉함).
// - 한 모델이 분당/일일 한도에 걸리거나 오류가 나면 다른 모델로 바로 이어간다.
// - 모든 모델이 바쁜 동안 쌓인 같은 채널 구간은 하나로 합쳐 요청 수를 줄인다.

import type { Caption, Channel, QuotaPressure, QuotaStatus, Settings, StatusMessage } from '../shared/types';
import { buildSegmentPrompt, contextLine, scriptMismatch, speakerFor, translationTargets, type SegmentResult } from '../shared/prompts';
import { concatWithGap, durationSec, encodeWav } from '../shared/wav';
import { ProviderError } from './providers/errors';
import { nextPacificMidnight, type QuotaTracker } from './quota';
import type { ModelPool } from './model-pool';
import type { TranslateInput } from './providers/claude';

/** 한 요청에 합칠 최대 오디오 길이 */
const MAX_BATCH_SEC = 30;
/** 대기열이 이보다 길어지면 오래된 것부터 버린다 (인터넷이 끊긴 경우 등) */
const MAX_QUEUE_SEC = 180;
const CONTEXT_SENTENCES = 3;
/** 동시에 보낼 요청 수 (한 요청이 끝나길 기다리지 않아 지연이 줄어든다) */
const MAX_IN_FLIGHT = 2;
/** 받는 중 자막을 화면에 다시 그리는 최소 간격 */
const PARTIAL_INTERVAL_MS = 120;
/** 끊긴 문장을 이어받을 수 있는 시간 (이보다 오래 쉬면 새 문장으로 본다) */
const CONTINUE_WITHIN_MS = 8_000;
/** 이어 붙일 최대 구간 수 */
const MAX_JOINED_PARTS = 4;
const NOT_COUNTED = new Set(['rate_limit', 'daily_quota', 'auth', 'model_not_found', 'network']);
/** 다른 모델로 바로 넘겨 다시 보낼 오류 */
const FAILOVER = new Set(['network', 'server']);
/** 남은 시간 계산에 쓰는, 말을 계속할 때 분당 요청 수 (잰 값이 없을 때) */
const DEFAULT_RPM_BY_MODE = { fast: 12, balanced: 7, saving: 3 } as const;
/** 최근 자막 지연 평균에 쓰는 개수 */
const LATENCY_WINDOW = 8;
/** 첫 글자가 이 안에 안 오면 그 요청은 포기하고 다른 모델로 넘긴다 (무료 등급은 가끔 30초 넘게 멈춤) */
const FIRST_TOKEN_TIMEOUT_MS = 10_000;
/** 한 구간에 보낼 최대 요청 수 (처음 + 한 번 더 + 오류 시 넘기기) */
const MAX_ATTEMPTS = 3;
/** '한 번 더 보내기'는 최근 3분 동안 보낸 요청의 이 비율까지만 (무료 한도를 너무 빨리 쓰지 않게) */
const HEDGE_BUDGET = 0.25;
const HEDGE_WINDOW_MS = 180_000;

/** 자막 자리 (Live 모드가 먼저 보여준 자막을 기존 방식 결과로 바꿔 쓸 때) */
export interface CaptionSlot {
  id: string;
  seq: number;
  ts: number;
  /** 말이 끝난 시각 (자막 지연 계산 기준) */
  endedAt?: number;
}

export interface PipelineDeps {
  getSettings(): Settings;
  transcribe(
    model: string,
    wav: Uint8Array,
    prompt: string,
    onPartial?: (partial: SegmentResult) => void,
    signal?: AbortSignal,
  ): Promise<SegmentResult>;
  /** Claude 키가 없으면 null */
  getTranslator(): ((model: string, input: TranslateInput) => Promise<Record<string, string>>) | null;
  quota: QuotaTracker;
  pool: ModelPool;
  onCaption(caption: Caption): void;
  onStatus(message: StatusMessage): void;
  onQuota(status: QuotaStatus): void;
  /** 키 오류처럼 계속할 수 없는 문제 */
  onFatal(message: string): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface OpenSentence {
  id: string;
  seq: number;
  ts: number;
  transcript: string;
  translations: Record<string, string>;
  parts: number;
  endedAt: number;
}

interface QueueItem {
  channel: Channel;
  pcm: Float32Array;
  retried: boolean;
  /** 이 모델에서 실패해 다시 보내는 중이면 다른 모델을 먼저 쓴다 */
  avoid?: string;
  /** 구간이 들어온 시각 = 말이 끝난 직후 (자막 지연 계산 기준) */
  enqueuedAt: number;
  slot?: CaptionSlot;
}

export class Pipeline {
  private queue: QueueItem[] = [];
  private inFlight = 0;
  private timer: unknown = null;
  private context: { id: string; line: string }[] = [];
  /** 중간에서 끊긴 마지막 교사 문장 (다음 구간이 이어받음) */
  private open: OpenSentence | null = null;
  private exhaustedNotified = false;
  private waitNotifiedAt = 0;
  private fatalReported = false;
  private seq = 0;
  /** 최근 10분 동안 보낸 (첫) 요청 시각 — 남은 시간 계산용 */
  private requestTimes: number[] = [];
  private latencies: number[] = [];
  /** 최근에 '한 번 더 보내기'를 한 시각 */
  private hedgeTimes: number[] = [];
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: PipelineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  enqueue(channel: Channel, pcm: Float32Array, slot?: CaptionSlot): void {
    if (pcm.length === 0) return;
    this.queue.push({ channel, pcm, retried: false, enqueuedAt: slot?.endedAt ?? this.now(), slot });
    let total = this.queue.reduce((n, q) => n + durationSec(q.pcm), 0);
    let dropped = 0;
    while (total > MAX_QUEUE_SEC && this.queue.length > 1) {
      total -= durationSec(this.queue.shift()!.pcm);
      dropped++;
    }
    if (dropped > 0) this.status('warn', `처리가 밀려 오래된 발화 ${dropped}개를 건너뛰었습니다`);
    this.publishQuota();
    void this.pump();
  }

  /** 수업을 끝낼 때: 남은 대기열을 비운다 */
  clear(): void {
    this.queue = [];
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.publishQuota();
  }

  resetContext(): void {
    this.context = [];
    this.open = null;
    this.fatalReported = false;
  }

  /** 다음 자막 순서 번호 (Live 모드도 같은 번호를 써서 말한 순서대로 보인다) */
  nextSeq(): number {
    return this.seq++;
  }

  /** Live 모드 자막의 지연도 '최근 자막 지연' 평균에 넣는다 */
  noteLatency(ms: number): void {
    this.latencies.push(ms);
    while (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }

  /** 지금 주로 쓰는 모델 (화면 표시용) */
  currentModel(): string | null {
    return this.deps.pool.best();
  }

  /** 말을 계속할 때 분당 요청 수: 수업 중 잰 값, 없으면 속도 설정에 따른 짐작 */
  private requestsPerMinute(): number {
    const now = this.now();
    this.requestTimes = this.requestTimes.filter((t) => t > now - 600_000);
    const s = this.deps.getSettings();
    const guess = DEFAULT_RPM_BY_MODE[s.latencyMode];
    if (this.requestTimes.length < 10) return guess;
    const minutes = Math.max(2, (now - this.requestTimes[0]) / 60_000);
    // 쉬는 시간이 섞여 낮게 나오는 걸 막으려고 짐작값의 절반 아래로는 내리지 않는다
    return Math.max(guess / 2, this.requestTimes.length / minutes);
  }

  quotaStatus(): QuotaStatus {
    const { quota, pool } = this.deps;
    const models = pool.list();
    const used = models.reduce((n, m) => n + quota.used(m), 0);
    const limit = models.reduce((n, m) => n + quota.limits(m).daily, 0);
    const remaining = models.reduce((n, m) => n + quota.remaining(m), 0);
    let pressure: QuotaPressure = quota.pressure(models);
    // 대기열이 밀리면 구간을 길게 묶어 요청 수를 줄인다
    if (pressure === 'normal' && this.queue.length >= 3) pressure = 'saving';
    const anyReady = models.some((m) => pool.isReady(m));
    const latency = this.latencies.length ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) : null;
    return {
      used,
      limit,
      remaining,
      minutesLeft: Math.floor(remaining / this.requestsPerMinute()),
      day: quota.day(),
      resetAt: nextPacificMidnight(this.now()),
      pressure,
      waitUntil: anyReady ? null : pool.nextAvailableAt(),
      queued: this.queue.length,
      model: pool.best() ?? this.deps.getSettings().geminiModel,
      models: pool.info(),
      recentLatencyMs: latency,
    };
  }

  private publishQuota(): void {
    this.deps.onQuota(this.quotaStatus());
  }

  private status(level: StatusMessage['level'], text: string): void {
    this.deps.onStatus({ level, text, ts: this.now() });
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.pump();
    }, Math.max(0, delayMs));
  }

  /** 보낼 수 있는 만큼 요청을 보낸다 (최대 2개 동시) */
  async pump(): Promise<void> {
    const { pool } = this.deps;
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length > 0) {
      if (pool.allExhausted()) {
        if (!this.exhaustedNotified) {
          this.exhaustedNotified = true;
          this.status('error', pool.list().length === 0
            ? '이 키로 쓸 수 있는 Gemini 모델이 없습니다. API 키 화면에서 연결 테스트를 눌러 주세요.'
            : '오늘 무료 요청 한도를 모든 모델에서 다 썼습니다. 한도는 매일 한국 시간 오후 4~5시에 초기화됩니다.');
        }
        this.queue = [];
        this.publishQuota();
        return;
      }
      this.exhaustedNotified = false;

      const avoid = this.queue[0].avoid;
      const model = (avoid ? pool.pick(new Set([avoid])) : null) ?? pool.pick();
      if (!model) {
        const at = pool.nextAvailableAt();
        const wait = at === null ? 1_000 : Math.max(50, at - this.now());
        if (wait > 5_000 && this.now() - this.waitNotifiedAt > 30_000) {
          this.waitNotifiedAt = this.now();
          this.status('warn', `모든 모델이 분당 요청 한도에 걸려 ${Math.ceil(wait / 1000)}초 기다렸다 이어서 처리합니다`);
        }
        this.schedule(wait);
        return;
      }

      const batch = this.takeBatch();
      this.inFlight++;
      this.deps.quota.noteSent(model);
      this.requestTimes.push(this.now());
      this.publishQuota();
      void this.run(model, batch);
    }
  }

  private async run(model: string, batch: QueueItem): Promise<void> {
    const startedAt = batch.enqueuedAt;
    const seq = batch.slot?.seq ?? this.seq++;
    try {
      await this.process(model, batch, startedAt, seq);
    } catch (error) {
      this.handleError(model, batch, error);
    } finally {
      this.inFlight--;
      this.publishQuota();
      if (this.queue.length > 0) void this.pump();
    }
  }

  private async process(model: string, batch: QueueItem, startedAt: number, seq: number): Promise<void> {
    const s = this.deps.getSettings();
    const translator = s.translator === 'claude' ? this.deps.getTranslator() : null;
    const context = this.context.slice(-CONTEXT_SENTENCES).map((c) => c.line);

    // 앞 교사 문장이 중간에서 끊겼으면 이번 요청이 이어받아 문장 전체를 번역한다 (동시 요청이 겹쳐 받지 않게 바로 비운다)
    const open = batch.channel !== 'student' && this.open && this.now() - this.open.endedAt < CONTINUE_WITHIN_MS ? this.open : null;
    this.open = null;

    const prompt = buildSegmentPrompt({
      channel: batch.channel,
      studentLanguages: s.studentLanguages,
      translate: translator === null,
      glossary: s.glossary,
      context,
      continuation: open?.transcript,
    });

    const ownId = batch.slot?.id ?? `${startedAt.toString(36)}-${seq.toString(36)}`;
    const ownTs = batch.slot?.ts ?? startedAt;
    /** 이어받은 경우 앞 자막 자리에 문장 전체를 다시 쓴다 */
    const target = (r: SegmentResult) => (open && speakerFor(batch.channel, r.lang) === 'teacher' ? open : null);
    const emit = (r: SegmentResult, translations: Record<string, string>, final: boolean) => {
      const speaker = speakerFor(batch.channel, r.lang);
      const lang = r.lang || (speaker === 'teacher' ? 'ko' : '');
      const joined = target(r);
      this.deps.onCaption({
        id: joined ? joined.id : ownId,
        seq: joined ? joined.seq : seq,
        ts: joined ? joined.ts : ownTs,
        speaker,
        lang,
        transcript: joined ? `${joined.transcript} ${r.transcript}` : r.transcript,
        translations,
        latencyMs: this.now() - startedAt,
        final,
      });
    };
    const keep = (r: SegmentResult) => {
      const targets = translationTargets(speakerFor(batch.channel, r.lang), r.lang || 'ko', s.studentLanguages);
      const out: Record<string, string> = {};
      for (const t of targets) if (r.translations[t]) out[t] = r.translations[t];
      return out;
    };
    /** 받는 중에는 문장 전체 번역이 앞 번역만큼 나오기 전까지 앞 번역을 그대로 보여준다 (깜빡임 방지) */
    const partialTranslations = (r: SegmentResult) => {
      const fresh = keep(r);
      const joined = target(r);
      if (!joined) return fresh;
      const out: Record<string, string> = { ...joined.translations };
      for (const [l, t] of Object.entries(fresh)) if (t.length >= (out[l]?.length ?? 0) * 0.8) out[l] = t;
      return out;
    };

    // 받는 중: 받아쓰기·번역이 나오는 대로 (너무 자주 그리지 않게) 내보낸다
    let lastPartial: SegmentResult | null = null;
    let lastShownAt = 0;
    let lastShownKey = '';
    const onPartial = (p: SegmentResult) => {
      if (batch.channel === 'auto' && !p.lang) return; // 누가 말했는지 알기 전에는 기다린다
      lastPartial = p;
      const key = p.transcript + JSON.stringify(p.translations);
      const now = this.now();
      if (key === lastShownKey || now - lastShownAt < PARTIAL_INTERVAL_MS) return;
      lastShownAt = now;
      lastShownKey = key;
      emit(p, translator ? (target(p)?.translations ?? {}) : partialTranslations(p), false);
    };

    const wav = encodeWav(batch.pcm);
    let result = await this.race(model, wav, prompt, onPartial);
    if (!result.transcript && lastPartial) result = lastPartial;
    // 언어를 잘못 붙였으면(예: 베트남어 문장을 ko 로) 화자를 정해 한 번 더 물어 필요한 번역을 받는다
    const fix = batch.channel === 'auto' && translator === null ? scriptMismatch(result.lang, result.transcript) : null;
    if (fix) {
      const again = buildSegmentPrompt({ channel: fix, studentLanguages: s.studentLanguages, translate: true, glossary: s.glossary, context, continuation: fix === 'teacher' ? open?.transcript : undefined });
      const model2 = this.deps.pool.pick() ?? model;
      this.deps.quota.noteSent(model2);
      try {
        const r2 = await this.race(model2, wav, again, () => undefined);
        if (r2.transcript) result = { ...r2, lang: r2.lang || (fix === 'teacher' ? 'ko' : result.lang) };
      } catch {
        // 다시 묻기에 실패하면 처음 답을 그대로 쓴다
      }
      if (fix === 'student' && result.lang === 'ko') result = { ...result, lang: '' };
    }
    if (!result.transcript) {
      if (open) this.open = open; // 말소리가 없었으면 다음 구간이 이어받을 수 있게 되돌린다
      return;
    }

    const speaker = speakerFor(batch.channel, result.lang);
    const lang = result.lang || (speaker === 'teacher' ? 'ko' : '');
    const joined = target(result);
    const fullTranscript = joined ? `${joined.transcript} ${result.transcript}` : result.transcript;

    let translations = keep(result);
    if (translator) {
      emit(result, joined?.translations ?? {}, false); // 받아쓰기는 Claude 번역을 기다리지 않고 먼저 보여준다
      try {
        translations = await translator(s.claudeModel, {
          transcript: fullTranscript,
          sourceLang: lang,
          targets: translationTargets(speaker, lang, s.studentLanguages),
          glossary: s.glossary,
          context,
        });
      } catch (error) {
        translations = joined?.translations ?? {};
        const message = error instanceof Error ? error.message : String(error);
        this.status('warn', `Claude 번역 실패 — 원문만 표시합니다 (${message})`);
      }
    }
    emit(result, translations, true);
    this.noteLatency(this.now() - startedAt);

    const id = joined ? joined.id : ownId;
    this.remember(id, contextLine(fullTranscript, translations, s.overlayLanguages.length ? s.overlayLanguages : s.studentLanguages));
    // 교사 문장이 아직 안 끝났으면 다음 구간이 이어받는다 (너무 길어지면 끊는다)
    const parts = (joined?.parts ?? 0) + 1;
    if (speaker === 'teacher' && result.complete === false && parts < MAX_JOINED_PARTS) {
      this.open = { id, seq: joined ? joined.seq : seq, ts: joined ? joined.ts : ownTs, transcript: fullTranscript, translations, parts, endedAt: this.now() };
    }
  }

  /**
   * 한 구간을 받아쓴다. 첫 글자가 늦으면 다른 모델로 한 번 더 보내고(헤징), 연결·서버 오류면 다른 모델로 바로 넘긴다.
   * 먼저 받아쓰기를 보내기 시작한 쪽의 중간 결과만 화면에 내보내고, 먼저 끝난 쪽 답을 쓰며, 나머지는 끊는다.
   */
  private race(primary: string, wav: Uint8Array, prompt: string, onPartial: (p: SegmentResult) => void): Promise<SegmentResult> {
    const { pool, quota } = this.deps;
    const s = this.deps.getSettings();
    interface Attempt {
      model: string;
      ctrl: AbortController;
      startedAt: number;
      firstAt: number;
      done: boolean;
      /** 첫 글자를 기다리다 포기해 끊었는지 */
      timedOut: boolean;
      timer: unknown;
    }
    const attempts: Attempt[] = [];
    let leader: Attempt | null = null;
    let settled = false;
    let hedgeTimer: unknown = null;

    return new Promise<SegmentResult>((resolve, reject) => {
      const tried = () => new Set(attempts.map((a) => a.model));
      const finish = (fn: () => void) => {
        settled = true;
        if (hedgeTimer !== null) this.clearTimer(hedgeTimer);
        for (const a of attempts) {
          if (a.timer !== null) this.clearTimer(a.timer);
          if (!a.done) {
            a.ctrl.abort();
            pool.recordSlow(a.model, this.now() - a.startedAt);
          }
        }
        fn();
      };
      /** 실패(또는 포기)한 뒤: 다른 쪽을 기다리거나, 안 써 본 모델로 넘기거나, 끝낸다 */
      const afterFailure = (err: ProviderError) => {
        if (settled) return;
        if (attempts.some((o) => !o.done)) return; // 다른 쪽 답을 기다린다
        const next = FAILOVER.has(err.kind) && attempts.length < MAX_ATTEMPTS ? pool.pick(tried()) : null;
        if (next) {
          start(next, false);
          return;
        }
        finish(() => reject(err));
      };
      const start = (model: string, counted: boolean) => {
        const a: Attempt = { model, ctrl: new AbortController(), startedAt: this.now(), firstAt: 0, done: false, timedOut: false, timer: null };
        attempts.push(a);
        if (!counted) quota.noteSent(model);
        a.timer = this.setTimer(() => {
          a.timer = null;
          if (settled || a.done || a.firstAt) return;
          // 너무 오래 아무것도 안 오면 끊고 다른 모델로
          a.timedOut = true;
          a.done = true;
          a.ctrl.abort();
          quota.count(model);
          pool.recordFailure(model);
          pool.recordSlow(model, this.now() - a.startedAt);
          if (leader === a) leader = null;
          afterFailure(new ProviderError('server', 'Gemini 응답이 너무 늦습니다'));
        }, FIRST_TOKEN_TIMEOUT_MS);
        this.deps
          .transcribe(model, wav, prompt, (p) => {
            if (settled || a.done) return;
            if (!a.firstAt) a.firstAt = this.now();
            if (!leader) {
              leader = a;
              if (hedgeTimer !== null) this.clearTimer(hedgeTimer);
              hedgeTimer = null;
            }
            if (leader === a) onPartial(p);
          }, a.ctrl.signal)
          .then(
            (r) => {
              if (a.timedOut) return;
              a.done = true;
              if (a.timer !== null) this.clearTimer(a.timer);
              quota.count(model);
              const total = this.now() - a.startedAt;
              pool.recordSuccess(model, a.firstAt ? a.firstAt - a.startedAt : total, total);
              if (!settled) finish(() => resolve(r));
            },
            (error: unknown) => {
              if (a.timedOut) return;
              a.done = true;
              if (a.timer !== null) this.clearTimer(a.timer);
              const err = error instanceof ProviderError ? error : new ProviderError('other', String(error));
              if (err.kind === 'aborted') {
                quota.count(model); // 서버는 이미 처리했을 수 있어 사용량에 넣는다
                return;
              }
              // 한도 초과(429)·잘못된 키·연결 실패는 사용량에 잡히지 않는다
              if (!NOT_COUNTED.has(err.kind)) quota.count(model);
              if (FAILOVER.has(err.kind)) pool.recordFailure(model);
              if (leader === a) leader = null;
              // 연결·서버 오류면 아직 안 써 본 다른 모델로 바로 넘긴다
              afterFailure(err);
            },
          );
      };

      start(primary, true);
      const hedgeAllowed = s.hedgeRequests && quota.pressure(pool.list()) === 'normal';
      if (hedgeAllowed) {
        hedgeTimer = this.setTimer(() => {
          hedgeTimer = null;
          if (settled || leader || attempts.length !== 1 || !this.hedgeBudgetLeft()) return;
          const other = pool.pick(tried());
          if (other) {
            this.hedgeTimes.push(this.now());
            start(other, false);
          }
        }, pool.hedgeDelayMs(primary));
      }
    });
  }

  /** 최근 3분 동안 한 번 더 보낸 수가 보낸 요청의 25% 보다 적은지 */
  private hedgeBudgetLeft(): boolean {
    const since = this.now() - HEDGE_WINDOW_MS;
    this.hedgeTimes = this.hedgeTimes.filter((t) => t > since);
    const sent = this.requestTimes.filter((t) => t > since).length;
    return this.hedgeTimes.length < Math.max(1, Math.floor(sent * HEDGE_BUDGET));
  }

  /** 문맥 기록 (이어받아 다시 쓴 문장은 같은 자리를 바꾼다) */
  private remember(id: string, line: string): void {
    const i = this.context.findIndex((c) => c.id === id);
    if (i >= 0) this.context[i] = { id, line };
    else this.context.push({ id, line });
    while (this.context.length > CONTEXT_SENTENCES) this.context.shift();
  }

  private handleError(model: string, batch: QueueItem, error: unknown): void {
    const { quota, pool } = this.deps;
    const err = error instanceof ProviderError ? error : new ProviderError('other', String(error));
    switch (err.kind) {
      case 'rate_limit': {
        const ms = err.retryAfterMs ?? 30_000;
        if (err.quota?.scope === 'perMinute' && err.quota.limit) quota.learn(model, 'perMinute', err.quota.limit);
        quota.backoff(model, ms);
        this.queue.unshift(batch); // 다른 모델이 비어 있으면 바로 그쪽으로 간다
        this.schedule(0);
        break;
      }
      case 'daily_quota': {
        if (err.quota?.limit) quota.learn(model, 'daily', err.quota.limit);
        quota.markExhausted(model);
        this.queue.unshift(batch);
        const next = pool.best();
        if (next && !pool.allExhausted()) this.status('warn', `${model} 의 오늘 무료 한도를 다 써서 ${next} 로 이어갑니다`);
        this.schedule(0);
        break;
      }
      case 'network':
      case 'server': {
        if (!batch.retried) {
          this.queue.unshift({ ...batch, retried: true, avoid: model });
          this.schedule(pool.list().length > 1 ? 0 : 1_500);
        } else {
          this.status('error', `${err.message} — 이 발화는 건너뜁니다`);
        }
        break;
      }
      case 'model_not_found': {
        pool.markGone(model);
        if (pool.list().length === 0) {
          this.queue = [];
          this.fatal(`'${model}' 모델을 이 키로 쓸 수 없습니다. API 키 화면에서 '연결 테스트'를 눌러 주세요.`);
        } else {
          this.queue.unshift(batch);
          this.status('warn', `'${model}' 모델을 더 이상 쓸 수 없어 다른 모델로 바꿉니다`);
          this.schedule(0);
        }
        break;
      }
      case 'auth':
        this.queue = [];
        this.fatal(`${err.message}. 설정에서 키를 확인해 주세요.`);
        break;
      default:
        this.status('error', `${err.message} — 이 발화는 건너뜁니다`);
    }
  }

  /** 동시에 보낸 요청이 둘 다 같은 오류로 실패해도 한 번만 알린다 */
  private fatal(message: string): void {
    if (this.fatalReported) return;
    this.fatalReported = true;
    this.deps.onFatal(message);
  }

  /** 맨 앞에서부터 같은 채널로 이어진 구간들을 최대 30초까지 하나로 합친다 (말한 순서 유지). 자막 자리가 정해진 구간은 합치지 않는다 */
  private takeBatch(): QueueItem {
    const channel = this.queue[0].channel;
    const slot = this.queue[0].slot;
    const parts: Float32Array[] = [];
    let total = 0;
    let retried = false;
    const avoid = this.queue[0].avoid;
    const enqueuedAt = this.queue[0].enqueuedAt;
    let taken = 0;
    for (const item of this.queue) {
      const d = durationSec(item.pcm);
      if (item.channel !== channel || (parts.length > 0 && (total + d > MAX_BATCH_SEC || slot || item.slot))) break;
      parts.push(item.pcm);
      total += d;
      retried ||= item.retried;
      taken++;
    }
    this.queue = this.queue.slice(taken);
    return { channel, pcm: concatWithGap(parts), retried, avoid, enqueuedAt, slot };
  }
}
