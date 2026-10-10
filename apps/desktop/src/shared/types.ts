// main / preload / renderer 가 함께 쓰는 타입과 기본값

/** 마이크 채널: 교사 전용(한국어), 학생 전용, 자동(한 마이크를 같이 씀 → 언어로 구분) */
export type Channel = 'teacher' | 'student' | 'auto';
export type Speaker = 'teacher' | 'student';
export type TranslatorEngine = 'gemini' | 'claude';
export type KeyProvider = 'gemini' | 'claude' | 'aihub';

/** 자막 창을 화면의 어디에 붙일지 (3×3) */
export type OverlayAnchor =
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'middle-center' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

/** 자막 속도: 빠르게(문장마다 바로) / 보통 / 절약(길게 묶어 한도 아낌) */
export type LatencyMode = 'fast' | 'balanced' | 'saving';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Settings {
  geminiModel: string;
  /** 마지막 연결 테스트에서 받은, 이 키로 쓸 수 있는 모델 목록 */
  geminiModels: string[];
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
  /** 마지막으로 고른 위치 버튼 (직접 끌어 옮기면 null) */
  overlayAnchor: OverlayAnchor | null;
  /** 자막 창을 띄울 화면 (null = 프로젝터가 있으면 프로젝터) */
  overlayDisplayId: number | null;
  /** 화면 너비 대비 자막 창 너비 (%) */
  overlayWidthPct: number;
  overlayHeight: number;
  latencyMode: LatencyMode;
  studentLinkEnabled: boolean;
  studentLinkPort: number;
  /** 설정 파일 형식 버전 (이전 버전 기본값을 바꿀 때 사용) */
  settingsVersion: number;
}

export const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS: Settings = {
  geminiModel: 'gemini-3.5-flash-lite',
  geminiModels: [],
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
  requestsPerMinute: 15,
  glossary: '',
  overlayFontSize: 30,
  overlayBounds: null,
  overlayAnchor: 'bottom-center',
  overlayDisplayId: null,
  overlayWidthPct: 90,
  overlayHeight: 280,
  latencyMode: 'fast',
  studentLinkEnabled: false,
  studentLinkPort: 8787,
  settingsVersion: SETTINGS_VERSION,
};

export interface Caption {
  id: string;
  /** 말한 순서 (동시에 여러 요청을 보내므로 화면은 이 순서로 정렬) */
  seq: number;
  ts: number;
  speaker: Speaker;
  /** 말한 언어 (ISO 639-1) */
  lang: string;
  transcript: string;
  /** 언어 코드 → 번역문 */
  translations: Record<string, string>;
  latencyMs: number;
  /** false 면 아직 받는 중 (같은 id 로 다시 온다) */
  final: boolean;
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
  aihub: string | null;
}

/** AI 허브 데이터셋 (검색 결과 한 줄) */
export interface AihubDataset {
  id: string;
  name: string;
  url: string;
  realm: string;
  year: string;
  types: string[];
  fileSizeBytes: number | null;
  downloads: string;
}

export interface AihubSection {
  title: string;
  items: { key: string; label: string; value: string }[];
}

export interface AihubDetail {
  id: string;
  name: string;
  url: string;
  intro: string;
  keywords: string[];
  sections: AihubSection[];
}

export interface AihubSearchResult {
  ok: boolean;
  message: string;
  total: number;
  items: AihubDataset[];
}

export interface StudentLinkStatus {
  enabled: boolean;
  urls: string[];
  clients: number;
  error: string | null;
}

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
}

export interface OverlayPlacement {
  displayId: number | null;
  anchor: OverlayAnchor | null;
  widthPct: number;
  height: number;
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

  // AI 허브 (교사 본인 키)
  aihubSearch(keyword: string): Promise<AihubSearchResult>;
  aihubDetail(id: string): Promise<{ ok: boolean; message: string; detail?: AihubDetail }>;

  // 자막 창 위치·모양
  getDisplays(): Promise<DisplayInfo[]>;
  onDisplays(cb: (displays: DisplayInfo[]) => void): () => void;
  placeOverlay(placement: OverlayPlacement): Promise<void>;
  setOverlayVisible(visible: boolean): Promise<void>;
  onOverlayVisible(cb: (visible: boolean) => void): () => void;
  toggleMoveMode(): Promise<void>;

  // 자막 창(오버레이) 안에서만 쓰는 기능
  setOverlayInteractive(interactive: boolean): void;
  overlayPointer(kind: 'move' | 'resize', phase: 'start' | 'end'): void;
  nudgeOverlayFont(delta: number): void;
}
