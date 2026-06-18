/**
 * #1472: build-station-distances 단위 테스트.
 * 노선별 평균속도 fallback과 별개로, CSV 파싱 + 인접 hop 매칭 로직만 검증한다.
 */
const iconv = require('iconv-lite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  resolveCsvSource,
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
  it('8개 이상 CSV가 정의되어 있다 (사용자 제공 + 코레일 + 신규 수도권4호선)', () => {
    expect(CSV_FILES.length).toBeGreaterThanOrEqual(8);
    for (const spec of CSV_FILES) {
      expect(spec.filename).toMatch(/\.csv$/i);
      // #1493: slim fixture는 utf-8, legacy KRRIC 원본은 cp949.
      expect(spec.encoding).toBe('utf8');
      expect(spec.legacyEncoding).toBe('cp949');
      expect(spec.legacyFilename).toMatch(/\.csv$/i);
      expect(Object.keys(spec.lineMap).length).toBeGreaterThan(0);
    }
  });

  it('수도권4호선/코레일 신규 spec 포함 + 1호선 4분기 매핑', () => {
    const line4 = CSV_FILES.find((s) => s.filename === 'krric-line4-extension-distance-20251231.csv');
    expect(line4).toBeDefined();
    expect(line4.lineMap['4호선']).toBe('4');

    const korail = CSV_FILES.find((s) => s.filename === 'krric-korail-distance-20251231.csv');
    expect(korail).toBeDefined();
    // 코레일 1호선 4개 분기 모두 stations.json '1'로 매핑.
    expect(korail.lineMap['1호선(경부선)']).toBe('1');
    expect(korail.lineMap['1호선(경인선)']).toBe('1');
    expect(korail.lineMap['1호선(광명선)']).toBe('1');
    expect(korail.lineMap['1호선(서동탄선)']).toBe('1');
    expect(korail.lineMap['3호선']).toBe('3');
    expect(korail.lineMap['4호선']).toBe('4');
    expect(korail.lineMap.수인분당).toBe('bundang');
    expect(korail.lineMap.경의중앙).toBe('gyeongui');
  });
});

describe('resolveCsvSource', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-src-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('slim fixture 우선 (utf-8)', () => {
    const spec = {
      filename: 'a.csv',
      legacyFilename: 'legacy.csv',
      encoding: 'utf8',
      legacyEncoding: 'cp949',
    };
    fs.writeFileSync(path.join(tmpDir, 'a.csv'), 'x');
    const src = resolveCsvSource(spec, tmpDir);
    expect(src.encoding).toBe('utf8');
    expect(src.fullPath).toContain('a.csv');
  });

  it('fixture 없으면 legacy(cp949) fallback', () => {
    const spec = {
      filename: 'a.csv',
      legacyFilename: 'legacy.csv',
      encoding: 'utf8',
      legacyEncoding: 'cp949',
    };
    fs.writeFileSync(path.join(tmpDir, 'legacy.csv'), 'x');
    const src = resolveCsvSource(spec, tmpDir);
    expect(src.encoding).toBe('cp949');
    expect(src.fullPath).toContain('legacy.csv');
  });

  it('legacyEncoding 미지정 시 encoding 그대로 사용', () => {
    const spec = { filename: 'a.csv', legacyFilename: 'legacy.csv', encoding: 'utf8' };
    fs.writeFileSync(path.join(tmpDir, 'legacy.csv'), 'x');
    const src = resolveCsvSource(spec, tmpDir);
    expect(src.encoding).toBe('utf8');
  });

  it('legacyFilename 없으면 fallback 안 함', () => {
    const spec = { filename: 'a.csv', encoding: 'utf8' };
    const src = resolveCsvSource(spec, tmpDir);
    expect(src).toBeNull();
  });

  it('둘 다 없으면 null', () => {
    const spec = { filename: 'a.csv', legacyFilename: 'legacy.csv', encoding: 'utf8' };
    expect(resolveCsvSource(spec, tmpDir)).toBeNull();
  });
});

describe('ingestCsv encoding utf8', () => {
  // #1493: slim fixture는 utf-8 직접 디코드.
  it('utf-8 buffer를 직접 디코드한다', () => {
    const stations = [
      { id: 'sinbundang-001', name: '신사', line: 'sinbundang' },
      { id: 'sinbundang-002', name: '논현', line: 'sinbundang' },
    ];
    const spec = {
      filename: 'krric-sinbundang-distance-20250630.csv',
      encoding: 'utf8',
      lineMap: { 신분당: 'sinbundang' },
    };
    const csv =
      '철도운영기관명,선명,역명,역간거리\n' +
      '네오트랜스,신분당,신사,0\n' +
      '네오트랜스,신분당,논현,0.7';
    const buf = Buffer.from(csv, 'utf8');
    const distances = {};
    const stats = {
      added: 0,
      preserved: 0,
      unmatchedNames: [],
      nonAdjacent: [],
      skippedLines: new Set(),
      missingCsvs: [],
    };
    ingestCsv(spec, buf, stations, distances, stats);
    expect(distances['sinbundang|sinbundang-001|sinbundang-002']).toBe(700);
  });
});
