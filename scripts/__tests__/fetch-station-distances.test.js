/**
 * #1111: fetch-station-distances 스크립트 단위 테스트.
 * #655 fetch-station-travel-times.test.js와 패턴은 같지만 HM 대신 DIST_KM 캡처를 검증.
 */
const {
  parseDistKm,
  normalizeLineName,
  normalizeStationName,
  buildNameIndex,
  lookupStationId,
  groupRowsByLine,
  buildDistances,
  fetchPage,
  fetchAll,
} = require('../fetch-station-distances');

describe('parseDistKm', () => {
  it('숫자 문자열을 km으로 파싱', () => {
    expect(parseDistKm('1.5')).toBe(1.5);
    expect(parseDistKm('0.9')).toBe(0.9);
    expect(parseDistKm('  2.3  ')).toBe(2.3);
  });

  it('숫자 그대로 받는다', () => {
    expect(parseDistKm(1.2)).toBe(1.2);
  });

  it('0 이하 또는 비유한값은 null', () => {
    expect(parseDistKm('0')).toBeNull();
    expect(parseDistKm('-1')).toBeNull();
    expect(parseDistKm('abc')).toBeNull();
    expect(parseDistKm('')).toBeNull();
  });

  it('null/undefined는 null', () => {
    expect(parseDistKm(null)).toBeNull();
    expect(parseDistKm(undefined)).toBeNull();
  });
});

describe('normalizeLineName', () => {
  it('단순 숫자 표기 1~8', () => {
    expect(normalizeLineName('1')).toBe('1');
    expect(normalizeLineName('8')).toBe('8');
  });

  it('zero-padded / "호선" suffix 흡수', () => {
    expect(normalizeLineName('01호선')).toBe('1');
    expect(normalizeLineName('1호선')).toBe('1');
  });

  it('범위 밖(9 이상)은 null', () => {
    expect(normalizeLineName('9')).toBeNull();
    expect(normalizeLineName('09호선')).toBeNull();
  });

  it('형식 불일치 / 비문자열은 null', () => {
    expect(normalizeLineName('공항')).toBeNull();
    expect(normalizeLineName('')).toBeNull();
    expect(normalizeLineName(null)).toBeNull();
    expect(normalizeLineName(1)).toBeNull();
  });
});

