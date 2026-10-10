// 무료 등급 요청 한도 관리: 일일 사용량(모델별), 분당 간격, 한도 초과 시 대기.
// Google 의 일일 한도는 태평양 시간 자정에 초기화된다 (한국 시간 오후 4~5시).

import type { QuotaPressure } from '../shared/types';

export interface QuotaState {
  day: string;
  used: Record<string, number>;
}

export interface QuotaStore {
  load(): QuotaState | null;
  save(state: QuotaState): void;
}

export interface QuotaLimits {
  daily: number;
  perMinute: number;
}

const PACIFIC = 'America/Los_Angeles';

export function pacificDay(ms: number): string {
  // en-CA 형식은 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** 다음 태평양 시간 자정(= 일일 한도 초기화 시각) */
export function nextPacificMidnight(ms: number): number {
  const [y, m, d] = pacificDay(ms).split('-').map(Number);
  for (const utcHour of [7, 8]) {
    const candidate = Date.UTC(y, m - 1, d + 1, utcHour);
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, hour: 'numeric', hourCycle: 'h23' }).format(new Date(candidate));
    if (Number(hour) === 0) return candidate;
  }
  return Date.UTC(y, m - 1, d + 1, 8);
}

export class QuotaTracker {
  private state: QuotaState;
  private lastSentAt = 0;
  private backoffUntil = 0;
  private exhausted = new Set<string>();

  constructor(
    private readonly store: QuotaStore,
    private readonly limits: () => QuotaLimits,
    private readonly now: () => number = () => Date.now(),
  ) {
    const loaded = store.load();
    const today = pacificDay(this.now());
    this.state = loaded && loaded.day === today ? loaded : { day: today, used: {} };
  }

  private roll(): void {
    const today = pacificDay(this.now());
    if (today !== this.state.day) {
      this.state = { day: today, used: {} };
      this.exhausted.clear();
      this.store.save(this.state);
    }
  }

  day(): string {
    this.roll();
    return this.state.day;
  }

  used(model: string): number {
    this.roll();
    return this.state.used[model] ?? 0;
  }

  /** 요청을 보낼 때 (분당 간격 계산용) */
  noteSent(): void {
    this.lastSentAt = this.now();
  }

  /** 한도에 잡히는 요청 하나 (성공, 또는 429 가 아닌 실패) */
  count(model: string): void {
    this.roll();
    this.state.used[model] = (this.state.used[model] ?? 0) + 1;
    this.store.save(this.state);
  }

  /** 다음 요청을 보내도 되는 가장 이른 시각 */
  nextAllowedAt(): number {
    const spacing = 60_000 / Math.max(1, this.limits().perMinute);
    return Math.max(this.lastSentAt + spacing, this.backoffUntil);
  }

  backoff(ms: number): void {
    this.backoffUntil = Math.max(this.backoffUntil, this.now() + ms);
  }

  waitUntil(): number | null {
    return this.backoffUntil > this.now() ? this.backoffUntil : null;
  }

  markExhausted(model: string): void {
    this.roll();
    this.exhausted.add(model);
  }

  isExhausted(model: string): boolean {
    this.roll();
    return this.exhausted.has(model) || this.used(model) >= this.limits().daily;
  }

  pressure(model: string): QuotaPressure {
    if (this.isExhausted(model)) return 'exhausted';
    return this.used(model) >= this.limits().daily * 0.7 ? 'saving' : 'normal';
  }
}
