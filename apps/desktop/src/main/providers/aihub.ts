// AI 허브 오픈 API: 데이터셋 검색·상세 (AIHub-MCP 가 쓰는 /mcp/*.do 엔드포인트)
// 헤더: X-API-KEY(키) + X-MCP-Tool(도구 이름, 없으면 "잘못된 접근입니다") + X-MCP-Client(호출 프로그램 이름)
// 교사 본인 AI 허브 키로만 호출한다. 받은 데이터는 교사 PC 안에서만 쓴다 (재배포 금지 데이터가 많음).
import { ProviderError, shorten } from './errors';
import type { AihubDataset, AihubDetail, AihubFile, AihubSection } from '../../shared/types';

const BASE = 'https://aihub.or.kr';
const TIMEOUT_MS = 20_000;
const CLIENT_NAME = 'classroom-interpreter';
const MAX_TEXT = 2000;
const MAX_LIST_ROWS = 30;
const MAX_FILES = 400;
const FILE_SECTION = '파일 목록(API 다운로드)';

interface Field<T = unknown> {
  value?: T;
  label?: string;
  description?: string;
}

interface Envelope {
  result?: unknown;
  data?: unknown;
  totalCount?: Record<string, unknown>;
  message?: string;
}

const isField = (v: unknown): v is Field =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as object) && 'label' in (v as object);

const str = (f: unknown): string => {
  const v = (f as Field | undefined)?.value;
  return v === undefined || v === null ? '' : String(v);
};

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', middot: '·' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name: string) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

