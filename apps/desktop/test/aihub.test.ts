import { afterEach, describe, expect, it, vi } from 'vitest';
import { AihubClient, classifyAihubMessage, cleanText, toDataset, toFiles, toSections } from '../src/main/providers/aihub';
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

  it('빈 값·노출 금지 칸은 빼고, Field 묶음 목록은 한 줄씩 펼친다', () => {
    const sections = toSections({
      '주요 정보': {
        dataSetSn: { value: '71686', label: '데이터셋 일련번호', description: '노출 금지' },
        empty: f(null, '빈 값'),
        dataTys: f(['오디오', '텍스트'], '유형'),
        // 실제 응답처럼 Field 로 감싸지 않은 검색 조건 객체는 화면에 의미가 없다
        aiLrnDataMainKwrds: f([{ searchKeyword: '', pageIndex: 1, codeId: 'DRELM015' }], '주요 키워드'),
      },
      '구축 업체': {
        mnnstList: f([{ mnnstNm: f('A사', '주관 수행사'), chrgJob: f('데이터 구축', '담당업무') }, { mnnstNm: f('B사', '주관 수행사') }], '수행기관'),
      },
      '빈 묶음': {},
    });
    expect(sections).toEqual([{ title: '주요 정보', items: [{ key: 'dataTys', label: '유형', value: '오디오, 텍스트' }] }, { title: '구축 업체', items: [{ key: 'mnnstList', label: '수행기관', value: 'A사 · 데이터 구축\nB사' }] }]);
  });

  it('cleanText: 이스케이프된 HTML·표를 읽기 쉬운 줄로 바꾸고 길이를 자른다', () => {
    expect(cleanText('<p>&lt;strong&gt;- 데이터 통계<br />\n&nbsp; - 구축 규모&lt;/strong&gt;<br />\n원천 음성 1,250시간</p>')).toBe('- 데이터 통계\n- 구축 규모\n원천 음성 1,250시간');
    expect(cleanText('&lt;table&gt;&lt;tr&gt;&lt;td&gt;구분&lt;/td&gt;&lt;td&gt;건수&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;')).toBe('구분 · 건수');
    expect(cleanText('<table><tr>\n<td>구분</td>\n<td>건수</td>\n</tr><tr><td>전사</td><td>10,132건</td></tr></table>')).toBe('구분 · 건수\n전사 · 10,132건');
    expect(cleanText('- 첫 줄\r\n- 둘째 줄')).toBe('- 첫 줄\n- 둘째 줄');
    expect(cleanText('가'.repeat(30), 10)).toBe(`${'가'.repeat(10)}…`);
  });

  it('toFiles: 경로순으로 정리하고 개수·전체 크기를 센다', () => {
    const file = (path: string, size: number) => ({ fileSn: f(1), fileSize: f(size), fileStreCours: f(path), streFileNm: f(path.split('/').pop()) });
    const r = toFiles({ fileList: f([file('D/1.Training/b.zip', 200), file('D/1.Training/a.zip', 100), { fileSn: f(3) }], '파일 목록') });
    expect(r).toEqual({ files: [{ path: 'D/1.Training/a.zip', size: 100 }, { path: 'D/1.Training/b.zip', size: 200 }], count: 2, totalBytes: 300 });
    expect(toFiles(undefined)).toEqual({ files: [], count: 0, totalBytes: 0 });
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
  it('검색: 키·도구 헤더와 검색어를 보내고 목록과 총 개수를 돌려준다', async () => {
    const fetchFn = mockFetch({ result: 'SUCCESS', data: { list: f([row, { dataNm: f('번호 없음') }]) }, totalCount: { '총 개수': 37 } });
    const r = await new AihubClient('k-123').search('러시아어 번역', 10, 20);
    expect(r.total).toBe(37);
    expect(r.items.map((d) => d.id)).toEqual(['71686']);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url.pathname).toBe('/mcp/dataSetList.do');
    expect(url.searchParams.get('searchKeyword')).toBe('러시아어 번역');
    expect(url.searchParams.get('recordCountPerPage')).toBe('10');
    expect(url.searchParams.get('firstIndex')).toBe('20');
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBe('k-123');
    // X-MCP-Tool 이 없으면 서버가 "잘못된 접근입니다" 로 거절한다
    expect(headers['X-MCP-Tool']).toBe('searchDataSets');
    expect(headers['X-MCP-Client']).toBe('classroom-interpreter');
  });

  it('키가 없으면 헤더를 붙이지 않는다', async () => {
    const fetchFn = mockFetch({ data: { list: f([]) } });
    await new AihubClient(null).search('번역');
    expect((fetchFn.mock.calls[0][1]?.headers as Record<string, string>)['X-API-KEY']).toBeUndefined();
  });

  it('상세: 주요 정보·개요·파일을 읽고 설명서 원문은 뺀다', async () => {
    const fetchFn = mockFetch({
      data: {
        '주요 정보': { dataNm: f('다국어 통번역 데이터', '데이터명'), aiLrnDataMainKwrds: f(['번역', { codeId: 'X' }], '키워드') },
        '데이터 개요': { dataIntrcn: f('<p>한국어와 <b>러시아어</b></p>  문장 쌍', '소개') },
        '메타데이터 구조표': { lblFom: f('json', '라벨링 형식') },
        '파일 목록(API 다운로드)': { fileList: f([{ fileSize: f(5), fileStreCours: f('D/a.zip') }], '파일 목록') },
        '데이터 설명서': f({ cnvrCn: f('# 아주 긴 설명서') }),
        '구축활용가이드': f({}),
      },
    });
    const d = await new AihubClient('k').detail('71686');
    expect((fetchFn.mock.calls[0][1]?.headers as Record<string, string>)['X-MCP-Tool']).toBe('getDataSet');
    expect(d.name).toBe('다국어 통번역 데이터');
    expect(d.intro).toBe('한국어와 러시아어\n문장 쌍');
    expect(d.keywords).toEqual(['번역']);
    expect(d.sections.map((s) => s.title)).toEqual(['주요 정보', '데이터 개요', '메타데이터 구조표']);
    expect(d.files).toEqual([{ path: 'D/a.zip', size: 5 }]);
    expect(d.fileCount).toBe(1);
    expect(JSON.stringify(d)).not.toContain('아주 긴 설명서');
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
