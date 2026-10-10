import { afterEach, describe, expect, it, vi } from 'vitest';
import { AihubClient, classifyAihubMessage, toDataset, toSections } from '../src/main/providers/aihub';
import { ProviderError } from '../src/main/providers/errors';

const f = <T>(value: T, label = '') => ({ value, label, description: '' });

const row = {
  dataSetSn: f('71686', '데이터셋 번호'),
  dataNm: f('한국어-러시아어 번역 말뭉치', '데이터명'),
  dataRealmNm: f('한국어', '분야'),
  dataCnstcYear: f('2023', '구축년도'),
  dataTys: f(['텍스트'], '데이터 유형'),
  s3FileSize: f(1048576, '파일 크기'),
  dwldCnt: f('120', '다운로드 수'),
};

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('toDataset / toSections', () => {
  it('Field 로 감싼 목록 한 줄을 펼친다', () => {
    expect(toDataset(row)).toEqual({
      id: '71686',
      name: '한국어-러시아어 번역 말뭉치',
      url: 'https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=71686',
      realm: '한국어',
      year: '2023',
      types: ['텍스트'],
      fileSizeBytes: 1048576,
      downloads: '120',
    });
  });

  it('비어 있는 값은 빼고, 목록·객체 값은 글자로 바꾼다', () => {
    const sections = toSections({
      '구축 업체': { orgNm: f('A사', '기관'), empty: f(null, '빈 값') },
      '파일 목록(API 다운로드)': { files: f([{ fileNm: 'a.zip' }], '파일') },
      '빈 묶음': {},
    });
    expect(sections).toEqual([
      { title: '구축 업체', items: [{ key: 'orgNm', label: '기관', value: 'A사' }] },
      { title: '파일 목록(API 다운로드)', items: [{ key: 'files', label: '파일', value: '[{"fileNm":"a.zip"}]' }] },
    ]);
  });

  it('키 관련 실패 문구는 auth 로 분류한다', () => {
    expect(classifyAihubMessage('API 키가 없습니다.').kind).toBe('auth');
    expect(classifyAihubMessage('잠시 후 다시').kind).toBe('other');
    expect(classifyAihubMessage('유효하지 않은 API 키입니다. 아래 안내 페이지에서 API 키를 확인해 주세요.').message).toBe(
      "AI 허브: 유효하지 않은 API 키입니다. API 키 화면의 'AI 허브에서 API 키 받기'에서 API 키를 확인해 주세요.",
    );
  });
});

describe('AihubClient', () => {
  it('검색: X-API-KEY 헤더·검색어를 보내고 목록과 총 개수를 돌려준다', async () => {
    const fetchFn = mockFetch({ result: 'SUCCESS', data: { list: f([row, { dataNm: f('번호 없음') }]) }, totalCount: { '총 개수': 37 } });
    const r = await new AihubClient('k-123').search('러시아어 번역', 10, 20);
    expect(r.total).toBe(37);
    expect(r.items.map((d) => d.id)).toEqual(['71686']);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url.pathname).toBe('/mcp/dataSetList.do');
    expect(url.searchParams.get('searchKeyword')).toBe('러시아어 번역');
    expect(url.searchParams.get('recordCountPerPage')).toBe('10');
    expect(url.searchParams.get('firstIndex')).toBe('20');
    expect((init?.headers as Record<string, string>)['X-API-KEY']).toBe('k-123');
  });

  it('키가 없으면 헤더를 붙이지 않는다', async () => {
    const fetchFn = mockFetch({ data: { list: f([]) } });
    await new AihubClient(null).search('번역');
    expect((fetchFn.mock.calls[0][1]?.headers as Record<string, string>)['X-API-KEY']).toBeUndefined();
  });

  it('상세: 주요 정보·개요를 읽고 설명서 원문은 뺀다', async () => {
    mockFetch({
      data: {
        '주요 정보': { dataNm: f('러시아어 말뭉치', '데이터명'), aiLrnDataMainKwrds: f(['번역', '러시아어'], '키워드') },
        '데이터 개요': { dataIntrcn: f('<p>한국어와 <b>러시아어</b></p>  문장 쌍', '소개') },
        '파일 목록(API 다운로드)': { fileCnt: f(3, '파일 수') },
        '데이터 설명서': f({ cnvrCn: f('# 아주 긴 설명서') }),
        '구축활용가이드': f({ cnvrCn: f('# 가이드') }),
      },
    });
    const d = await new AihubClient('k').detail('71686');
    expect(d.name).toBe('러시아어 말뭉치');
    expect(d.intro).toBe('한국어와 러시아어 문장 쌍');
    expect(d.keywords).toEqual(['번역', '러시아어']);
    expect(d.sections.map((s) => s.title)).toEqual(['주요 정보', '데이터 개요', '파일 목록(API 다운로드)']);
    expect(JSON.stringify(d.sections)).not.toContain('아주 긴 설명서');
  });

  it('상세: 숫자가 아닌 번호는 요청하지 않는다', async () => {
    const fetchFn = mockFetch({});
    await expect(new AihubClient('k').detail('../x')).rejects.toBeInstanceOf(ProviderError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('FAIL 응답·HTTP 오류·연결 실패를 ProviderError 로 바꾼다', async () => {
    mockFetch({ result: 'FAIL', message: '유효하지 않은 API 키입니다.' });
    await expect(new AihubClient('bad').count('번역')).rejects.toMatchObject({ kind: 'auth' });

    mockFetch({}, 503);
    await expect(new AihubClient('k').count('번역')).rejects.toMatchObject({ kind: 'server' });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(new AihubClient('k').count('번역')).rejects.toMatchObject({ kind: 'network' });
  });

  it('count 는 총 개수를 읽는다', async () => {
    mockFetch({ totalCount: { '총 개수': 12 } });
    expect(await new AihubClient('k').count('번역')).toBe(12);
  });
});
