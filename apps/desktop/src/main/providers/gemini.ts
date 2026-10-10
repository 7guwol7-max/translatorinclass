// Gemini: 오디오 한 구간 → 받아쓰기 + 언어 판별 + (선택) 번역 을 한 번에
import { GoogleGenAI, type Schema } from '@google/genai';
import { GEMINI_SYSTEM_INSTRUCTION, SEGMENT_RESPONSE_SCHEMA, parseSegmentResult, type SegmentResult } from '../../shared/prompts';
import { classifyGeminiError } from './errors';

const REQUEST_TIMEOUT_MS = 30_000;

export class GeminiClient {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    // 재시도는 파이프라인이 한도를 보면서 직접 한다 (SDK 가 429 를 자동 재시도하면 무료 한도가 낭비됨)
    this.ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
  }

  async transcribe(model: string, wav: Uint8Array, prompt: string): Promise<SegmentResult> {
    try {
      const response = await this.ai.models.generateContent({
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
        },
      });
      return parseSegmentResult(response.text);
    } catch (error) {
      throw classifyGeminiError(error);
    }
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
