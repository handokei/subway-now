/**
 * #1472: build-station-distances 단위 테스트.
 * 노선별 평균속도 fallback과 별개로, CSV 파싱 + 인접 hop 매칭 로직만 검증한다.
 */
const iconv = require('iconv-lite');
const {
  normalizeStationName,
  parseCsvLine,
  parseCsv,
  parseDistKm,
  pickField,
  buildNameIndex,
  buildLineIdxMap,
  lookupStationId,
  ingestCsv,
  CSV_FILES,
} = require('../build-station-distances');

describe('normalizeStationName', () => {
  it('부역명 괄호를 제거한다', () => {
    expect(normalizeStationName('광교(경기대)')).toBe('광교');
    expect(normalizeStationName('양재(서초구청)')).toBe('양재');
  });

  it('괄호가 없으면 그대로 반환', () => {
    expect(normalizeStationName('논현')).toBe('논현');
  });

  it('공백 트림', () => {
    expect(normalizeStationName('  강남  ')).toBe('강남');
  });

  it('non-string은 빈 문자열', () => {
    expect(normalizeStationName(null)).toBe('');
    expect(normalizeStationName(undefined)).toBe('');
  });

  it('빈 괄호("(") 시작 안 함은 원형 유지', () => {
    expect(normalizeStationName('이상한)')).toBe('이상한)');
  });
});

describe('parseCsvLine / parseCsv', () => {
  it('쉼표로 split + trim', () => {
    expect(parseCsvLine('a, b ,c')).toEqual(['a', 'b', 'c']);
  });

  it('헤더 + row를 객체로 묶는다', () => {
    const text = '철도운영기관명,선명,역명,역간거리\n네오트랜스,신분당,논현,0.7';
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(['철도운영기관명', '선명', '역명', '역간거리']);
    expect(rows[0]['역명']).toBe('논현');
    expect(rows[0]['역간거리']).toBe('0.7');
  });

  it('빈 입력은 빈 결과', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });
});

describe('parseDistKm', () => {
  it('양수만 통과', () => {
    expect(parseDistKm('1.5')).toBe(1.5);
    expect(parseDistKm('0')).toBeNull();
    expect(parseDistKm('-1')).toBeNull();
    expect(parseDistKm('abc')).toBeNull();
    expect(parseDistKm(null)).toBeNull();
    expect(parseDistKm(undefined)).toBeNull();
  });
});

describe('pickField', () => {
  it('첫 번째 매칭 키 값을 돌려준다', () => {
    expect(pickField({ a: '1', b: '2' }, ['b', 'a'])).toBe('2');
    expect(pickField({ a: '1' }, ['z', 'a'])).toBe('1');
  });
  it('전부 미존재 / 빈 문자열이면 null', () => {
    expect(pickField({}, ['a'])).toBeNull();
    expect(pickField({ a: '' }, ['a'])).toBeNull();
  });
});

describe('buildNameIndex / lookupStationId', () => {
  const stations = [
    { id: 'sinbundang-016', name: '신사', line: 'sinbundang' },
    { id: 'sinbundang-001', name: '광교(경기대)', line: 'sinbundang' },
  ];
  it('정식명·normalize 둘 다 lookup된다', () => {
    const idx = buildNameIndex(stations);
    expect(lookupStationId(idx, 'sinbundang', '광교(경기대)')).toBe('sinbundang-001');
    expect(lookupStationId(idx, 'sinbundang', '광교')).toBe('sinbundang-001');
    expect(lookupStationId(idx, 'sinbundang', '신사')).toBe('sinbundang-016');
  });
  it('미존재 노선/역은 null', () => {
    const idx = buildNameIndex(stations);
    expect(lookupStationId(idx, 'unknown', '광교')).toBeNull();
    expect(lookupStationId(idx, 'sinbundang', '없는역')).toBeNull();
  });
});

describe('buildLineIdxMap', () => {
  it('id 정렬 후 인덱스 매핑', () => {
    const stations = [
      { id: 'sinbundang-002', name: '논현', line: 'sinbundang' },
      { id: 'sinbundang-001', name: '신사', line: 'sinbundang' },
    ];
    const map = buildLineIdxMap(stations);
    const lineMap = map.get('sinbundang');
    expect(lineMap.get('sinbundang-001')).toBe(0);
    expect(lineMap.get('sinbundang-002')).toBe(1);
  });
});

