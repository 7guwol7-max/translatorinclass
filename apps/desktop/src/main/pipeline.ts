// 발화 구간 대기열 → Gemini(받아쓰기·번역) → (선택) Claude 번역 → 자막.
// 한 번에 요청 하나만 보내고, 기다리는 동안 쌓인 같은 채널 구간은 하나로 합쳐 요청 수를 줄인다.

import type { Caption, Channel, QuotaPressure, QuotaStatus, Settings, StatusMessage } from '../shared/types';
import { buildSegmentPrompt, speakerFor, translationTargets, type SegmentResult } from '../shared/prompts';
import { concatWithGap, durationSec, encodeWav } from '../shared/wav';
import { ProviderError } from './providers/errors';
import type { QuotaTracker } from './quota';
import type { TranslateInput } from './providers/claude';

/** 한 요청에 합칠 최대 오디오 길이 */
const MAX_BATCH_SEC = 30;
/** 대기열이 이보다 길어지면 오래된 것부터 버린다 (인터넷이 끊긴 경우 등) */
const MAX_QUEUE_SEC = 180;
const CONTEXT_SENTENCES = 3;
const NOT_COUNTED = new Set(['rate_limit', 'daily_quota', 'auth', 'model_not_found', 'network']);

export interface PipelineDeps {
  getSettings(): Settings;
  transcribe(model: string, wav: Uint8Array, prompt: string): Promise<SegmentResult>;
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

interface QueueItem {
  channel: Channel;
  pcm: Float32Array;
  retried: boolean;
}

export class Pipeline {
  private queue: QueueItem[] = [];
  private busy = false;
  private timer: unknown = null;
  private context: string[] = [];
  private exhaustedNotified = false;
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

  /** 다음 요청을 보낼 수 있으면 보낸다 */
  async pump(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;

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
    this.busy = true;
    this.deps.quota.noteSent();
    this.publishQuota();
    const startedAt = this.now();
    try {
      await this.process(model, batch, startedAt);
    } catch (error) {
      this.handleError(model, batch, error);
    } finally {
      this.busy = false;
      this.publishQuota();
      if (this.queue.length > 0) void this.pump();
    }
  }

  private async process(model: string, batch: QueueItem, startedAt: number): Promise<void> {
    const s = this.deps.getSettings();
    const translator = s.translator === 'claude' ? this.deps.getTranslator() : null;
    const prompt = buildSegmentPrompt({
      channel: batch.channel,
      studentLanguages: s.studentLanguages,
      translate: translator === null,
      glossary: s.glossary,
      context: this.context.slice(-CONTEXT_SENTENCES),
    });

    let result: SegmentResult;
    try {
      result = await this.deps.transcribe(model, encodeWav(batch.pcm), prompt);
    } catch (error) {
      // 한도 초과(429)·잘못된 키·연결 실패는 사용량에 잡히지 않는다
      if (!(error instanceof ProviderError && NOT_COUNTED.has(error.kind))) this.deps.quota.count(model);
      throw error;
    }
    this.deps.quota.count(model);
    if (!result.transcript) return; // 말소리 없음

    const speaker = speakerFor(batch.channel, result.lang);
    const lang = result.lang || (speaker === 'teacher' ? 'ko' : '');
    const targets = translationTargets(speaker, lang, s.studentLanguages);
    let translations: Record<string, string> = {};

    if (translator) {
      try {
        translations = await translator(s.claudeModel, {
          transcript: result.transcript,
          sourceLang: lang,
          targets,
          glossary: s.glossary,
          context: this.context.slice(-CONTEXT_SENTENCES),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.status('warn', `Claude 번역 실패 — 원문만 표시합니다 (${message})`);
      }
    } else {
      for (const t of targets) if (result.translations[t]) translations[t] = result.translations[t];
    }

    this.context.push(result.transcript);
    if (this.context.length > CONTEXT_SENTENCES) this.context.shift();

    this.deps.onCaption({
      id: `${startedAt.toString(36)}-${(this.seq++).toString(36)}`,
      ts: this.now(),
      speaker,
      lang,
      transcript: result.transcript,
      translations,
      latencyMs: this.now() - startedAt,
    });
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
        this.deps.onFatal(`${err.message}. 설정에서 키를 확인해 주세요.`);
        break;
      case 'model_not_found':
        this.queue = [];
        this.deps.onFatal(`'${model}' 모델을 쓸 수 없습니다. 설정에서 '연결 테스트'를 눌러 모델을 다시 고르세요.`);
        break;
      default:
        this.status('error', `${err.message} — 이 발화는 건너뜁니다`);
    }
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
