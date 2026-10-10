// 학급에서 자주 쓰일 언어 목록 (ISO 639-1 코드)

export interface LanguageInfo {
  code: string;
  /** 한국어 이름 (교사 화면) */
  ko: string;
  /** 그 언어로 쓴 이름 (학생 화면) */
  native: string;
  /** 모델에 넘길 영어 이름 */
  en: string;
  rtl?: boolean;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: 'ko', ko: '한국어', native: '한국어', en: 'Korean' },
  { code: 'zh', ko: '중국어', native: '中文', en: 'Chinese (Simplified)' },
  { code: 'vi', ko: '베트남어', native: 'Tiếng Việt', en: 'Vietnamese' },
  { code: 'ru', ko: '러시아어', native: 'Русский', en: 'Russian' },
  { code: 'uz', ko: '우즈베크어', native: 'Oʻzbekcha', en: 'Uzbek (Latin script)' },
  { code: 'mn', ko: '몽골어', native: 'Монгол', en: 'Mongolian (Cyrillic script)' },
  { code: 'en', ko: '영어', native: 'English', en: 'English' },
  { code: 'ja', ko: '일본어', native: '日本語', en: 'Japanese' },
  { code: 'tl', ko: '필리핀어(타갈로그어)', native: 'Tagalog', en: 'Filipino (Tagalog)' },
  { code: 'th', ko: '태국어', native: 'ไทย', en: 'Thai' },
  { code: 'km', ko: '크메르어(캄보디아)', native: 'ខ្មែរ', en: 'Khmer' },
  { code: 'id', ko: '인도네시아어', native: 'Bahasa Indonesia', en: 'Indonesian' },
  { code: 'ne', ko: '네팔어', native: 'नेपाली', en: 'Nepali' },
  { code: 'kk', ko: '카자흐어', native: 'Қазақша', en: 'Kazakh' },
  { code: 'ky', ko: '키르기스어', native: 'Кыргызча', en: 'Kyrgyz' },
  { code: 'uk', ko: '우크라이나어', native: 'Українська', en: 'Ukrainian' },
  { code: 'my', ko: '미얀마어', native: 'မြန်မာ', en: 'Burmese' },
  { code: 'bn', ko: '벵골어', native: 'বাংলা', en: 'Bengali' },
  { code: 'hi', ko: '힌디어', native: 'हिन्दी', en: 'Hindi' },
  { code: 'ur', ko: '우르두어', native: 'اردو', en: 'Urdu', rtl: true },
  { code: 'ar', ko: '아랍어', native: 'العربية', en: 'Arabic', rtl: true },
  { code: 'fa', ko: '페르시아어', native: 'فارسی', en: 'Persian', rtl: true },
  { code: 'tr', ko: '튀르키예어', native: 'Türkçe', en: 'Turkish' },
  { code: 'es', ko: '스페인어', native: 'Español', en: 'Spanish' },
  { code: 'pt', ko: '포르투갈어', native: 'Português', en: 'Portuguese' },
  { code: 'fr', ko: '프랑스어', native: 'Français', en: 'French' },
  { code: 'de', ko: '독일어', native: 'Deutsch', en: 'German' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

/** 학생 언어로 고를 수 있는 언어 (한국어 제외) */
export const STUDENT_LANGUAGES = LANGUAGES.filter((l) => l.code !== 'ko');

export function languageInfo(code: string): LanguageInfo | undefined {
  return BY_CODE.get(code);
}

export function isKnownLanguage(code: string): boolean {
  return BY_CODE.has(code);
}

const ALIASES: Record<string, string> = {
  fil: 'tl',
  'zh-cn': 'zh',
  'zh-hans': 'zh',
  cmn: 'zh',
  kor: 'ko',
  vie: 'vi',
  rus: 'ru',
  uzb: 'uz',
  mon: 'mn',
  khm: 'km',
};

/** 모델이 돌려준 언어 표기(zh-CN, fil, Vietnamese 등)를 목록의 코드로 맞춘다 */
export function normalizeLanguageCode(raw: string): string {
  const value = raw.trim().toLowerCase().replace('_', '-');
  if (!value) return '';
  if (BY_CODE.has(value)) return value;
  if (ALIASES[value]) return ALIASES[value];
  const base = value.split('-')[0];
  if (BY_CODE.has(base)) return base;
  if (ALIASES[base]) return ALIASES[base];
  const byName = LANGUAGES.find((l) => l.en.toLowerCase().startsWith(value) || l.ko === raw.trim());
  return byName ? byName.code : value;
}

export function describeForModel(codes: string[]): string {
  return codes.map((c) => `${c} (${languageInfo(c)?.en ?? c})`).join(', ');
}
