import { describe, expect, it } from 'vitest';
import {
  buildClaudeUserPrompt,
  buildSegmentPrompt,
  parseGlossary,
  parseSegmentResult,
  parseTranslations,
  pickRecommendedGeminiModel,
  speakerFor,
  translationTargets,
} from '../src/shared/prompts';
import { normalizeLanguageCode } from '../src/shared/languages';

describe('buildSegmentPrompt', () => {
  const base = { studentLanguages: ['vi', 'uz'], glossary: '광합성 = photosynthesis = quang hợp\n# 주석\n잘못된 줄', context: ['앞 문장'] };

  it('교사 채널: 한국어 고정 + 학생 언어로 번역', () => {
    const p = buildSegmentPrompt({ ...base, channel: 'teacher', translate: true });
    expect(p).toContain('teacher speaking Korean');
    expect(p).toContain('vi (Vietnamese), uz (Uzbek (Latin script))');
    expect(p).toContain('광합성 = photosynthesis = quang hợp');
    expect(p).not.toContain('잘못된 줄');
    expect(p).toContain('- 앞 문장');
  });

  it('자동 채널: 언어를 판별해 방향을 정한다', () => {
    const p = buildSegmentPrompt({ ...base, channel: 'auto', translate: true });
    expect(p).toContain('If the language is Korean');
    expect(p).toContain('Otherwise translate the transcript into Korean (ko)');
  });

  it('번역을 Claude 에 맡기면 받아쓰기만 요청한다', () => {
    const p = buildSegmentPrompt({ ...base, channel: 'student', translate: false });
    expect(p).toContain('Do not translate');
  });
});

describe('parseSegmentResult', () => {
  it('언어 코드를 정리하고 원문 언어와 같은 번역은 뺀다', () => {
    const r = parseSegmentResult(JSON.stringify({ lang: 'ko-KR', transcript: ' 안녕하세요 ', translations: [{ lang: 'zh-CN', text: '你好' }, { lang: 'fil', text: 'Kumusta' }, { lang: 'ko', text: '안녕' }] }));
    expect(r).toEqual({ lang: 'ko', transcript: '안녕하세요', translations: { zh: '你好', tl: 'Kumusta' } });
  });

  it('코드 블록으로 감싼 JSON 도 읽는다', () => {
    expect(parseSegmentResult('```json\n{"lang":"vi","transcript":"Xin chào","translations":[]}\n```').transcript).toBe('Xin chào');
  });

  it('말소리가 없거나 깨진 응답은 빈 결과', () => {
    expect(parseSegmentResult('{"lang":"","transcript":"","translations":[]}').transcript).toBe('');
    expect(parseSegmentResult('not json').transcript).toBe('');
    expect(parseSegmentResult(undefined).transcript).toBe('');
  });
});

describe('언어·화자 판단', () => {
  it('normalizeLanguageCode', () => {
    expect(normalizeLanguageCode('VI')).toBe('vi');
    expect(normalizeLanguageCode('zh_Hans')).toBe('zh');
    expect(normalizeLanguageCode('Vietnamese')).toBe('vi');
    expect(normalizeLanguageCode('')).toBe('');
  });

  it('speakerFor / translationTargets', () => {
    expect(speakerFor('auto', 'ko')).toBe('teacher');
    expect(speakerFor('auto', 'ru')).toBe('student');
    expect(speakerFor('student', 'ko')).toBe('student');
    expect(translationTargets('teacher', 'ko', ['vi', 'zh'])).toEqual(['vi', 'zh']);
    expect(translationTargets('student', 'vi', ['vi', 'zh'])).toEqual(['ko']);
  });
});

describe('Claude 번역 지시문·응답', () => {
  it('용어집과 문맥을 넣는다', () => {
    const p = buildClaudeUserPrompt({ transcript: '광합성', sourceLang: 'ko', targets: ['vi'], glossary: '광합성 = quang hợp', context: ['식물'] });
    expect(p).toContain('Target languages: vi (Vietnamese)');
    expect(p).toContain('- 광합성 = quang hợp');
    expect(p.endsWith('광합성')).toBe(true);
  });

  it('요청한 언어만 남긴다', () => {
    const t = parseTranslations('{"translations":[{"lang":"vi","text":"a"},{"lang":"ja","text":"b"}]}', ['vi']);
    expect(t).toEqual({ vi: 'a' });
  });

  it('parseGlossary 는 60줄까지만', () => {
    expect(parseGlossary(Array.from({ length: 80 }, (_, i) => `a${i} = b`).join('\n'))).toHaveLength(60);
  });
});

describe('pickRecommendedGeminiModel', () => {
  it('안정판 Flash-Lite 최신 버전을 고른다', () => {
    const names = ['models/gemini-2.5-flash', 'models/gemini-3.5-flash-lite', 'models/gemini-3.8-flash-lite-preview', 'models/gemini-3.1-flash-lite', 'models/gemini-3.8-flash-lite-tts', 'models/gemini-3.8-live'];
    expect(pickRecommendedGeminiModel(names)).toBe('gemini-3.5-flash-lite');
  });

  it('Flash-Lite 가 없으면 Flash', () => {
    expect(pickRecommendedGeminiModel(['gemini-3.1-pro', 'gemini-3.5-flash'])).toBe('gemini-3.5-flash');
  });
});
