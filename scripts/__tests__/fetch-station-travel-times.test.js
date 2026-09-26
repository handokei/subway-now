/**
 * #655: fetch-station-travel-times 스크립트 단위 테스트.
 * 헬퍼 파싱 함수 + buildTravelTimes 매칭 로직 + fetchPage HTTP 응답 처리.
 */
const {
  parseHm,
  normalizeLineName,
  normalizeStationName,
  buildNameIndex,
  lookupStationId,
  groupRowsByLine,
  buildTravelTimes,
  fetchPage,
  fetchAll,
} = require('../fetch-station-travel-times');

describe('parseHm', () => {
  it('"M:SS" 형식을 초로 변환', () => {
    expect(parseHm('2:00')).toBe(120);
    expect(parseHm('1:30')).toBe(90);
    expect(parseHm('0:00')).toBe(0);
  });

  it('"MM:SS" 형식도 처리', () => {
    expect(parseHm('10:45')).toBe(645);
  });

  it('공백을 trim한다', () => {
    expect(parseHm('  1:30  ')).toBe(90);
  });

  it('형식 불일치는 null', () => {
    expect(parseHm('abc')).toBeNull();
    expect(parseHm('1:2')).toBeNull();
    expect(parseHm('')).toBeNull();
  });

  it('비문자열은 null', () => {
    expect(parseHm(null)).toBeNull();
    expect(parseHm(undefined)).toBeNull();
    expect(parseHm(120)).toBeNull();
  });
});

describe('normalizeLineName', () => {
  it('단순 숫자 표기를 받는다', () => {
    expect(normalizeLineName('1')).toBe('1');
    expect(normalizeLineName('8')).toBe('8');
  });

  it('"01호선" 등 zero-padded 표기 흡수', () => {
    expect(normalizeLineName('01호선')).toBe('1');
    expect(normalizeLineName('1호선')).toBe('1');
  });

  it('범위 밖(9 이상)은 null — API는 1~8호선만 커버', () => {
    expect(normalizeLineName('9')).toBeNull();
    expect(normalizeLineName('09호선')).toBeNull();
    expect(normalizeLineName('100')).toBeNull();
  });

  it('형식 불일치는 null', () => {
    expect(normalizeLineName('공항')).toBeNull();
    expect(normalizeLineName('')).toBeNull();
  });

  it('비문자열은 null', () => {
    expect(normalizeLineName(null)).toBeNull();
    expect(normalizeLineName(1)).toBeNull();
  });
});

describe('normalizeStationName', () => {
  it('후행 괄호 부제를 제거', () => {
    expect(normalizeStationName('상봉(시외버스터미널)')).toBe('상봉');
    expect(normalizeStationName('이수(총신대입구)')).toBe('이수');
  });

  it('괄호가 없으면 그대로 trim', () => {
    expect(normalizeStationName('  종로3가  ')).toBe('종로3가');
  });

  it('괄호가 후행이 아니면 그대로', () => {
    expect(normalizeStationName('(특별)강남')).toBe('(특별)강남');
  });

  it('괄호가 맨 앞이면 trim만', () => {
    // lastIndexOf('(') === 0 → 잘라내지 않고 trim만
    expect(normalizeStationName('(강남)')).toBe('(강남)');
  });

  it('비문자열은 빈 문자열', () => {
    expect(normalizeStationName(null)).toBe('');
    expect(normalizeStationName(undefined)).toBe('');
  });
});