/** 설명 칸의 HTML(이스케이프된 HTML 포함)을 읽기 쉬운 글로 바꾼다 */
export function cleanText(raw: string, max = MAX_TEXT): string {
  let t = raw;
  // 서버가 HTML 을 한 번 더 이스케이프해 보내는 경우가 있어 두 번 푼다
  for (let i = 0; i < 2 && /&(lt|gt|amp|quot|nbsp|#\d+);/i.test(t); i++) t = decodeEntities(t);
  // HTML 이면 원문 줄바꿈은 의미가 없다 (표 칸마다 줄이 나뉘지 않게). 줄은 <br>·</p>·</tr> 로만 나눈다
  if (/<\/?[a-z][^>]*>/i.test(t)) t = t.replace(/[\r\n]+/g, ' ');
  t = t
    .replace(/<\s*(br|\/p|\/tr|\/li|\/h\d|\/div|\/caption)\b[^>]*>/gi, '\n')
    .replace(/<\s*\/t[dh]\s*>/gi, ' · ')
    .replace(/<[^>]*>/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').replace(/^( · )+|( · )+$/g, '').trim())
    .filter(Boolean)
    .join('\n');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 값 하나를 글로: 목록이면 한 줄에 하나씩, 묶음(Field 들)이면 " · " 로 잇는다 */
function fieldText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) return value.filter((v) => v !== null && v !== '').map(String).join(', ');
    const rows = value.map(rowText).filter(Boolean);
    const more = rows.length > MAX_LIST_ROWS ? `\n… 외 ${rows.length - MAX_LIST_ROWS}개` : '';
    return rows.slice(0, MAX_LIST_ROWS).join('\n') + more;
  }
  if (typeof value === 'object') return rowText(value);
  return cleanText(String(value));
}

function rowText(row: unknown): string {
  if (row === null || row === undefined) return '';
  if (typeof row !== 'object') return cleanText(String(row), 300);
  // Field 로 감싸지 않은 내부 객체(검색 조건 등)는 화면에 의미가 없어 뺀다
  const fields = Object.values(row as Record<string, unknown>).filter(isField);
  return fields
    .filter((f) => !/노출\s*금지/.test(f.description ?? ''))
    .map((f) => (f.value === null || f.value === undefined || typeof f.value === 'object' ? '' : cleanText(String(f.value), 300)))
    .filter(Boolean)
    .join(' · ');
}

export function toDataset(row: Record<string, unknown>): AihubDataset {
  const types = (row.dataTys as Field<unknown[]> | undefined)?.value;
  const size = (row.s3FileSize as Field<unknown> | undefined)?.value;
  return {
    id: str(row.dataSetSn),
    name: str(row.dataNm),
    url: str(row.url) || `${BASE}/aihubdata/data/view.do?dataSetSn=${str(row.dataSetSn)}`,
    realm: str(row.dataRealmNm),
    year: str(row.dataCnstcYear),
    types: Array.isArray(types) ? types.map(String) : [],
    fileSizeBytes: typeof size === 'number' ? size : Number(size) || null,
    downloads: str(row.dwldCnt),
  };
}

/** 상세 응답의 각 묶음(주요 정보·데이터 개요 …)을 "이름: 값" 목록으로 펼친다 */
export function toSections(data: Record<string, unknown>): AihubSection[] {
  const out: AihubSection[] = [];
  for (const [title, section] of Object.entries(data)) {
    if (!section || typeof section !== 'object') continue;
    const fields = isField(section) && section.value && typeof section.value === 'object' && !Array.isArray(section.value)
      ? (section.value as Record<string, unknown>)
      : (section as Record<string, unknown>);
    const items: AihubSection['items'] = [];
    for (const [key, f] of Object.entries(fields)) {
      if (!isField(f) || /노출\s*금지/.test(f.description ?? '')) continue;
      const text = fieldText(f.value);
      if (text) items.push({ key, label: f.label || key, value: text });
    }
    if (items.length > 0) out.push({ title, items });
  }
  return out;
}

/** "파일 목록(API 다운로드)" → 경로·크기 목록 */
export function toFiles(section: unknown): { files: AihubFile[]; count: number; totalBytes: number } {
  const list = (section as { fileList?: Field<unknown[]> } | undefined)?.fileList?.value;
  const rows = Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  const all = rows
    .map((r) => {
      const size = (r.fileSize as Field | undefined)?.value;
      return { path: str(r.fileStreCours) || str(r.streFileNm), size: typeof size === 'number' ? size : Number(size) || 0 };
    })
    .filter((f) => f.path)
    .sort((a, b) => a.path.localeCompare(b.path));
  return { files: all.slice(0, MAX_FILES), count: all.length, totalBytes: all.reduce((s, f) => s + f.size, 0) };
}

export function classifyAihubMessage(message: string): ProviderError {
  // 서버 문구의 "아래 안내 페이지" 는 이 앱에 없으므로 키 화면의 링크로 바꿔 안내한다
  const text = message.replace(/아래 안내 페이지에서/g, "API 키 화면의 'AI 허브에서 API 키 받기'에서").trim();
  if (/키/.test(message)) return new ProviderError('auth', `AI 허브: ${text}`);
  return new ProviderError('other', `AI 허브: ${shorten(text)}`);
}

type Tool = 'searchDataSets' | 'countDataSets' | 'getDataSet';

export class AihubClient {
  /** key 가 null 이면 키 헤더를 붙이지 않는다 (네트워크 시크릿이 대신 붙이는 환경용) */
  constructor(
    private readonly key: string | null,
    private readonly base = BASE,
  ) {}

  private async call(path: string, tool: Tool, params: Record<string, string | number>): Promise<Envelope> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'X-MCP-Client': CLIENT_NAME,
          'X-MCP-Tool': tool,
          ...(this.key ? { 'X-API-KEY': this.key } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProviderError('network', `AI 허브에 연결하지 못했습니다 (${shorten(String(error))})`);
    }
    if (!res.ok) throw new ProviderError(res.status >= 500 ? 'server' : 'other', `AI 허브 응답 오류 (HTTP ${res.status})`);
    let env: Envelope;
    try {
      env = (await res.json()) as Envelope;
    } catch {
      throw new ProviderError('other', 'AI 허브 응답을 읽지 못했습니다');
    }
    if (typeof env.result === 'string' && env.result.toUpperCase() === 'FAIL') throw classifyAihubMessage(env.message ?? '알 수 없는 오류');
    return env;
  }

  private static total(env: Envelope, fallback: number): number {
    const n = env.totalCount?.['총 개수'];
    return typeof n === 'number' ? n : fallback;
  }

  async count(keyword: string): Promise<number> {
    const env = await this.call('/mcp/dataSetCnt.do', 'countDataSets', { searchKeyword: keyword });
    return AihubClient.total(env, 0);
  }

  async search(keyword: string, limit = 20, offset = 0): Promise<{ total: number; items: AihubDataset[] }> {
    const env = await this.call('/mcp/dataSetList.do', 'searchDataSets', { searchKeyword: keyword, firstIndex: offset, recordCountPerPage: limit });
    const list = ((env.data as { list?: Field<unknown[]> } | undefined)?.list?.value ?? []) as Record<string, unknown>[];
    const items = list.map(toDataset).filter((d) => d.id);
    return { total: AihubClient.total(env, items.length), items };
  }

  async detail(id: string): Promise<AihubDetail> {
    if (!/^\d{1,9}$/.test(id)) throw new ProviderError('bad_request', '데이터셋 번호가 올바르지 않습니다');
    const env = await this.call('/mcp/dataSetDetail.do', 'getDataSet', { dataSetSn: id });
    const data = (env.data ?? {}) as Record<string, unknown>;
    const core = (data['주요 정보'] ?? {}) as Record<string, unknown>;
    const summary = (data['데이터 개요'] ?? {}) as Record<string, unknown>;
    const keywords = (core.aiLrnDataMainKwrds as Field<unknown> | undefined)?.value;
    // 설명서·가이드(MD) 원문은 매우 길고, 파일 목록은 따로 정리하므로 일반 묶음에서는 뺀다
    const { ['데이터 설명서']: _manual, ['구축활용가이드']: _guide, [FILE_SECTION]: fileSection, ...rest } = data;
    const files = toFiles(fileSection);
    return {
      id,
      name: str(core.dataNm),
      url: str(core.url) || `${BASE}/aihubdata/data/view.do?dataSetSn=${id}`,
      intro: cleanText(str(summary.dataIntrcn), 800),
      // 키워드는 글자 대신 코드 묶음으로 올 때가 있어 글자인 것만 쓴다
      keywords: (Array.isArray(keywords) ? keywords : keywords ? [keywords] : []).filter((k): k is string => typeof k === 'string' && k.trim() !== ''),
      sections: toSections(rest),
      files: files.files,
      fileCount: files.count,
      fileTotalBytes: files.totalBytes,
    };
  }
}
