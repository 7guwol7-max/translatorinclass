// Live 모드에서 main 과 화면이 같이 쓰는 순수 함수 (테스트 대상)
import type { Channel } from './types';

/** 기본 Live 번역 모델 (키 목록에 없으면 목록에서 고른다) */
export const DEFAULT_LIVE_MODEL = 'gemini-3.5-live-translate-preview';

/**
 * 채널마다 열 Live 세션의 목표 언어. 실시간 번역 모델은 세션 하나가 목표 언어 하나만 맡는다.
 * - 교사 마이크: 한국어 → 학생 언어마다 하나
 * - 학생 마이크: 학생 말 → 한국어 하나
 * - 함께 쓰는 마이크: 둘 다 (자기 언어로 말하면 그 세션은 아무것도 내지 않는다)
 */
export function liveTargets(channel: Channel, studentLanguages: string[]): string[] {
  const langs = [...new Set(studentLanguages.filter((l) => l && l !== 'ko'))];
  if (channel === 'teacher') return langs;
  if (channel === 'student') return ['ko'];
  return [...langs, 'ko'];
}

/** 이 키의 Live 모델 중 실시간 번역 모델 (안정판 먼저, 최신 버전 먼저) */
export function liveTranslateModels(names: string[]): string[] {
  const version = (id: string) => Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  return [...new Set(names.map((n) => n.replace(/^models\//, '')))]
    .filter((id) => /live/.test(id) && /translate/.test(id))
    .sort((a, b) => Number(/preview|exp/.test(a)) - Number(/preview|exp/.test(b)) || version(b) - version(a));
}

/** 쓸 Live 모델: 지금 고른 것이 목록에 있으면 그대로, 아니면 목록의 첫 번역 모델 (목록이 비었으면 그대로) */
export function pickLiveModel(names: string[], current: string): string {
  const usable = liveTranslateModels(names);
  if (usable.length === 0 || usable.includes(current)) return current;
  return usable[0];
}

/** 받아쓰기 조각을 잇는다. 서버가 지금까지의 전체를 다시 보내면 바꿔 쓴다 */
export function joinTranscript(prev: string, next: string): string {
  if (!prev) return next;
  if (next.length > prev.length && next.startsWith(prev)) return next;
  return prev + next;
}

const VIETNAMESE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
const LATIN_LANGS = ['vi', 'en', 'uz', 'tl', 'id', 'tr', 'es', 'pt', 'fr', 'de'];
const CYRILLIC_LANGS = ['ru', 'mn', 'kk', 'ky', 'uk'];

/**
 * 받아쓴 글의 글자로 언어를 짐작한다 (Live 가 언어 코드를 안 줄 때). candidates 는 이 학급에서 나올 수 있는 언어.
 * 모르겠으면 ''.
 */
export function guessLanguage(text: string, candidates: string[]): string {
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length < 2) return '';
  const share = (re: RegExp) => letters.filter((ch) => re.test(ch)).length / letters.length;
  const among = (langs: string[]) => langs.filter((l) => candidates.includes(l));
  const only = (langs: string[]) => (among(langs).length === 1 ? among(langs)[0] : '');

  if (share(/\p{Script=Hangul}/u) > 0.5) return 'ko';
  if (share(/[\p{Script=Hiragana}\p{Script=Katakana}]/u) > 0.1) return 'ja';
  if (share(/\p{Script=Han}/u) > 0.5) return candidates.includes('zh') || !candidates.includes('ja') ? 'zh' : 'ja';
  if (share(/\p{Script=Cyrillic}/u) > 0.5) {
    if (/[әғқңұһі]/i.test(text) && candidates.includes('kk')) return 'kk';
    if (/[өү]/i.test(text) && candidates.includes('mn')) return 'mn';
    if (/[їєґ]/i.test(text) && candidates.includes('uk')) return 'uk';
    return among(CYRILLIC_LANGS)[0] ?? 'ru';
  }
  const scripts: [RegExp, string[]][] = [
    [/\p{Script=Thai}/u, ['th']],
    [/\p{Script=Khmer}/u, ['km']],
    [/\p{Script=Myanmar}/u, ['my']],
    [/\p{Script=Bengali}/u, ['bn']],
    [/\p{Script=Devanagari}/u, ['ne', 'hi']],
    [/\p{Script=Arabic}/u, ['ur', 'ar', 'fa']],
  ];
  for (const [re, langs] of scripts) if (share(re) > 0.5) return among(langs)[0] ?? langs[0];
  if (share(/\p{Script=Latin}/u) > 0.5) {
    if (VIETNAMESE.test(text) && candidates.includes('vi')) return 'vi';
    return only(LATIN_LANGS.filter((l) => l !== 'vi' || VIETNAMESE.test(text)));
  }
  return '';
}
