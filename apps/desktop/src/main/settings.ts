// 설정 저장/불러오기 (userData/settings.json). 들어온 값은 항상 검증해서 저장한다.
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Bounds, type Settings } from '../shared/types';
import { isKnownLanguage } from '../shared/languages';

const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{1,80}$/;

export function sanitizeSettings(input: Partial<Settings>, base: Settings = DEFAULT_SETTINGS): Settings {
  const s: Settings = { ...base };
  const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const int = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : undefined;

  const gm = str(input.geminiModel)?.trim();
  if (gm && MODEL_ID.test(gm)) s.geminiModel = gm;
  const gf = str(input.geminiFallbackModel)?.trim();
  if (gf !== undefined && (gf === '' || MODEL_ID.test(gf))) s.geminiFallbackModel = gf;
  if (input.translator === 'gemini' || input.translator === 'claude') s.translator = input.translator;
  const cm = str(input.claudeModel)?.trim();
  if (cm && MODEL_ID.test(cm)) s.claudeModel = cm;

  if (Array.isArray(input.studentLanguages)) {
    const langs = [...new Set(input.studentLanguages.filter((l): l is string => typeof l === 'string' && isKnownLanguage(l) && l !== 'ko'))];
    if (langs.length > 0) s.studentLanguages = langs.slice(0, 10);
  }
  const overlay = Array.isArray(input.overlayLanguages) ? input.overlayLanguages : s.overlayLanguages;
  s.overlayLanguages = [...new Set(overlay.filter((l): l is string => typeof l === 'string' && s.studentLanguages.includes(l)))].slice(0, 3);

  if (typeof input.showKoreanOnOverlay === 'boolean') s.showKoreanOnOverlay = input.showKoreanOnOverlay;
  const tm = str(input.teacherMicId, 300);
  if (tm !== undefined) s.teacherMicId = tm;
  const sm = str(input.studentMicId, 300);
  if (sm !== undefined) s.studentMicId = sm;
  if (input.teacherMicMode === 'teacher' || input.teacherMicMode === 'auto') s.teacherMicMode = input.teacherMicMode;
  s.dailyRequestLimit = int(input.dailyRequestLimit, 1, 100_000) ?? s.dailyRequestLimit;
  s.requestsPerMinute = int(input.requestsPerMinute, 1, 1_000) ?? s.requestsPerMinute;
  const glossary = str(input.glossary, 20_000);
  if (glossary !== undefined) s.glossary = glossary;
  s.overlayFontSize = int(input.overlayFontSize, 16, 96) ?? s.overlayFontSize;
  if (input.overlayBounds === null) s.overlayBounds = null;
  else if (isBounds(input.overlayBounds)) s.overlayBounds = input.overlayBounds;
  if (typeof input.studentLinkEnabled === 'boolean') s.studentLinkEnabled = input.studentLinkEnabled;
  s.studentLinkPort = int(input.studentLinkPort, 1024, 65535) ?? s.studentLinkPort;
  return s;
}

function isBounds(v: unknown): v is Bounds {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]));
}

export class SettingsStore {
  private current: Settings;
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, 'settings.json');
    let loaded: Partial<Settings> = {};
    try {
      loaded = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>;
    } catch {
      // 처음 실행이거나 파일이 깨졌으면 기본값
    }
    this.current = sanitizeSettings(loaded, DEFAULT_SETTINGS);
  }

  get(): Settings {
    return this.current;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.current = sanitizeSettings(patch, this.current);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.current, null, 2), 'utf8');
    return this.current;
  }
}