describe('buildNameIndex / lookupStationId', () => {
  const stations = [
    { id: '1-001', line: '1', name: '서울역' },
    { id: '1-002', line: '1', name: '시청' },
    { id: '7-001', line: '7', name: '상봉(시외버스터미널)' },
    { id: '2-001', line: '2', name: '서울역' },
  ];

  it('노선별 name → id 인덱스 + 정규화 alias도 등록', () => {
    const byLine = buildNameIndex(stations);
    expect(byLine.get('1').get('서울역')).toBe('1-001');
    expect(byLine.get('2').get('서울역')).toBe('2-001');
    // 7호선의 괄호 부제 alias
    expect(byLine.get('7').get('상봉')).toBe('7-001');
    expect(byLine.get('7').get('상봉(시외버스터미널)')).toBe('7-001');
  });

  it('lookupStationId: exact 매칭', () => {
    const byLine = buildNameIndex(stations);
    expect(lookupStationId(byLine, '1', '서울역')).toBe('1-001');
  });

  it('lookupStationId: 정규화 후 매칭', () => {
    const byLine = buildNameIndex(stations);
    expect(lookupStationId(byLine, '7', '상봉(시외버스터미널)')).toBe('7-001');
    expect(lookupStationId(byLine, '7', '상봉')).toBe('7-001');
  });

  it('lookupStationId: 해당 노선에 없는 역은 null', () => {
    const byLine = buildNameIndex(stations);
    expect(lookupStationId(byLine, '1', '없는역')).toBeNull();
  });

  it('lookupStationId: 미등록 노선은 null', () => {
    const byLine = buildNameIndex(stations);
    expect(lookupStationId(byLine, '99', '서울역')).toBeNull();
  });
});

describe('groupRowsByLine', () => {
  it('SBWY_ROUT_LN별로 그룹화하고 순서 보존', () => {
    const rows = [
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '시청' },
      { SBWY_ROUT_LN: '2', SBWY_STNS_NM: '서울역' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '종각' },
    ];
    const groups = groupRowsByLine(rows);
    expect(groups.get('1')).toHaveLength(3);
    expect(groups.get('1').map((r) => r.SBWY_STNS_NM)).toEqual(['서울역', '시청', '종각']);
    expect(groups.get('2')).toHaveLength(1);
  });

  it('정규화 실패한 line은 스킵', () => {
    const rows = [
      { SBWY_ROUT_LN: '공항', SBWY_STNS_NM: '인천공항' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역' },
    ];
    const groups = groupRowsByLine(rows);
    expect(groups.has('공항')).toBe(false);
    expect(groups.get('1')).toHaveLength(1);
  });
});

describe('buildTravelTimes', () => {
  const stations = [
    { id: '1-001', line: '1', name: '서울역' },
    { id: '1-002', line: '1', name: '시청' },
    { id: '1-003', line: '1', name: '종각' },
    { id: '1-004', line: '1', name: '종로3가' },
  ];

  it('인접 row 쌍을 양방향 키로 저장', () => {
    const rows = [
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역', HM: '0:00' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '시청', HM: '2:00' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '종각', HM: '1:30' },
    ];
    const { travelTimes, matchedHops, totalHops, unmatched } = buildTravelTimes(rows, stations);
    expect(travelTimes['1|1-001|1-002']).toBe(120);
    expect(travelTimes['1|1-002|1-001']).toBe(120);
    expect(travelTimes['1|1-002|1-003']).toBe(90);
    expect(travelTimes['1|1-003|1-002']).toBe(90);
    expect(matchedHops).toBe(2);
    expect(totalHops).toBe(2);
    expect(unmatched).toEqual([]);
  });

  it('인접하지 않은 row 쌍은 hop으로 카운트하지 않는다 — 분기/순환 wrap 방어', () => {
    // 4호선 진접지선/2호선 순환 등 분기 경계는 API row가 stations.json 인덱스 1 차이가 아님.
    const rows = [
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역', HM: '0:00' },
      // 서울역 → 종각: stations.json idx 차이 2 → 인접 아님 → 무시
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '종각', HM: '3:00' },
      // 종각 → 종로3가: idx 차이 1 → 인접 hop OK
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '종로3가', HM: '1:30' },
    ];
    const { travelTimes, matchedHops, totalHops, unmatched } = buildTravelTimes(rows, stations);
    expect(travelTimes['1|1-001|1-003']).toBeUndefined();
    expect(travelTimes['1|1-003|1-004']).toBe(90);
    expect(matchedHops).toBe(1);
    expect(totalHops).toBe(1);
    expect(unmatched).toEqual([]);
  });

  it('HM=0 또는 매칭 실패는 인접한 hop에 한해서만 unmatched로 분류', () => {
    const rows = [
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역', HM: '0:00' },
      // 인접하지만 HM=0 → unmatched
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '시청', HM: '0:00' },
    ];
    const { travelTimes, matchedHops, totalHops, unmatched } = buildTravelTimes(rows, stations);
    expect(Object.keys(travelTimes)).toHaveLength(0);
    expect(matchedHops).toBe(0);
    expect(totalHops).toBe(1);
    expect(unmatched).toHaveLength(1);
  });

  it('정규화 line 실패 row는 totalHops 계산에서 제외', () => {
    const rows = [
      { SBWY_ROUT_LN: 'X', SBWY_STNS_NM: '서울역', HM: '0:00' },
      { SBWY_ROUT_LN: 'X', SBWY_STNS_NM: '시청', HM: '2:00' },
    ];
    const { totalHops, matchedHops } = buildTravelTimes(rows, stations);
    expect(totalHops).toBe(0);
    expect(matchedHops).toBe(0);
  });

  it('stations.json에 없는 역은 인접 검증 통과 못 함 → hop 무시', () => {
    const rows = [
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역', HM: '0:00' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '없는역', HM: '2:00' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '시청', HM: '2:00' },
    ];
    const { matchedHops, totalHops } = buildTravelTimes(rows, stations);
    expect(matchedHops).toBe(0);
    expect(totalHops).toBe(0);
  });
});

