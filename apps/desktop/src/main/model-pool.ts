// 여러 Gemini 모델을 한 묶음으로 쓴다.
// - 실제 요청마다 걸린 시간을 기억해 지금 가장 빠른 모델을 고른다 (같은 키라도 모델마다 수 초씩 차이가 남)
// - 무료 한도는 모델별이라, 한 모델이 분당/일일 한도에 걸리거나 오류가 나면 다른 모델로 이어간다
// - 잰 속도는 저장해 두고, 오래된 값은 처음 순서(설정한 선호)로 조금씩 되돌아간다

import type { ModelInfo } from '../shared/types';
import type { ModelPreference } from '../shared/models';
import type { QuotaTracker } from './quota';

export interface ModelStat {
  /** 첫 글자가 오기까지 (ms, 지수 평균) */
  ttftMs: number;
  /** 다 받기까지 (ms, 지수 평균) */
  totalMs: number;
  samples: number;
  updatedAt: number;
  /** 이 키로 쓸 수 없다고(404) 확인한 시각 — 7일 뒤 다시 써 본다 */
  goneAt?: number;
}

export interface PoolStore {
  load(): Record<string, ModelStat> | null;
  save(stats: Record<string, ModelStat>): void;
}

/** 잰 값이 없을 때 1순위 모델의 예상 시간, 순위가 하나 내려갈 때마다 더하는 시간 */
const PRIOR_BASE_MS = 2_500;
const PRIOR_STEP_MS = 400;
/** 지수 평균 가중치 (새 값 비중) */
const ALPHA = 0.35;
/** 측정값이 이만큼 지나면 절반만 믿는다 */
const HALF_LIFE_MS = 6 * 3_600_000;
/** 연속 실패가 이만큼이면 잠시 쉬게 한다 */
const FAILURES_BEFORE_COOLDOWN = 2;
const COOLDOWN_MS = 30_000;
/** '더 자연스러운 번역'을 골랐으면 Lite 모델은 이만큼 느린 것으로 친다 */
const QUALITY_LITE_PENALTY_MS = 2_500;
/** 다른 모델로 한 번 더 보내기까지 기다리는 시간 범위 (보통 첫 글자 시간의 2배) */
const HEDGE_MIN_MS = 2_500;
const HEDGE_MAX_MS = 5_000;
const GONE_RECHECK_MS = 7 * 86_400_000;

export class ModelPool {
  private candidates: string[] = [];
  private preference: ModelPreference = 'fast';
  private stats: Map<string, ModelStat>;
  private failures = new Map<string, number>();
  private cooldownUntil = new Map<string, number>();
  private gone = new Set<string>();

  constructor(
    private readonly quota: QuotaTracker,
    private readonly store: PoolStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.stats = new Map(Object.entries(store.load() ?? {}));
    for (const [model, st] of this.stats) {
      if (st.goneAt && this.now() - st.goneAt < GONE_RECHECK_MS) this.gone.add(model);
    }
  }

  /** 후보 모델 (앞일수록 먼저 써 볼 모델) */
  setCandidates(models: string[], preference: ModelPreference): void {
    this.candidates = [...new Set(models.filter(Boolean))];
    this.preference = preference;
  }

  /** 쓸 수 있는 후보 (이 키로 없어진 모델 제외) */
  list(): string[] {
    return this.candidates.filter((m) => !this.gone.has(m));
  }

  private prior(model: string): number {
    const i = Math.max(0, this.candidates.indexOf(model));
    return PRIOR_BASE_MS + i * PRIOR_STEP_MS;
  }

  private weight(st: ModelStat): number {
    const age = Math.max(0, this.now() - st.updatedAt);
    return Math.min(1, st.samples / 2) * 0.5 ** (age / HALF_LIFE_MS);
  }

  /** 이 모델로 보내면 다 받기까지 걸릴 것으로 보는 시간 */
  expectedMs(model: string): number {
    const prior = this.prior(model);
    const st = this.stats.get(model);
    const w = st ? this.weight(st) : 0;
    const base = st ? w * st.totalMs + (1 - w) * prior : prior;
    const penalty = this.preference === 'quality' && model.includes('flash-lite') ? QUALITY_LITE_PENALTY_MS : 0;
    return base + penalty;
  }

  expectedTtftMs(model: string): number {
    const prior = this.prior(model) * 0.85;
    const st = this.stats.get(model);
    const w = st ? this.weight(st) : 0;
    return st ? w * st.ttftMs + (1 - w) * prior : prior;
  }

