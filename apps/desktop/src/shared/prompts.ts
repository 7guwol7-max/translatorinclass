// Gemini·Claude 에 보낼 지시문과 응답 해석 (순수 함수 — 테스트 대상)
import type { Channel, Speaker } from './types';
import { describeForModel, normalizeLanguageCode } from './languages';
import { parsePartialJson } from './partial-json';

export interface SegmentPromptInput {
  channel: Channel;
  studentLanguages: string[];
  /** false 면 받아쓰기만 (번역은 Claude 가 맡을 때) */
  translate: boolean;
  glossary: string;
  /** 직전에 확정된 문장들과 그 번역 (문맥·용어 일관성용) */
  context: string[];
  /** 앞 구간이 문장 중간에서 끊겼으면 그 한국어 (이번 구간이 이어서 말하는 부분일 때 문장 전체를 번역) */
  continuation?: string;
}

export const GEMINI_SYSTEM_INSTRUCTION = [
  'You are a skilled real-time interpreter in a Korean school classroom.',
  'You receive short audio clips recorded in the classroom and reply only with JSON that matches the response schema.',
  'Transcribe exactly what is said in the language it is spoken. Do not summarize, explain or add anything.',
  'Translate like a human interpreter, not word by word: convey the meaning in the way a native speaker of the target language would say it in class.',
  'Use clear, friendly and polite spoken language that school students understand. Keep the speaker\'s tone (questions stay questions, instructions stay instructions).',
  'Korean drops subjects and objects; fill them in naturally from context instead of translating literally. Translate Korean fillers (음, 자, 그러니까) only if they carry meaning.',
  'Keep terms consistent with the previous sentences and the glossary.',
  'Speech is cut at pauses, so a clip may be only part of a sentence. Translate such a fragment naturally without inventing the missing part, and set complete to false.',
  'If the clip has no intelligible speech (silence, noise, coughing, music), return an empty lang, an empty transcript and no translations.',
].join('\n');

/** 언어별 교실 말투 (학생에게 말할 때) */
const STYLE_NOTES: Record<string, string> = {
  vi: 'Vietnamese: the teacher speaks to the class; address students as "các em" and keep a warm, polite classroom tone.',
  zh: 'Chinese: use Simplified Chinese; address the class as "同学们" when the teacher speaks to everyone.',
  ru: 'Russian: address the class with the plural "вы" and use natural spoken school Russian.',
  uz: 'Uzbek: use the Latin script and address the class politely with "siz".',
  mn: 'Mongolian: use the Cyrillic script and a polite classroom tone.',
  ja: 'Japanese: use polite です/ます form.',
  en: 'English: use simple, clear classroom English.',
  tl: 'Filipino: use natural Tagalog as spoken to students (Taglish is fine for school terms).',
  kk: 'Kazakh: use the Cyrillic script and the polite "сіз".',
  ky: 'Kyrgyz: use the Cyrillic script and the polite "сиз".',
};

export function buildSegmentPrompt(input: SegmentPromptInput): string {
  const students = describeForModel(input.studentLanguages);
  const lines: string[] = [];

  if (input.channel === 'teacher') {
    lines.push('This clip is the teacher speaking Korean (ko). Set lang to "ko" and transcribe it in Korean.');
    lines.push(input.translate
      ? `Translate the transcript into each of these languages: ${students}.`
      : 'Do not translate. Return an empty translations list.');
  } else if (input.channel === 'student') {
    lines.push(`This clip is a student. The student most likely speaks one of: ${students}. The student may also speak Korean.`);
    lines.push('Identify the spoken language, set lang to its ISO 639-1 code and transcribe it in that language.');
    lines.push(input.translate
      ? 'If the language is not Korean, translate the transcript into Korean (ko). If it is Korean, return an empty translations list.'
      : 'Do not translate. Return an empty translations list.');
  } else {
    lines.push(`This clip is either the teacher speaking Korean (ko) or a student speaking one of: ${students}.`);
    lines.push('Identify the spoken language, set lang to its ISO 639-1 code and transcribe it in that language.');
    lines.push(input.translate
      ? `If the language is Korean, translate the transcript into each of: ${students}. Otherwise translate the transcript into Korean (ko).`
      : 'Do not translate. Return an empty translations list.');
  }

  if (input.continuation && input.channel !== 'student') {
    lines.push(`The previous clip stopped in the middle of the teacher's Korean sentence: «${input.continuation}»`);
    lines.push('If this clip is Korean and continues that sentence: transcribe only this clip, but translate the WHOLE sentence (previous part + this clip) as one natural sentence.');
  }
  lines.push('Set complete to true if the transcript ends at the end of a sentence or question, false if the speaker stopped mid-sentence.');

  if (input.translate) {
    const notes = input.studentLanguages.map((l) => STYLE_NOTES[l]).filter(Boolean);
    if (notes.length > 0) {
      lines.push('Style for each language:');
      for (const n of notes) lines.push(`- ${n}`);
    }
  }
  const glossary = parseGlossary(input.glossary);
  if (glossary.length > 0) {
    lines.push('Classroom terms. Use these translations whenever the term appears:');
    for (const g of glossary) lines.push(`- ${g}`);
  }
  if (input.context.length > 0) {
    lines.push('Previous sentences and their translations, for context and consistent wording only. Do not transcribe or translate them again:');
    for (const c of input.context) lines.push(`- ${c}`);
  }
  return lines.join('\n');
}

