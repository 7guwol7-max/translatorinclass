// AI 허브 오픈 API: 데이터셋 검색·상세 (AIHub-MCP 가 쓰는 /mcp/*.do 엔드포인트, 헤더 X-API-KEY)
// 교사 본인 AI 허브 키로만 호출한다. 받은 데이터는 교사 PC 안에서만 쓴다 (재배포 금지 데이터가 많음).
import { ProviderError, shorten } from './errors';
import type { AihubDataset, AihubDetail, AihubSection } from '../../shared/types';

const BASE = 'https://aihub.or.kr';
const TIMEOUT_MS = 20_000;

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

const str = (f: unknown): string => {
  const v = (f as Field | undefined)?.value;
  return v === undefined || v === null ? '' : String(v);
};

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

/** 상세 응답의 각 묶음(주요 정보·데이터 개요·파일 목록 …)을 "이름: 값" 목록으로 펼친다 */
export function toSections(data: Record<string, unknown>): AihubSection[] {
  const out: AihubSection[] = [];
  for (const [title, section] of Object.entries(data)) {
    if (!section || typeof section !== 'object') continue;
    const fields = 'value' in (section as object) && typeof (section as Field).value === 'object' && !Array.isArray((section as Field).value)
      ? ((section as Field<Record<string, unknown>>).value ?? {})
      : (section as Record<string, unknown>);
    const items: AihubSection['items'] = [];
    for (const [key, f] of Object.entries(fields)) {
      const field = f as Field;
      if (!field || typeof field !== 'object') continue;
      const value = field.value;
      const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (text) items.push({ key, label: field.label || key, value: text });
    }
    if (items.length > 0) out.push({ title, items });
  }
  return out;
}

export function classifyAihubMessage(message: string): ProviderError {
  // 서버 문구의 "아래 안내 페이지" 는 이 앱에 없으므로 키 화면의 링크로 바꿔 안내한다
  const text = message.replace(/아래 안내 페이지에서/g, "API 키 화면의 'AI 허브에서 API 키 받기'에서").trim();
  if (/키/.test(message)) return new ProviderError('auth', `AI 허브: ${text}`);
  return new ProviderError('other', `AI 허브: ${shorten(text)}`);
}

export class AihubClient {
  /** key 가 null 이면 헤더를 붙이지 않는다 (네트워크 시크릿이 대신 붙이는 환경용) */
  constructor(
    private readonly key: string | null,
    private readonly base = BASE,
  ) {}

  private async call(path: string, params: Record<string, string | number>): Promise<Envelope> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json', ...(this.key ? { 'X-API-KEY': this.key } : {}) },
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
    const env = await this.call('/mcp/dataSetCnt.do', { searchKeyword: keyword });
    return AihubClient.total(env, 0);
  }

  async search(keyword: string, limit = 20, offset = 0): Promise<{ total: number; items: AihubDataset[] }> {
    const env = await this.call('/mcp/dataSetList.do', { searchKeyword: keyword, firstIndex: offset, recordCountPerPage: limit });
    const list = ((env.data as { list?: Field<unknown[]> } | undefined)?.list?.value ?? []) as Record<string, unknown>[];
    const items = list.map(toDataset).filter((d) => d.id);
    return { total: AihubClient.total(env, items.length), items };
  }

  async detail(id: string): Promise<AihubDetail> {
    if (!/^\d{1,9}$/.test(id)) throw new ProviderError('bad_request', '데이터셋 번호가 올바르지 않습니다');
    const env = await this.call('/mcp/dataSetDetail.do', { dataSetSn: id });
    const data = (env.data ?? {}) as Record<string, unknown>;
    const core = (data['주요 정보'] ?? {}) as Record<string, unknown>;
    const summary = (data['데이터 개요'] ?? {}) as Record<string, unknown>;
    const keywords = (core.aiLrnDataMainKwrds as Field<unknown> | undefined)?.value;
    // 설명서(MD) 원문은 매우 길어 화면용 묶음에서는 뺀다
    const { ['데이터 설명서']: _manual, ['구축활용가이드']: _guide, ...rest } = data;
    return {
      id,
      name: str(core.dataNm),
      url: str(core.url) || `${BASE}/aihubdata/data/view.do?dataSetSn=${id}`,
      intro: str(summary.dataIntrcn).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      keywords: Array.isArray(keywords) ? keywords.map(String) : keywords ? [String(keywords)] : [],
      sections: toSections(rest),
    };
  }
}
