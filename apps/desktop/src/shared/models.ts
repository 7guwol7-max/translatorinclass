// 이 키로 쓸 수 있는 Gemini 모델 중 받아쓰기·번역에 쓸 후보를 고르고, 처음 순서를 정한다.
// 실제 순서는 수업 중에 잰 응답 속도로 바뀐다 (main/model-pool.ts). 무료 한도는 모델마다 따로라서
// 후보가 여러 개면 한 모델이 느리거나 한도가 차도 다른 모델로 이어갈 수 있다.

export type ModelPreference = 'fast' | 'quality';

const MAX_CANDIDATES = 6;

interface ParsedModel {
  id: string;
  version: number;
  lite: boolean;
  preview: boolean;
}

/** gemini-3.1-flash-lite, gemini-3-flash-preview 처럼 오디오를 받는 Flash 계열만 (tts·image·live·별칭 latest 등 제외) */
export function parseFlashModel(name: string): ParsedModel | null {
  const id = name.replace(/^models\//, '');
  const m = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(-preview(?:-\d{2}-\d{4})?)?$/.exec(id);
  if (!m) return null;
  const version = Number(m[1]);
  if (!(version >= 2.5)) return null;
  return { id, version, lite: Boolean(m[2]), preview: Boolean(m[3]) };
}

/**
 * 후보 모델과 처음 순서.
 * - fast: Flash-Lite(빠르고 무료 한도가 넉넉함) 먼저, 그다음 Flash
 * - quality: Flash(번역이 더 자연스러움) 먼저
 * 같은 무리 안에서는 안정판 → 미리보기, 최신 버전 먼저.
 */
export function rankGeminiCandidates(names: string[], preference: ModelPreference): string[] {
  const parsed = [...new Set(names)].map(parseFlashModel).filter((p): p is ParsedModel => p !== null);
  const group = (p: ParsedModel) => (preference === 'fast' ? (p.lite ? 0 : 1) : p.lite ? 1 : 0);
  parsed.sort((a, b) => group(a) - group(b) || Number(a.preview) - Number(b.preview) || b.version - a.version);
  return parsed.slice(0, MAX_CANDIDATES).map((p) => p.id);
}
