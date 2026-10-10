// 발화 구간 대기열 → Gemini(받아쓰기·번역) → (선택) Claude 번역 → 자막.
// 요청을 최대 2개까지 동시에 보내고, 응답은 스트리밍으로 받아 받아쓰기부터 바로 보여준다.
// 두 요청이 다 바쁘거나 분당 한도에 걸려 기다리는 동안 쌓인 같은 채널 구간은 하나로 합쳐 요청 수를 줄인다.

import type { Caption, Channel, QuotaPressure, QuotaStatus, Settings, StatusMessage } from '../shared/types';
import { buildSegmentPrompt, contextLine, speakerFor, translationTargets, type SegmentResult } from '../shared/prompts';
import { concatWithGap, durationSec, encodeWav } from '../shared/wav';
import { ProviderError } from './providers/errors';
import type { QuotaTracker } from './quota';
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

export interface PipelineDeps {
  getSettings(): Settings;
  transcribe(model: string, wav: Uint8Array, prompt: string, onPartial?: (partial: SegmentResult) => void): Promise<SegmentResult>;
  /** Claude 키가 없으면 null */
  getTranslator(): ((model: string, input: TranslateInput) => Promise<Record<string, string>>) | null;
  quota: QuotaTracker;
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
}

export class Pipeline {
  private queue: QueueItem[] = [];
  private inFlight = 0;
  private timer: unknown = null;
  private context: { id: string; line: string }[] = [];
  /** 중간에서 끊긴 마지막 교사 문장 (다음 구간이 이어받음) */
  private open: OpenSentence | null = null;
  private exhaustedNotified = false;
  private fatalReported = false;
  private seq = 0;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: PipelineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  enqueue(channel: Channel, pcm: Float32Array): void {
    if (pcm.length === 0) return;
    this.queue.push({ channel, pcm, retried: false });
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

  /** 지금 쓸 Gemini 모델. 기본 모델 한도가 끝나면 대체 모델, 둘 다 끝나면 null */
  currentModel(): string | null {
    const s = this.deps.getSettings();
    if (!this.deps.quota.isExhausted(s.geminiModel)) return s.geminiModel;
    const fallback = s.geminiFallbackModel.trim();
    if (fallback && fallback !== s.geminiModel && !this.deps.quota.isExhausted(fallback)) return fallback;
    return null;
  }

  quotaStatus(): QuotaStatus {
    const s = this.deps.getSettings();
    const model = this.currentModel();
    const shown = model ?? s.geminiModel;
    let pressure: QuotaPressure = model ? this.deps.quota.pressure(model) : 'exhausted';
    // 대기열이 밀리면 구간을 길게 묶어 요청 수를 줄인다
    if (pressure === 'normal' && this.queue.length >= 3) pressure = 'saving';
    return {
      used: this.deps.quota.used(shown),
      limit: s.dailyRequestLimit,
      day: this.deps.quota.day(),
      pressure,
      waitUntil: this.deps.quota.waitUntil(),
      queued: this.queue.length,
      model: shown,
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
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length > 0) {
      const model = this.currentModel();
      if (!model) {
        if (!this.exhaustedNotified) {
          this.exhaustedNotified = true;
          this.status('error', '오늘 무료 요청 한도를 다 썼습니다. 한도는 매일 한국 시간 오후 4~5시에 초기화됩니다. (설정에서 한도 값이나 대체 모델을 바꿀 수 있어요)');
        }
        this.queue = [];
        this.publishQuota();
        return;
      }
      this.exhaustedNotified = false;

      const wait = this.deps.quota.nextAllowedAt() - this.now();
      if (wait > 0) {
        this.schedule(wait);
        return;
      }

      const batch = this.takeBatch();
      this.inFlight++;
      this.deps.quota.noteSent();
      this.publishQuota();
      void this.run(model, batch);
    }
  }

  private async run(model: string, batch: QueueItem): Promise<void> {
    const startedAt = this.now();
    const seq = this.seq++;
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

    const ownId = `${startedAt.toString(36)}-${seq.toString(36)}`;
    /** 이어받은 경우 앞 자막 자리에 문장 전체를 다시 쓴다 */
    const target = (r: SegmentResult) => (open && speakerFor(batch.channel, r.lang) === 'teacher' ? open : null);
    const emit = (r: SegmentResult, translations: Record<string, string>, final: boolean) => {
      const speaker = speakerFor(batch.channel, r.lang);
      const lang = r.lang || (speaker === 'teacher' ? 'ko' : '');
      const joined = target(r);
      this.deps.onCaption({
        id: joined ? joined.id : ownId,
        seq: joined ? joined.seq : seq,
        ts: joined ? joined.ts : startedAt,
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

    let result: SegmentResult;
    try {
      result = await this.deps.transcribe(model, encodeWav(batch.pcm), prompt, onPartial);
    } catch (error) {
      // 한도 초과(429)·잘못된 키·연결 실패는 사용량에 잡히지 않는다
      if (!(error instanceof ProviderError && NOT_COUNTED.has(error.kind))) this.deps.quota.count(model);
      throw error;
    }
    this.deps.quota.count(model);
    if (!result.transcript && lastPartial) result = lastPartial;
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

    const id = joined ? joined.id : ownId;
    this.remember(id, contextLine(fullTranscript, translations, s.overlayLanguages.length ? s.overlayLanguages : s.studentLanguages));
    // 교사 문장이 아직 안 끝났으면 다음 구간이 이어받는다 (너무 길어지면 끊는다)
    const parts = (joined?.parts ?? 0) + 1;
    if (speaker === 'teacher' && result.complete === false && parts < MAX_JOINED_PARTS) {
      this.open = { id, seq: joined ? joined.seq : seq, ts: joined ? joined.ts : startedAt, transcript: fullTranscript, translations, parts, endedAt: this.now() };
    }
  }

  /** 문맥 기록 (이어받아 다시 쓴 문장은 같은 자리를 바꾼다) */
  private remember(id: string, line: string): void {
    const i = this.context.findIndex((c) => c.id === id);
    if (i >= 0) this.context[i] = { id, line };
    else this.context.push({ id, line });
    while (this.context.length > CONTEXT_SENTENCES) this.context.shift();
  }

  private handleError(model: string, batch: QueueItem, error: unknown): void {
    const err = error instanceof ProviderError ? error : new ProviderError('other', String(error));
    switch (err.kind) {
      case 'rate_limit': {
        const ms = err.retryAfterMs ?? 30_000;
        this.deps.quota.backoff(ms);
        this.queue.unshift(batch);
        this.status('warn', `분당 요청 한도에 걸려 ${Math.ceil(ms / 1000)}초 기다렸다 이어서 처리합니다`);
        this.schedule(ms);
        break;
      }
      case 'daily_quota': {
        this.deps.quota.markExhausted(model);
        this.queue.unshift(batch);
        const next = this.currentModel();
        if (next) this.status('warn', `${model} 의 오늘 한도를 다 써서 ${next} 로 이어갑니다`);
        break;
      }
      case 'network':
      case 'server': {
        if (!batch.retried) {
          this.queue.unshift({ ...batch, retried: true });
          this.deps.quota.backoff(3_000);
          this.schedule(3_000);
        } else {
          this.status('error', `${err.message} — 이 발화는 건너뜁니다`);
        }
        break;
      }
      case 'auth':
        this.queue = [];
        this.fatal(`${err.message}. 설정에서 키를 확인해 주세요.`);
        break;
      case 'model_not_found':
        this.queue = [];
        this.fatal(`'${model}' 모델을 쓸 수 없습니다. 설정에서 '연결 테스트'를 눌러 모델을 다시 고르세요.`);
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

  /** 맨 앞에서부터 같은 채널로 이어진 구간들을 최대 30초까지 하나로 합친다 (말한 순서 유지) */
  private takeBatch(): QueueItem {
    const channel = this.queue[0].channel;
    const parts: Float32Array[] = [];
    let total = 0;
    let retried = false;
    let taken = 0;
    for (const item of this.queue) {
      const d = durationSec(item.pcm);
      if (item.channel !== channel || (parts.length > 0 && total + d > MAX_BATCH_SEC)) break;
      parts.push(item.pcm);
      total += d;
      retried ||= item.retried;
      taken++;
    }
    this.queue = this.queue.slice(taken);
    return { channel, pcm: concatWithGap(parts), retried };
  }
}
