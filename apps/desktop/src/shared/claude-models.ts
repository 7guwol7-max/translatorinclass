// 컨트롤 패널에서 고를 수 있는 Claude 모델 (월 비용은 교사 1명·하루 4교시 번역 기준 대략치)

export interface ClaudeModelOption {
  id: string;
  label: string;
}

export const CLAUDE_MODELS: ClaudeModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — 가장 정확 · 월 약 11만 원' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — 균형 · 월 약 6만 원' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — 빠르고 저렴 · 월 약 3천 원' },
];
