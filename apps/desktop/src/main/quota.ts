// 무료 등급 요청 한도 관리 (모델마다 따로): 일일 사용량, 분당 요청 수(최근 60초 창), 429 대기.
// Google 의 무료 한도는 프로젝트·모델별이라, 한 모델이 막혀도 다른 모델은 쓸 수 있다.
// 한도 값은 설정의 기본값으로 시작하고, 429 응답에 실제 한도(quotaValue)가 오면 그 값을 배워 저장한다.
// 일일 한도는 태평양 시간 자정에 초기화된다 (한국 시간 오후 4~5시).

import type { QuotaPressure } from '../shared/types';

export interface LearnedLimits {
  daily?: number;
  perMinute?: number;
}

export interface QuotaState {
  day: string;
  used: Record<string, number>;
  /** 429 응답에서 배운 모델별 한도 (날짜가 바뀌어도 유지) */
  limits?: Record<string, LearnedLimits>;
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
  /** 모델별로 최근 60초 안에 보낸 요청 시각 */
  private sent = new Map<string, number[]>();
  private backoffUntil = new Map<string, number>();
  private exhausted = new Set<string>();

  constructor(
    private readonly store: QuotaStore,
    /** 배운 값이 없는 모델에 쓸 기본 한도 (설정) */
    private readonly defaults: () => QuotaLimits,
    private readonly now: () => number = () => Date.now(),
  ) {
    const loaded = store.load();
    const today = pacificDay(this.now());
    const limits = loaded?.limits ?? {};
    this.state = loaded && loaded.day === today ? { ...loaded, limits } : { day: today, used: {}, limits };
  }

  private roll(): void {
    const today = pacificDay(this.now());
    if (today !== this.state.day) {
      this.state = { day: today, used: {}, limits: this.state.limits };
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

  limits(model: string): QuotaLimits {
    const d = this.defaults();
    const learned = this.state.limits?.[model] ?? {};
    return { daily: learned.daily ?? d.daily, perMinute: learned.perMinute ?? d.perMinute };
  }

  /** 429 응답에 실제 한도가 오면 기억한다 */
  learn(model: string, scope: 'daily' | 'perMinute', value: number): void {
    if (!Number.isFinite(value) || value <= 0) return;
    const limits = (this.state.limits ??= {});
    const cur = (limits[model] ??= {});
    if (cur[scope] === value) return;
    cur[scope] = Math.round(value);
    this.store.save(this.state);
  }

  remaining(model: string): number {
    if (this.isExhausted(model)) return 0;
    return Math.max(0, this.limits(model).daily - this.used(model));
  }

  /** 요청을 보낼 때 (분당 한도 계산용) */
  noteSent(model: string): void {
    const list = this.sent.get(model) ?? [];
    list.push(this.now());
    this.sent.set(model, list);
  }

  /** 한도에 잡히는 요청 하나 (성공, 또는 429 가 아닌 실패) */
  count(model: string): void {
    this.roll();
    this.state.used[model] = (this.state.used[model] ?? 0) + 1;
    this.store.save(this.state);
  }

  /** 이 모델에 다음 요청을 보내도 되는 가장 이른 시각.
   *  일정 간격으로 띄우지 않고, 최근 60초 동안 보낸 수가 분당 한도보다 적으면 바로 보낸다. */
  nextAllowedAt(model: string): number {
    const now = this.now();
    const list = (this.sent.get(model) ?? []).filter((t) => t > now - 60_000);
    this.sent.set(model, list);
    const perMinute = Math.max(1, this.limits(model).perMinute);
    const windowFreeAt = list.length < perMinute ? now : list[list.length - perMinute] + 60_000;
    return Math.max(windowFreeAt, this.backoffUntil.get(model) ?? 0);
  }

  /** 최근 60초 동안 이 모델에 보낸 요청 수 */
  sentLastMinute(model: string): number {
    const now = this.now();
    return (this.sent.get(model) ?? []).filter((t) => t > now - 60_000).length;
  }

  backoff(model: string, ms: number): void {
    this.backoffUntil.set(model, Math.max(this.backoffUntil.get(model) ?? 0, this.now() + ms));
  }

  waitUntil(model: string): number | null {
    const t = this.backoffUntil.get(model) ?? 0;
    return t > this.now() ? t : null;
  }

  markExhausted(model: string): void {
    this.roll();
    this.exhausted.add(model);
  }

  isExhausted(model: string): boolean {
    this.roll();
    return this.exhausted.has(model) || this.used(model) >= this.limits(model).daily;
  }

  /** 여러 모델을 합쳐 본 한도 상황: 남은 양이 20% 아래면 절약, 모두 소진이면 exhausted */
  pressure(models: string[]): QuotaPressure {
    if (models.length === 0 || models.every((m) => this.isExhausted(m))) return 'exhausted';
    const total = models.reduce((n, m) => n + this.limits(m).daily, 0);
    const left = models.reduce((n, m) => n + this.remaining(m), 0);
    return left <= total * 0.2 ? 'saving' : 'normal';
  }
}
