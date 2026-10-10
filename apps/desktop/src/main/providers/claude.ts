// Claude: (선택) Gemini 가 받아쓴 문장을 번역. 교사가 본인 Claude API 키를 넣었을 때만 사용.
import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_SYSTEM_PROMPT, CLAUDE_TRANSLATION_SCHEMA, buildClaudeUserPrompt, parseTranslations } from '../../shared/prompts';
import { ProviderError, shorten } from './errors';

/** 서버 측 거절 대비(fallbacks: "default")를 지원하는 모델 — Haiku 5.5 는 지원하지 않음 */
function supportsDefaultFallback(model: string): boolean {
  return /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/.test(model);
}

export interface TranslateInput {
  transcript: string;
  sourceLang: string;
  targets: string[];
  glossary: string;
  context: string[];
}

export class ClaudeTranslator {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000 });
  }

  async translate(model: string, input: TranslateInput): Promise<Record<string, string>> {
    if (input.targets.length === 0) return {};
    try {
      const response = await this.client.beta.messages.create({
        model,
        max_tokens: 4096,
        system: CLAUDE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildClaudeUserPrompt(input) }],
        // 실시간 자막이므로 생각은 짧게
        output_config: { effort: 'low', format: { type: 'json_schema', schema: CLAUDE_TRANSLATION_SCHEMA } },
        ...(supportsDefaultFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      if (response.stop_reason === 'refusal') {
        throw new ProviderError('refusal', 'Claude 가 이 문장의 번역을 거절했습니다');
      }
      const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      return parseTranslations(text, input.targets);
    } catch (error) {
      throw classifyClaudeError(error);
    }
  }

  /** 키와 모델이 유효한지 확인 (요금이 들지 않는 조회) */
  async check(model: string): Promise<void> {
    try {
      await this.client.models.retrieve(model);
    } catch (error) {
      throw classifyClaudeError(error);
    }
  }
}

export function classifyClaudeError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError('auth', 'Claude API 키가 올바르지 않거나 권한이 없습니다');
  }
  if (error instanceof Anthropic.NotFoundError) return new ProviderError('model_not_found', '이 키로 쓸 수 없는 Claude 모델입니다');
  if (error instanceof Anthropic.RateLimitError) {
    const retryAfter = Number(error.headers?.get('retry-after'));
    return new ProviderError('rate_limit', 'Claude 요청이 많아 잠시 기다립니다', Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
  }
  if (error instanceof Anthropic.BadRequestError) return new ProviderError('bad_request', `Claude 요청 오류: ${shorten(error.message)}`);
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError('network', '인터넷 연결을 확인해 주세요');
  if (error instanceof Anthropic.APIError) {
    return new ProviderError(error.status !== undefined && error.status >= 500 ? 'server' : 'other', `Claude 오류: ${shorten(error.message)}`);
  }
  return new ProviderError('other', shorten(String(error)));
}
