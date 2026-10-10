// main / preload / renderer 가 함께 쓰는 타입과 기본값

/** 마이크 채널: 교사 전용(한국어), 학생 전용, 자동(한 마이크를 같이 씀 → 언어로 구분) */
export type Channel = 'teacher' | 'student' | 'auto';
export type Speaker = 'teacher' | 'student';
export type TranslatorEngine = 'gemini' | 'claude';
export type KeyProvider = 'gemini' | 'claude';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Settings {
  geminiModel: string;
  /** 일일 한도를 다 쓰면 넘어갈 모델 ('' = 사용 안 함) */
  geminiFallbackModel: string;
  translator: TranslatorEngine;
  claudeModel: string;
  /** 학급 학생들의 언어 = 교사 발화를 번역할 언어 */
  studentLanguages: string[];
  /** 오버레이에 보여줄 번역 언어 (studentLanguages 의 일부, 최대 3개) */
  overlayLanguages: string[];
  showKoreanOnOverlay: boolean;
  /** '' = 시스템 기본 마이크 */
  teacherMicId: string;
  /** '' = 학생 마이크 없음 */
  studentMicId: string;
  /** teacher: 교사 마이크는 한국어 고정 / auto: 한 마이크로 교사·학생 모두 (언어로 구분) */
  teacherMicMode: 'teacher' | 'auto';
  /** AI Studio 에서 확인한 내 무료 일일 요청 한도 */
  dailyRequestLimit: number;
  /** 분당 요청 한도 */
  requestsPerMinute: number;
  /** 한 줄에 하나: 한국어 = 번역어 (예: 광합성 = photosynthesis) */
  glossary: string;
  overlayFontSize: number;
  overlayBounds: Bounds | null;
  studentLinkEnabled: boolean;
  studentLinkPort: number;
}

export const DEFAULT_SETTINGS: Settings = {
  geminiModel: 'gemini-3.5-flash-lite',
  geminiFallbackModel: '',
  translator: 'gemini',
  claudeModel: 'claude-opus-5-5',
  studentLanguages: ['vi', 'zh'],
  overlayLanguages: ['vi', 'zh'],
  showKoreanOnOverlay: true,
  teacherMicId: '',
  studentMicId: '',
  teacherMicMode: 'auto',
  dailyRequestLimit: 500,
  requestsPerMinute: 10,
  glossary: '',
  overlayFontSize: 30,
  overlayBounds: null,
  studentLinkEnabled: false,
  studentLinkPort: 8787,
};

export interface Caption {
  id: string;
  ts: number;
  speaker: Speaker;
  /** 말한 언어 (ISO 639-1) */
  lang: string;
  transcript: string;
  /** 언어 코드 → 번역문 */
  translations: Record<string, string>;
  latencyMs: number;
}

export type QuotaPressure = 'normal' | 'saving' | 'exhausted';

export interface QuotaStatus {
  used: number;
  limit: number;
  /** 한도 기준 날짜 (태평양 시간, Google 일일 한도 초기화 기준) */
  day: string;
  pressure: QuotaPressure;
  /** 한도 초과로 기다리는 중이면 재시도 시각 (ms) */
  waitUntil: number | null;
  queued: number;
  model: string;
}

export interface StatusMessage {
  level: 'info' | 'warn' | 'error';
  text: string;
  ts: number;
}

/** 저장된 키를 가린 형태 (예: AIza…x9Qk). 없으면 null */
export interface KeyStatus {
  gemini: string | null;
  claude: string | null;
}

export interface StudentLinkStatus {
  enabled: boolean;
  urls: string[];
  clients: number;
  error: string | null;
}

export interface TestResult {
  ok: boolean;
  message: string;
  /** Gemini: 이 키로 쓸 수 있는 모델 목록 */
  models?: string[];
  recommendedModel?: string;
}

/** preload 가 window.api 로 노출하는 기능 */
export interface RendererApi {
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  getKeyStatus(): Promise<KeyStatus>;
  saveKey(provider: KeyProvider, key: string): Promise<KeyStatus>;
  clearKey(provider: KeyProvider): Promise<KeyStatus>;
  testKey(provider: KeyProvider): Promise<TestResult>;
  startSession(): Promise<{ ok: boolean; message: string }>;
  stopSession(): Promise<void>;
  sendSegment(channel: Channel, pcm16k: Float32Array): void;
  getQuota(): Promise<QuotaStatus>;
  getStudentLink(): Promise<StudentLinkStatus>;
  openExternal(url: string): Promise<void>;
  onCaption(cb: (caption: Caption) => void): () => void;
  onQuota(cb: (status: QuotaStatus) => void): () => void;
  onStatus(cb: (msg: StatusMessage) => void): () => void;
  onSettings(cb: (settings: Settings) => void): () => void;
  onStudentLink(cb: (status: StudentLinkStatus) => void): () => void;
  onToggleListening(cb: () => void): () => void;
  /** 키 오류 등으로 수업 듣기가 멈췄을 때 */
  onSessionStopped(cb: (reason: string) => void): () => void;
  onOverlayMoveMode(cb: (on: boolean) => void): () => void;
}
