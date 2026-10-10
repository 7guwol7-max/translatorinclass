// 엔진 오류를 파이프라인이 다루기 쉬운 몇 가지 종류로 나눈다

export type ProviderErrorKind =
  | 'rate_limit' // 분당 한도 → 기다렸다 다시
  | 'daily_quota' // 일일 한도 소진 → 대체 모델 또는 중단
  | 'auth' // 키가 잘못됨
  | 'model_not_found'
  | 'bad_request'
  | 'network'
  | 'server'
  | 'refusal'
  | 'other';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

interface StatusLike {
  status?: unknown;
  message?: unknown;
}

/** @google/genai 의 ApiError(status + 응답 본문이 담긴 message) 와 fetch 오류를 분류한다 */
export function classifyGeminiError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = (error ?? {}) as StatusLike;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = typeof e.message === 'string' ? e.message : String(error);

  if (status === 429 || /RESOURCE_EXHAUSTED/.test(message)) {
    const retry = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
    const retryAfterMs = retry ? Math.ceil(Number(retry[1]) * 1000) : undefined;
    if (/PerDay/i.test(message)) return new ProviderError('daily_quota', '오늘 무료 요청 한도를 다 썼습니다', retryAfterMs);
    return new ProviderError('rate_limit', '요청이 많아 잠시 기다립니다', retryAfterMs);
  }
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(message)) {
    return new ProviderError('auth', 'Gemini API 키가 올바르지 않거나 권한이 없습니다');
  }
  if (status === 404) return new ProviderError('model_not_found', '이 키로 쓸 수 없는 모델입니다');
  if (status === 400) return new ProviderError('bad_request', `잘못된 요청입니다: ${shorten(message)}`);
  if (status !== undefined && status >= 500) return new ProviderError('server', 'Gemini 서버가 일시적으로 응답하지 않습니다');
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|aborted|timeout/i.test(message)) {
    return new ProviderError('network', '인터넷 연결을 확인해 주세요');
  }
  return new ProviderError('other', shorten(message));
}

export function shorten(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