/** 문맥 한 줄: "ko: … | vi: … | zh: …" (너무 길면 자른다) */
export function contextLine(transcript: string, translations: Record<string, string>, langs: string[]): string {
  const cut = (t: string) => (t.length > 160 ? `${t.slice(0, 160)}…` : t);
  const parts = [`${cut(transcript)}`];
  for (const l of langs) if (translations[l]) parts.push(`${l}: ${cut(translations[l])}`);
  return parts.join(' | ');
}

/** "광합성 = photosynthesis = quang hợp" 형태의 줄만 남긴다 */
export function parseGlossary(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && l.includes('='))
    .slice(0, 60);
}

/** Gemini responseSchema (OpenAPI 부분집합). translations 는 언어별 객체 대신 배열로 받는다 */
export const SEGMENT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lang: { type: 'STRING', description: 'ISO 639-1 code of the spoken language, e.g. ko, vi, zh, ru. Empty if no speech.' },
    transcript: { type: 'STRING' },
    translations: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          lang: { type: 'STRING', description: 'ISO 639-1 code of the target language' },
          text: { type: 'STRING' },
        },
        required: ['lang', 'text'],
        propertyOrdering: ['lang', 'text'],
      },
    },
    complete: { type: 'BOOLEAN', description: 'true if the transcript ends at the end of a sentence or question; false if it stops mid-sentence' },
  },
  required: ['lang', 'transcript', 'translations', 'complete'],
  // 언어 → 받아쓰기 → 번역 순서로 받아야 스트리밍 중에 받아쓰기부터 먼저 보여줄 수 있다
  propertyOrdering: ['lang', 'transcript', 'translations', 'complete'],
} as const;

export interface SegmentResult {
  lang: string;
  transcript: string;
  translations: Record<string, string>;
  /** false 면 문장 중간에서 끊긴 구간 (없으면 끝난 것으로 본다) */
  complete?: boolean;
}

/** 모델 응답(JSON 문자열)을 검증·정리한다. 말소리가 없으면 transcript 가 빈 문자열 */
export function parseSegmentResult(text: string | undefined): SegmentResult {
  if (!text) return emptyResult();
  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(text));
  } catch {
    return emptyResult();
  }
  return normalizeSegment(data);
}

