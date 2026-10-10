// Gemini·Claude 에 보낼 지시문과 응답 해석 (순수 함수 — 테스트 대상)
import type { Channel, Speaker } from './types';
import { describeForModel, normalizeLanguageCode } from './languages';

export interface SegmentPromptInput {
  channel: Channel;
  studentLanguages: string[];
  /** false 면 받아쓰기만 (번역은 Claude 가 맡을 때) */
  translate: boolean;
  glossary: string;
  /** 직전에 확정된 문장들 (문맥용) */
  context: string[];
}

export const GEMINI_SYSTEM_INSTRUCTION = [
  'You are a real-time interpreter in a Korean school classroom.',
  'You receive short audio clips recorded in the classroom and reply only with JSON that matches the response schema.',
  'Transcribe exactly what is said in the language it is spoken. Do not summarize, explain or add anything.',
  'Translations must be natural, faithful and easy for students to read.',
  'If the clip has no intelligible speech (silence, noise, coughing, music), return an empty lang, an empty transcript and no translations.',
].join('\n');

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

  const glossary = parseGlossary(input.glossary);
  if (glossary.length > 0) {
    lines.push('Classroom terms. Use these translations whenever the term appears:');
    for (const g of glossary) lines.push(`- ${g}`);
  }
  if (input.context.length > 0) {
    lines.push('Previous sentences, for context only. Do not transcribe or translate them again:');
    for (const c of input.context) lines.push(`- ${c}`);
  }
  return lines.join('\n');
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
      },
    },
  },
  required: ['lang', 'transcript', 'translations'],
} as const;

export interface SegmentResult {
  lang: string;
  transcript: string;
  translations: Record<string, string>;
}

/** 모델 응답(JSON 문자열)을 검증·정리한다. 말소리가 없으면 transcript 가 빈 문자열 */
export function parseSegmentResult(text: string | undefined): SegmentResult {
  const empty: SegmentResult = { lang: '', transcript: '', translations: {} };
  if (!text) return empty;
  let data: unknown;
  try {
    data = JSON.parse(stripCodeFence(text));
  } catch {
    return empty;
  }
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
  return { lang, transcript, translations };
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