describe('ingestCsv', () => {
  const stations = [
    { id: 'sinbundang-001', name: '신사', line: 'sinbundang' },
    { id: 'sinbundang-002', name: '논현', line: 'sinbundang' },
    { id: 'sinbundang-003', name: '신논현', line: 'sinbundang' },
  ];
  const spec = {
    filename: 'test.csv',
    encoding: 'cp949',
    lineMap: { 신분당: 'sinbundang' },
  };

  function emptyStats() {
    return {
      added: 0,
      preserved: 0,
      unmatchedNames: [],
      nonAdjacent: [],
      skippedLines: new Set(),
      missingCsvs: [],
    };
  }

  it('인접 hop 양방향 미터로 저장', () => {
    const csv =
      '철도운영기관명,선명,역명,역간거리\n' +
      '네오트랜스,신분당,신사,0\n' +
      '네오트랜스,신분당,논현,0.7\n' +
      '네오트랜스,신분당,신논현,0.8';
    const buf = iconv.encode(csv, 'cp949');
    const distances = {};
    const stats = emptyStats();
    ingestCsv(spec, buf, stations, distances, stats);
    expect(distances['sinbundang|sinbundang-001|sinbundang-002']).toBe(700);
    expect(distances['sinbundang|sinbundang-002|sinbundang-001']).toBe(700);
    expect(distances['sinbundang|sinbundang-002|sinbundang-003']).toBe(800);
    expect(stats.added).toBe(2);
  });

  it('기존 키가 있으면 보존(preserved)', () => {
    const csv =
      '철도운영기관명,선명,역명,역간거리\n' +
      '네오트랜스,신분당,신사,0\n' +
      '네오트랜스,신분당,논현,0.7';
    const buf = iconv.encode(csv, 'cp949');
    const distances = { 'sinbundang|sinbundang-001|sinbundang-002': 9999 };
    const stats = emptyStats();
    ingestCsv(spec, buf, stations, distances, stats);
    expect(distances['sinbundang|sinbundang-001|sinbundang-002']).toBe(9999);
    expect(stats.added).toBe(0);
    expect(stats.preserved).toBe(1);
  });

  it('lineMap에 없는 선명은 무시', () => {
    const csv =
      '철도운영기관명,선명,역명,역간거리\n' +
      '코레일,1호선(경부선),서울역,0\n' +
      '코레일,1호선(경부선),시청,1.0';
    const buf = iconv.encode(csv, 'cp949');
    const distances = {};
    const stats = emptyStats();
    ingestCsv(spec, buf, stations, distances, stats);
    expect(stats.added).toBe(0);
  });

  it('stations.json 미커버 노선은 skippedLines에 기록', () => {
    const csv =
      '철도운영기관명,선명,역명,역간거리\n' +
      '우이신설경전철,우이신설,북한산우이,0\n' +
      '우이신설경전철,우이신설,솔밭공원,0.8';
    const buf = iconv.encode(csv, 'cp949');
    const distances = {};
    const stats = emptyStats();
    ingestCsv(
      { filename: 'ui.csv', encoding: 'cp949', lineMap: { 우이신설: 'ui' } },
      buf,
      stations,
      distances,
      stats,
    );
    expect(stats.added).toBe(0);
    expect([...stats.skippedLines]).toContain('ui.csv:ui');
  });

  it('역명 미매칭은 unmatchedNames에 기록', () => {
    const csv =
      '철도운영기관명,선명,역명,역간거리\n' +
      '네오트랜스,신분당,신사,0\n' +
      '네오트랜스,신분당,없는역,0.7';
    const buf = iconv.encode(csv, 'cp949');
    const distances = {};
    const stats = emptyStats();
    ingestCsv(spec, buf, stations, distances, stats);
    expect(stats.unmatchedNames.length).toBeGreaterThan(0);
    expect(stats.unmatchedNames[0]).toContain('없는역');
  });

  it('역명/선명 결손 row는 흐름을 끊고 skip', () => {
    const csv =
      '철도운영기관명,선명,역명,역간거리\n' +
      '네오트랜스,신분당,신사,0\n' +
      '네오트랜스,신분당,,0.7\n' +
      '네오트랜스,신분당,신논현,0.8';
    const buf = iconv.encode(csv, 'cp949');
    const distances = {};
    const stats = emptyStats();
    ingestCsv(spec, buf, stations, distances, stats);
    // 신사→? skip된 후, ?→신논현 시작이 prev=null이라 hop 0건.
    expect(stats.added).toBe(0);
  });
});

describe('CSV_FILES', () => {
  it('6개 CSV가 정의되어 있다 (사용자 제공 + 코레일)', () => {
    expect(CSV_FILES.length).toBeGreaterThanOrEqual(6);
    for (const spec of CSV_FILES) {
      expect(spec.filename).toMatch(/\.csv$/i);
      expect(spec.encoding).toBe('cp949');
      expect(Object.keys(spec.lineMap).length).toBeGreaterThan(0);
    }
  });
});