describe('normalizeStationName', () => {
  it('후행 괄호 부제 제거', () => {
    expect(normalizeStationName('상봉(시외버스터미널)')).toBe('상봉');
  });

  it('괄호 없으면 trim', () => {
    expect(normalizeStationName('  종로3가  ')).toBe('종로3가');
  });

  it('맨 앞 괄호는 그대로', () => {
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

  it('노선별 name → id + alias 인덱스', () => {
    const byLine = buildNameIndex(stations);
    expect(byLine.get('1').get('서울역')).toBe('1-001');
    expect(byLine.get('2').get('서울역')).toBe('2-001');
    expect(byLine.get('7').get('상봉')).toBe('7-001');
    expect(byLine.get('7').get('상봉(시외버스터미널)')).toBe('7-001');
  });

  it('lookupStationId exact 매칭', () => {
    const byLine = buildNameIndex(stations);
    expect(lookupStationId(byLine, '1', '서울역')).toBe('1-001');
  });

  it('lookupStationId 정규화 후 매칭', () => {
    const byLine = buildNameIndex(stations);
    expect(lookupStationId(byLine, '7', '상봉(시외버스터미널)')).toBe('7-001');
    expect(lookupStationId(byLine, '7', '상봉')).toBe('7-001');
  });

  it('lookupStationId: 해당 노선/등록 없는 line은 null', () => {
    const byLine = buildNameIndex(stations);
    expect(lookupStationId(byLine, '1', '없는역')).toBeNull();
    expect(lookupStationId(byLine, '99', '서울역')).toBeNull();
  });
});

describe('groupRowsByLine', () => {
  it('SBWY_ROUT_LN별 그룹화 + 순서 보존', () => {
    const rows = [
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '시청' },
      { SBWY_ROUT_LN: '2', SBWY_STNS_NM: '서울역' },
    ];
    const groups = groupRowsByLine(rows);
    expect(groups.get('1')).toHaveLength(2);
    expect(groups.get('2')).toHaveLength(1);
  });

  it('정규화 실패 line은 스킵', () => {
    const rows = [
      { SBWY_ROUT_LN: '공항', SBWY_STNS_NM: '인천공항' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역' },
    ];
    const groups = groupRowsByLine(rows);
    expect(groups.has('공항')).toBe(false);
    expect(groups.get('1')).toHaveLength(1);
  });
});

describe('buildDistances', () => {
  const stations = [
    { id: '1-001', line: '1', name: '서울역' },
    { id: '1-002', line: '1', name: '시청' },
    { id: '1-003', line: '1', name: '종각' },
    { id: '1-004', line: '1', name: '종로3가' },
  ];

  it('인접 row 쌍을 양방향 미터 키로 저장 (km → m 반올림)', () => {
    const rows = [
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역', DIST_KM: '0' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '시청', DIST_KM: '1.1' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '종각', DIST_KM: '0.85' },
    ];
    const { distances, matchedHops, totalHops, unmatched } = buildDistances(rows, stations);
    expect(distances['1|1-001|1-002']).toBe(1100);
    expect(distances['1|1-002|1-001']).toBe(1100);
    expect(distances['1|1-002|1-003']).toBe(850);
    expect(distances['1|1-003|1-002']).toBe(850);
    expect(matchedHops).toBe(2);
    expect(totalHops).toBe(2);
    expect(unmatched).toEqual([]);
  });

  it('인접하지 않은 row 쌍은 hop 무시 — 분기/순환 방어', () => {
    const rows = [
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역', DIST_KM: '0' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '종각', DIST_KM: '2.0' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '종로3가', DIST_KM: '0.9' },
    ];
    const { distances, matchedHops, totalHops } = buildDistances(rows, stations);
    expect(distances['1|1-001|1-003']).toBeUndefined();
    expect(distances['1|1-003|1-004']).toBe(900);
    expect(matchedHops).toBe(1);
    expect(totalHops).toBe(1);
  });

  it('DIST_KM=0 또는 누락은 인접 hop에 한해 unmatched로 분류', () => {
    const rows = [
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역', DIST_KM: '0' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '시청', DIST_KM: '0' },
    ];
    const { distances, matchedHops, totalHops, unmatched } = buildDistances(rows, stations);
    expect(Object.keys(distances)).toHaveLength(0);
    expect(matchedHops).toBe(0);
    expect(totalHops).toBe(1);
    expect(unmatched).toHaveLength(1);
  });

  it('line 정규화 실패 row는 totalHops에서 제외', () => {
    const rows = [
      { SBWY_ROUT_LN: 'X', SBWY_STNS_NM: '서울역', DIST_KM: '0' },
      { SBWY_ROUT_LN: 'X', SBWY_STNS_NM: '시청', DIST_KM: '1.0' },
    ];
    const { totalHops, matchedHops } = buildDistances(rows, stations);
    expect(totalHops).toBe(0);
    expect(matchedHops).toBe(0);
  });

  it('stations.json 미등록 역은 인접 검증 통과 못 함', () => {
    const rows = [
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역', DIST_KM: '0' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '없는역', DIST_KM: '1.0' },
      { SBWY_ROUT_LN: '1', SBWY_STNS_NM: '시청', DIST_KM: '1.0' },
    ];
    const { matchedHops, totalHops } = buildDistances(rows, stations);
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

  it('정상 응답 row 반환', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        StationDstncReqreTimeHm: {
          row: [{ SBWY_ROUT_LN: '1', SBWY_STNS_NM: '서울역', DIST_KM: '0' }],
        },
      }),
    });
    const rows = await fetchPage('KEY', 1, 1000);
    expect(rows).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/KEY/json/StationDstncReqreTimeHm/1/1000/'),
    );
  });

  it('HTTP 오류는 throw', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchPage('KEY', 1, 1000)).rejects.toThrow('HTTP 500');
  });

  it('INFO-200은 빈 배열', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ RESULT: { CODE: 'INFO-200' } }),
    });
    expect(await fetchPage('KEY', 9999, 10000)).toEqual([]);
  });

  it('예상치 못한 응답은 throw', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ UNKNOWN: 'shape' }),
    });
    await expect(fetchPage('KEY', 1, 1000)).rejects.toThrow('unexpected response');
  });

  it('row 누락은 빈 배열 fallback', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ StationDstncReqreTimeHm: {} }),
    });
    expect(await fetchPage('KEY', 1, 1000)).toEqual([]);
  });

  it('fetchAll: PAGE_SIZE 미만이면 한 번에 종료', async () => {
    const pageRows = Array.from({ length: 50 }, (_, i) => ({
      SBWY_ROUT_LN: '1',
      SBWY_STNS_NM: `역${i}`,
      DIST_KM: '1.0',
    }));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ StationDstncReqreTimeHm: { row: pageRows } }),
    });
    const rows = await fetchAll('KEY');
    expect(rows).toHaveLength(50);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('fetchAll: PAGE_SIZE면 추가 페이지 시도', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      SBWY_ROUT_LN: '1',
      SBWY_STNS_NM: `역${i}`,
      DIST_KM: '1.0',
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
