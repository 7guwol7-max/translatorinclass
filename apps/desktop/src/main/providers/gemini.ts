// Gemini: 오디오 한 구간 → 받아쓰기 + 언어 판별 + (선택) 번역 을 한 번에.
// 응답을 스트리밍으로 받아, 받아쓰기가 나오는 즉시 화면에 보여줄 수 있게 한다.
import { GoogleGenAI, ThinkingLevel, type Schema, type ThinkingConfig } from '@google/genai';
import {
  GEMINI_SYSTEM_INSTRUCTION,
  SEGMENT_RESPONSE_SCHEMA,
  parsePartialSegment,
  parseSegmentResult,
  type SegmentResult,
} from '../../shared/prompts';
import { ProviderError, classifyGeminiError } from './errors';

const REQUEST_TIMEOUT_MS = 30_000;

/** 지연을 줄이려고 '생각' 단계를 최소로. 모델이 이 옵션을 거부하면 다음부터 빼고 보낸다 */
export function thinkingFor(model: string): ThinkingConfig | undefined {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-([3-9]|\d{2,})/.test(model)) return { thinkingLevel: ThinkingLevel.MINIMAL };
  return undefined;
}

export class GeminiClient {
  private readonly ai: GoogleGenAI;
  private readonly noThinkingOption = new Set<string>();

  constructor(apiKey: string) {
    // 재시도는 파이프라인이 한도를 보면서 직접 한다 (SDK 가 429 를 자동 재시도하면 무료 한도가 낭비됨)
    this.ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
  }

  /** signal: 다른 모델이 먼저 답하면 이 요청을 끊는 데 쓴다 */
  async transcribe(
    model: string,
    wav: Uint8Array,
    prompt: string,
    onPartial?: (partial: SegmentResult) => void,
    signal?: AbortSignal,
  ): Promise<SegmentResult> {
    const thinking = this.noThinkingOption.has(model) ? undefined : thinkingFor(model);
    try {
      return await this.stream(model, wav, prompt, thinking, onPartial, signal);
    } catch (error) {
      if (signal?.aborted) throw new ProviderError('aborted', '요청을 취소했습니다');
      const message = String((error as { message?: unknown })?.message ?? error);
      if (thinking && /thinking/i.test(message) && /\b400\b|INVALID_ARGUMENT|not supported/i.test(message)) {
        this.noThinkingOption.add(model);
        try {
          return await this.stream(model, wav, prompt, undefined, onPartial, signal);
        } catch (retryError) {
          if (signal?.aborted) throw new ProviderError('aborted', '요청을 취소했습니다');
          throw classifyGeminiError(retryError);
        }
      }
      throw classifyGeminiError(error);
    }
  }

  /** 수업 시작 때 연결(TLS)을 미리 열어 둔다. generateContent 가 아니라 무료 요청 수에 잡히지 않는다 */
  async warmUp(model: string): Promise<void> {
    try {
      await this.ai.models.get({ model });
    } catch {
      // 미리 열기는 실패해도 괜찮다
    }
  }

  private async stream(
    model: string,
    wav: Uint8Array,
    prompt: string,
    thinking: ThinkingConfig | undefined,
    onPartial?: (partial: SegmentResult) => void,
    signal?: AbortSignal,
  ): Promise<SegmentResult> {
    const chunks = await this.ai.models.generateContentStream({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/wav', data: Buffer.from(wav).toString('base64') } },
            { text: prompt },
          ],
        },
      ],
      config: {
        systemInstruction: GEMINI_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: SEGMENT_RESPONSE_SCHEMA as unknown as Schema,
        ...(thinking ? { thinkingConfig: thinking } : {}),
        ...(signal ? { abortSignal: signal } : {}),
      },
    });
    let text = '';
    for await (const chunk of chunks) {
      if (signal?.aborted) throw new ProviderError('aborted', '요청을 취소했습니다');
      text += chunk.text ?? '';
      if (onPartial) {
        const partial = parsePartialSegment(text);
        if (partial.transcript) onPartial(partial);
      }
    }
    const result = parseSegmentResult(text);
    // 끝에서 JSON 이 깨졌다면 받은 데까지라도 쓴다
    return result.transcript ? result : parsePartialSegment(text);
  }

  /** 이 키로 generateContent 를 쓸 수 있는 모델 ID 목록 */
  async listModels(): Promise<string[]> {
    try {
      const pager = await this.ai.models.list();
      const names: string[] = [];
      for await (const model of pager) {
        if (!model.name) continue;
        const actions = model.supportedActions ?? [];
        if (actions.length === 0 || actions.includes('generateContent')) names.push(model.name.replace(/^models\//, ''));
      }
      return names.sort();
    } catch (error) {
      throw classifyGeminiError(error);
    }
  }
}