describe('fetchPage / fetchAll — mock fetch', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('정상 응답 row 배열을 반환', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        StationDstncReqreTimeHm: {
          row: [{ SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역', HM: '0:00' }],
        },
      }),
    });
    const rows = await fetchPage('KEY', 1, 1000);
    expect(rows).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/KEY/json/StationDstncReqreTimeHm/1/1000/'));
  });

  it('HTTP 오류는 throw', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchPage('KEY', 1, 1000)).rejects.toThrow('HTTP 500');
  });

  it('INFO-200(검색 결과 없음)은 빈 배열', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ RESULT: { CODE: 'INFO-200' } }),
    });
    const rows = await fetchPage('KEY', 9999, 10000);
    expect(rows).toEqual([]);
  });

  it('예상치 못한 응답은 throw', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ UNKNOWN: 'shape' }),
    });
    await expect(fetchPage('KEY', 1, 1000)).rejects.toThrow('unexpected response');
  });

  it('row 누락 시 빈 배열 fallback', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ StationDstncReqreTimeHm: {} }),
    });
    const rows = await fetchPage('KEY', 1, 1000);
    expect(rows).toEqual([]);
  });

  it('fetchAll: 페이지가 PAGE_SIZE(1000) 미만이면 한 번에 종료', async () => {
    const pageRows = Array.from({ length: 50 }, (_, i) => ({
      SBWY_ROUT_LN: '1',
      SBWY_STNS_NM: `역${i}`,
      HM: '1:00',
    }));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ StationDstncReqreTimeHm: { row: pageRows } }),
    });
    const rows = await fetchAll('KEY');
    expect(rows).toHaveLength(50);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('fetchAll: 페이지가 PAGE_SIZE면 추가 페이지 시도', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      SBWY_ROUT_LN: '1',
      SBWY_STNS_NM: `역${i}`,
      HM: '1:00',
    }));
    let call = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      call++;
      return {
        ok: true,
        json: async () =>
          call === 1
            ? { StationDstncReqreTimeHm: { row: fullPage } }
            : { RESULT: { CODE: 'INFO-200' } },
      };
    });
    const rows = await fetchAll('KEY');
    expect(rows).toHaveLength(1000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
