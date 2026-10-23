import { describe, expect, it } from 'vitest';
import {
  buildClaudeUserPrompt,
  buildSegmentPrompt,
  contextLine,
  parseGlossary,
  parseSegmentResult,
  parseTranslations,
  pickRecommendedGeminiModel,
  scriptMismatch,
  pickQualityGeminiModel,
  isLiteModel,
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

describe('문장 이어받기·말투', () => {
  const base = { studentLanguages: ['vi', 'ru'], glossary: '', context: [] };

  it('앞 구간이 끊겼으면 문장 전체를 번역하라고 알려준다', () => {
    const p = buildSegmentPrompt({ ...base, channel: 'auto', translate: true, continuation: '오늘은 식물이' });
    expect(p).toContain('«오늘은 식물이»');
    expect(p).toContain('translate the WHOLE sentence');
    expect(buildSegmentPrompt({ ...base, channel: 'student', translate: true, continuation: '오늘은' })).not.toContain('«오늘은»');
  });

  it('학급 언어의 교실 말투를 넣는다', () => {
    const p = buildSegmentPrompt({ ...base, channel: 'teacher', translate: true });
    expect(p).toContain('các em');
    expect(p).toContain('"вы"');
    expect(p).not.toContain('同学们');
  });

  it('문맥에 앞 문장의 번역도 넣는다', () => {
    expect(contextLine('광합성을 배워요', { vi: 'Học quang hợp', zh: '学习' }, ['vi'])).toBe('광합성을 배워요 | vi: Học quang hợp');
  });

  it('complete=false 를 읽는다', () => {
    expect(parseSegmentResult('{"lang":"ko","transcript":"오늘은","translations":[],"complete":false}').complete).toBe(false);
    expect(parseSegmentResult('{"lang":"ko","transcript":"오늘은","translations":[]}').complete).toBe(true);
  });
});

describe('parseSegmentResult', () => {
  it('언어 코드를 정리하고 원문 언어와 같은 번역은 뺀다', () => {
    const r = parseSegmentResult(JSON.stringify({ lang: 'ko-KR', transcript: ' 안녕하세요 ', translations: [{ lang: 'zh-CN', text: '你好' }, { lang: 'fil', text: 'Kumusta' }, { lang: 'ko', text: '안녕' }] }));
    expect(r).toEqual({ lang: 'ko', transcript: '안녕하세요', translations: { zh: '你好', tl: 'Kumusta' }, complete: true });
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
  it('scriptMismatch: 붙인 언어와 글자가 맞지 않으면 다시 물을 채널', () => {
    expect(scriptMismatch('ko', 'Thưa cô, em chưa hiểu ạ')).toBe('student');
    expect(scriptMismatch('ko', 'Учитель, я не понял')).toBe('student');
    expect(scriptMismatch('vi', '오늘은 광합성을 배워요')).toBe('teacher');
    expect(scriptMismatch('ko', '오늘은 photosynthesis 를 배워요')).toBeNull();
    expect(scriptMismatch('ru', 'Учитель')).toBeNull();
    expect(scriptMismatch('ko', 'OK')).toBeNull(); // 너무 짧으면 판단하지 않음
  });

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

describe('pickQualityGeminiModel', () => {
  it('Lite 가 아닌 Flash 최신판', () => {
    expect(pickQualityGeminiModel(['models/gemini-3.5-flash-lite', 'models/gemini-3.5-flash', 'models/gemini-3.1-flash', 'models/gemini-3.8-flash-live', 'models/gemini-3.1-pro'])).toBe('gemini-3.5-flash');
    expect(pickQualityGeminiModel(['gemini-3.5-flash-lite'])).toBeUndefined();
    expect(isLiteModel('gemini-3.5-flash-lite')).toBe(true);
    expect(isLiteModel('gemini-3.5-flash')).toBe(false);
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