  /** 첫 글자가 이 시간 안에 안 오면 다른 모델로 한 번 더 보낸다 (2.5~5초) */
  hedgeDelayMs(model: string): number {
    return Math.round(Math.min(HEDGE_MAX_MS, Math.max(HEDGE_MIN_MS, this.expectedTtftMs(model) * 2)));
  }

  private usable(model: string): boolean {
    return !this.gone.has(model) && !this.quota.isExhausted(model);
  }

  /** 지금 바로 보낼 수 있는지 (분당 한도·잠시 쉼 포함) */
  isReady(model: string): boolean {
    const now = this.now();
    return this.usable(model) && (this.cooldownUntil.get(model) ?? 0) <= now && this.quota.nextAllowedAt(model) <= now;
  }

  /** 지금 보낼 수 있는 모델 중 가장 빠를 것으로 보이는 것 */
  pick(exclude: ReadonlySet<string> = new Set()): string | null {
    const ready = this.list().filter((m) => !exclude.has(m) && this.isReady(m));
    if (ready.length === 0) return null;
    return ready.reduce((best, m) => (this.expectedMs(m) < this.expectedMs(best) ? m : best));
  }

  /** 다 기다리는 중이면, 가장 먼저 보낼 수 있게 되는 시각 (보낼 모델이 아예 없으면 null) */
  nextAvailableAt(): number | null {
    const times = this.list()
      .filter((m) => this.usable(m))
      .map((m) => Math.max(this.cooldownUntil.get(m) ?? 0, this.quota.nextAllowedAt(m)));
    return times.length > 0 ? Math.min(...times) : null;
  }

  allExhausted(): boolean {
    return this.list().every((m) => !this.usable(m));
  }

  /** 가장 빠를 것으로 보이는 모델 (지금 보낼 수 없어도) — 화면 표시용 */
  best(): string | null {
    const usable = this.list().filter((m) => this.usable(m));
    if (usable.length === 0) return this.list()[0] ?? null;
    return usable.reduce((best, m) => (this.expectedMs(m) < this.expectedMs(best) ? m : best));
  }

  private update(model: string, ttftMs: number, totalMs: number): void {
    const prev = this.stats.get(model);
    const next: ModelStat = prev && prev.samples > 0
      ? {
          ttftMs: prev.ttftMs + (ttftMs - prev.ttftMs) * ALPHA,
          totalMs: prev.totalMs + (totalMs - prev.totalMs) * ALPHA,
          samples: Math.min(50, prev.samples + 1),
          updatedAt: this.now(),
        }
      : { ttftMs, totalMs, samples: 1, updatedAt: this.now() };
    delete next.goneAt;
    this.stats.set(model, next);
    this.store.save(Object.fromEntries(this.stats));
  }

  recordSuccess(model: string, ttftMs: number, totalMs: number): void {
    this.failures.set(model, 0);
    this.update(model, ttftMs, totalMs);
  }

  /** 다른 모델이 먼저 답해서 끊은 요청: 적어도 이만큼은 걸렸다는 뜻이라 느린 쪽으로 기록한다 */
  recordSlow(model: string, elapsedMs: number): void {
    const st = this.stats.get(model);
    const at = Math.max(elapsedMs * 1.5, st?.totalMs ?? 0);
    this.update(model, at * 0.9, at);
  }

  recordFailure(model: string): void {
    const n = (this.failures.get(model) ?? 0) + 1;
    if (n >= FAILURES_BEFORE_COOLDOWN) {
      this.cooldownUntil.set(model, this.now() + COOLDOWN_MS);
      this.failures.set(model, 0);
    } else {
      this.failures.set(model, n);
    }
  }

  /** 이 키로 더 이상 쓸 수 없는 모델 (404) */
  markGone(model: string): void {
    this.gone.add(model);
    const prev = this.stats.get(model) ?? { ttftMs: 0, totalMs: 0, samples: 0, updatedAt: this.now() };
    this.stats.set(model, { ...prev, goneAt: this.now() });
    this.store.save(Object.fromEntries(this.stats));
  }

  info(): ModelInfo[] {
    const now = this.now();
    return this.candidates.map((id) => {
      const st = this.stats.get(id);
      let state: ModelInfo['state'] = 'ready';
      if (this.gone.has(id)) state = 'gone';
      else if (this.quota.isExhausted(id)) state = 'exhausted';
      else if ((this.cooldownUntil.get(id) ?? 0) > now) state = 'cooldown';
      else if (this.quota.nextAllowedAt(id) > now) state = 'limited';
      return {
        id,
        state,
        used: this.quota.used(id),
        dailyLimit: this.quota.limits(id).daily,
        latencyMs: st && this.weight(st) > 0.2 ? Math.round(st.totalMs) : null,
      };
    });
  }
}