/** 스트리밍으로 받는 중인 응답에서 지금까지 나온 부분 (받아쓰기가 아직 없으면 빈 결과) */
export function parsePartialSegment(prefix: string): SegmentResult {
  const body = prefix.trim().replace(/^```(?:json)?\s*/, '');
  return normalizeSegment(parsePartialJson(body));
}

function emptyResult(): SegmentResult {
  return { lang: '', transcript: '', translations: {} };
}

function normalizeSegment(data: unknown): SegmentResult {
  const empty = emptyResult();
  if (!data || typeof data !== 'object') return empty;
  const obj = data as Record<string, unknown>;
  const transcript = typeof obj.transcript === 'string' ? obj.transcript.trim() : '';
  const lang = typeof obj.lang === 'string' ? normalizeLanguageCode(obj.lang) : '';
  const translations: Record<string, string> = {};
  if (Array.isArray(obj.translations)) {
    for (const item of obj.translations) {
      if (!item || typeof item !== 'object') continue;
      const t = item as Record<string, unknown>;
      if (typeof t.lang !== 'string' || typeof t.text !== 'string') continue;
      const code = normalizeLanguageCode(t.lang);
      const value = t.text.trim();
      if (code && value && code !== lang) translations[code] = value;
    }
  }
  if (!transcript) return empty;
  return { lang, transcript, translations, complete: obj.complete !== false };
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return m ? m[1] : trimmed;
}

/** 말한 언어로 화자 판단 (교사 채널은 항상 교사, 학생 채널은 항상 학생) */
export function speakerFor(channel: Channel, lang: string): Speaker {
  if (channel === 'teacher') return 'teacher';
  if (channel === 'student') return 'student';
  return lang === 'ko' ? 'teacher' : 'student';
}

/** 번역해야 할 언어 목록 (Claude 번역 모드에서 사용) */
export function translationTargets(speaker: Speaker, lang: string, studentLanguages: string[]): string[] {
  if (speaker === 'teacher' || lang === 'ko') return studentLanguages.filter((l) => l !== 'ko');
  return ['ko'];
}

// ── Claude 번역 ──────────────────────────────────────────────

export const CLAUDE_SYSTEM_PROMPT = [
  'You translate live speech in a Korean school classroom.',
  'Translate the given transcript faithfully and naturally, at a level students can follow.',
  'Keep names, numbers and classroom terms consistent with the glossary.',
  'Reply only with JSON that matches the output schema: one entry per requested target language.',
].join('\n');

export function buildClaudeUserPrompt(input: {
  transcript: string;
  sourceLang: string;
  targets: string[];
  glossary: string;
  context: string[];
}): string {
  const lines = [
    `Source language: ${describeForModel([input.sourceLang])}`,
    `Target languages: ${describeForModel(input.targets)}`,
  ];
  const glossary = parseGlossary(input.glossary);
  if (glossary.length > 0) {
    lines.push('Glossary:');
    for (const g of glossary) lines.push(`- ${g}`);
  }
  if (input.context.length > 0) {
    lines.push('Previous sentences (context only, do not translate):');
    for (const c of input.context) lines.push(`- ${c}`);
  }
  lines.push('Transcript to translate:', input.transcript);
  return lines.join('\n');
}

export const CLAUDE_TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { lang: { type: 'string' }, text: { type: 'string' } },
        required: ['lang', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
} as const;

export function parseTranslations(text: string | undefined, allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  try {
    const data = JSON.parse(stripCodeFence(text)) as { translations?: unknown };
    if (!Array.isArray(data.translations)) return out;
    for (const item of data.translations) {
      if (!item || typeof item !== 'object') continue;
      const t = item as Record<string, unknown>;
      if (typeof t.lang !== 'string' || typeof t.text !== 'string') continue;
      const code = normalizeLanguageCode(t.lang);
      if (allowed.includes(code) && t.text.trim()) out[code] = t.text.trim();
    }
  } catch {
    // 잘못된 JSON 이면 번역 없음으로 처리
  }
  return out;
}

/** 번역 품질 우선: Lite 가 아닌 Flash 안정판의 최신 버전 (없으면 undefined) */
export function pickQualityGeminiModel(names: string[]): string | undefined {
  const ids = names.map((n) => n.replace(/^models\//, ''));
  const usable = ids.filter((id) => /^gemini-\d+(\.\d+)?-flash(-\d+)?$/.test(id) || /^gemini-\d+(\.\d+)?-flash$/.test(id));
  const version = (id: string) => Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  return usable.sort((a, b) => version(b) - version(a))[0];
}

export function isLiteModel(model: string): boolean {
  return model.includes('flash-lite');
}

/** 키 목록에서 무료 등급 기본값으로 쓸 모델을 고른다: 안정판 Flash-Lite 의 최신 버전 우선 */
export function pickRecommendedGeminiModel(names: string[]): string | undefined {
  const ids = names.map((n) => n.replace(/^models\//, ''));
  const usable = ids.filter((id) => id.startsWith('gemini-') && !/(tts|live|image|embedding|audio|robotics|computer|thinking)/.test(id));
  const score = (id: string) => {
    const version = Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
    const lite = id.includes('flash-lite') ? 2 : id.includes('flash') ? 1 : 0;
    const stable = /(preview|exp|latest)/.test(id) ? 0 : 1;
    return lite * 1000 + stable * 100 + version;
  };
  return usable.sort((a, b) => score(b) - score(a))[0];
}
