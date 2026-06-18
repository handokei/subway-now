/**
 * build-station-environment (#1434/#1460/#1461/#1466) — 단위 테스트.
 * ADR-015 §1 Deterministic Environment SSOT.
 */

const path = require('node:path');
const os = require('node:os');
const {
  classifyFloor,
  parseCsv,
  parseCsvRow,
  parseKrricCsv,
  parseLine9Csv,
  parseGyeonguiCsv,
  buildKrricMap,
  diffSources,
  build,
  ENVIRONMENT_OVERRIDES,
  KRRIC_SOURCES,
  VALID_ENVIRONMENTS,
  main,
} = require('../build-station-environment');

const TEST_TMP_DIR = path.join(os.tmpdir(), 'subway-now-test');

describe('classifyFloor', () => {
  it.each([
    ['B2', 'underground'],
    ['B3', 'underground'],
    ['B5', 'underground'],
    ['1F', 'surface'],
    ['2F', 'surface'],
    ['3F', 'surface'],
    ['2FB3', 'mixed'],
    ['5FB2', 'mixed'],
    ['1FB5', 'mixed'],
    ['', 'unknown'],
    ['?', 'unknown'],
  ])('classifies %s → %s', (floor, expected) => {
    expect(classifyFloor(floor)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [123],
    [{}],
    [[]],
  ])('returns unknown for non-string input (%p)', (input) => {
    expect(classifyFloor(input)).toBe('unknown');
  });
});

describe('parseCsvRow', () => {
  it('strips surrounding double quotes', () => {
    expect(parseCsvRow('"1","서울","섬식","210","B2","10805","1974"')).toEqual([
      '1',
      '서울',
      '섬식',
      '210',
      'B2',
      '10805',
      '1974',
    ]);
  });
});

describe('parseCsv', () => {
  it('builds (line|name)→env map; normalizes name with parens', () => {
    const csv =
      '"호선","역명","형식","길이(M)","층수","면적","준공년도"\n' +
      '"2","왕십리(성동구청)","상대식","205","B2","9877","1983"\n' +
      '"2","한양대","상대식","205","2F","5974","1983"\n';
    const map = parseCsv(csv);
    expect(map.get('2|왕십리')).toBe('underground');
    expect(map.get('2|한양대')).toBe('surface');
  });

  it('skips rows with fewer than 5 columns', () => {
    const csv = '"호선","역명"\n"2","왕십리"\n';
    const map = parseCsv(csv);
    expect(map.size).toBe(0);
  });

  it('handles CRLF line endings', () => {
    const csv = '"hdr"\r\n"2","뚝섬","상대식","205","3F","8384","1983"\r\n';
    const map = parseCsv(csv);
    expect(map.get('2|뚝섬')).toBe('surface');
  });
});

describe('parseKrricCsv', () => {
  it('groups 상행/하행 rows by station; same label → single env', () => {
    const csv =
      '"hdr","x","x","x","x","x","x"\n' +
      '서울시메트로9호선주식회사,9호선,개화,2,하행,지상,1,Y,N,N\n' +
      '서울시메트로9호선주식회사,9호선,개화,1,상행,지상,1,Y,N,N\n' +
      '서울시메트로9호선주식회사,9호선,김포공항,1,상행,지하,3,Y,Y,N\n' +
      '서울시메트로9호선주식회사,9호선,김포공항,2,하행,지하,4,Y,Y,N\n';
    const map = parseKrricCsv(csv, '9');
    expect(map.get('9|개화')).toBe('surface');
    expect(map.get('9|김포공항')).toBe('underground');
  });

  it('uses lineKey arg as map key (ignores 선명 column)', () => {
    // 분당선 CSV는 선명이 "수인분당"이지만 stations.json은 "bundang" line.
    const csv =
      '"hdr","x","x","x","x","x","x"\n' +
      '코레일,수인분당,왕십리,1,하행,지상,1,Y,N,N\n' +
      '코레일,수인분당,왕십리,2,상행,지상,1,Y,N,N\n';
    const map = parseKrricCsv(csv, 'bundang');
    expect(map.get('bundang|왕십리')).toBe('surface');
    expect(map.has('수인분당|왕십리')).toBe(false);
  });

  it('differing 지상구분 between 상행/하행 → mixed', () => {
    const csv =
      '"hdr","x","x","x","x","x","x"\n' +
      '서울시메트로9호선주식회사,9호선,섞임역,1,상행,지상,1,Y,N,N\n' +
      '서울시메트로9호선주식회사,9호선,섞임역,2,하행,지하,2,Y,N,N\n';
    expect(parseKrricCsv(csv, '9').get('9|섞임역')).toBe('mixed');
  });

  it('skips rows with fewer than 6 columns', () => {
    const csv = '"hdr","x"\n서울시메트로9호선주식회사,9호선,개화\n';
    expect(parseKrricCsv(csv, '9').size).toBe(0);
  });

  it('skips rows with unknown 지상구분 label', () => {
    const csv =
      '"hdr","x","x","x","x","x","x"\n' +
      '서울시메트로9호선주식회사,9호선,수상한역,1,상행,수상,1,Y,N,N\n';
    expect(parseKrricCsv(csv, '9').size).toBe(0);
  });

  it('skips rows with empty station name', () => {
    const csv =
      '"hdr","x","x","x","x","x","x"\n' +
      '서울시메트로9호선주식회사,9호선,,1,상행,지상,1,Y,N,N\n';
    expect(parseKrricCsv(csv, '9').size).toBe(0);
  });

  it('handles CRLF line endings', () => {
    const csv =
      '"hdr","x","x","x","x","x","x"\r\n' +
      '서울시메트로9호선주식회사,9호선,개화,1,상행,지상,1,Y,N,N\r\n' +
      '서울시메트로9호선주식회사,9호선,개화,2,하행,지상,1,Y,N,N\r\n';
    expect(parseKrricCsv(csv, '9').get('9|개화')).toBe('surface');
  });

  it('parses gyeongui CSV with parenthesized names and dual underground rows (#1461)', () => {
    const csv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,공덕,1,상행,지하,2\n' +
      '코레일,경의중앙,공덕,2,하행,지하,2\n' +
      '코레일,경의중앙,양원(서울시북부병원),1,상행,지상,1\n' +
      '코레일,경의중앙,양원(서울시북부병원),2,하행,지상,1\n';
    const map = parseKrricCsv(csv, 'gyeongui');
    expect(map.get('gyeongui|공덕')).toBe('underground');
    expect(map.get('gyeongui|양원')).toBe('surface');
    expect(map.has('gyeongui|양원(서울시북부병원)')).toBe(false);
  });

  it('parseLine9Csv alias forwards to parseKrricCsv with "9" key', () => {
    const csv =
      '"hdr","x","x","x","x","x","x"\n' +
      '서울시메트로9호선주식회사,9호선,개화,1,상행,지상,1,Y,N,N\n' +
      '서울시메트로9호선주식회사,9호선,개화,2,하행,지상,1,Y,N,N\n';
    expect(parseLine9Csv(csv).get('9|개화')).toBe('surface');
  });

  it('parseGyeonguiCsv alias forwards to parseKrricCsv with "gyeongui" key (#1461)', () => {
    const csv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,회기,1,상행,지상,1\n' +
      '코레일,경의중앙,회기,2,하행,지상,1\n';
    expect(parseGyeonguiCsv(csv).get('gyeongui|회기')).toBe('surface');
  });
});

describe('buildKrricMap', () => {
  it('merges multiple lineKey CSV texts into single map', () => {
    const csvLine1 =
      '"hdr","x","x","x","x","x","x"\n' +
      '코레일,1호선,소요산,1,상행,지상,2,Y,N,N\n' +
      '코레일,1호선,소요산,2,하행,지상,2,Y,N,N\n';
    const csvBundang =
      '"hdr","x","x","x","x","x","x"\n' +
      '코레일,수인분당,왕십리,1,상행,지상,1,Y,N,N\n' +
      '코레일,수인분당,왕십리,2,하행,지상,1,Y,N,N\n';
    const merged = buildKrricMap({ 1: csvLine1, bundang: csvBundang });
    expect(merged.get('1|소요산')).toBe('surface');
    expect(merged.get('bundang|왕십리')).toBe('surface');
    expect(merged.size).toBe(2);
  });

  it('returns empty map for empty input', () => {
    expect(buildKrricMap({}).size).toBe(0);
  });
});

describe('diffSources', () => {
  it('reports only entries present in both maps with different env', () => {
    const krric = new Map([
      ['2|당산', 'underground'],
      ['2|한양대', 'surface'],
      ['9|개화', 'surface'],
    ]);
    const seoul = new Map([
      ['2|당산', 'surface'],
      ['2|한양대', 'surface'],
    ]);
    expect(diffSources(krric, seoul)).toEqual([
      { key: '2|당산', krric: 'underground', seoul: 'surface' },
    ]);
  });

  it('skips entries where either side is unknown', () => {
    const krric = new Map([['2|x', 'underground']]);
    const seoul = new Map([['2|x', 'unknown']]);
    expect(diffSources(krric, seoul)).toEqual([]);
  });

  it('returns diffs sorted by key for deterministic output', () => {
    const krric = new Map([
      ['2|b', 'underground'],
      ['2|a', 'underground'],
    ]);
    const seoul = new Map([
      ['2|b', 'surface'],
      ['2|a', 'surface'],
    ]);
    const result = diffSources(krric, seoul);
    expect(result.map((d) => d.key)).toEqual(['2|a', '2|b']);
  });
});

describe('build', () => {
  const csvText =
    '"hdr","x","x","x","x","x","x"\n' +
    '"2","왕십리(성동구청)","상대식","205","B2","9877","1983"\n' +
    '"2","한양대","상대식","205","2F","5974","1983"\n' +
    '"1","동묘앞","상대식","210","5FB2","9894.75","2005"\n';

  it('applies seoul CSV classification for stations not covered by overrides/KRRIC', () => {
    const stations = [{ id: '1-029', name: '동묘앞', line: '1' }];
    const { stations: out, stats } = build({ stations, csvText });
    expect(out[0].environment).toBe('mixed');
    expect(stats.bySource.seoul).toBe(1);
    expect(stats.bySource.override).toBe(0);
    expect(stats.bySource.unknown).toBe(0);
    expect(stats.byEnv).toEqual({ surface: 0, underground: 0, mixed: 1, unknown: 0 });
    expect(stats.unknownEntries).toEqual([]);
  });

  it('applies overrides with priority over CSV', () => {
    const localOverride = '2|한양대';
    expect(Object.hasOwn(ENVIRONMENT_OVERRIDES, localOverride)).toBe(true);
    const stations = [{ id: '2-009', name: '한양대', line: '2' }];
    const { stations: out, stats } = build({ stations, csvText });
    expect(out[0].environment).toBe(ENVIRONMENT_OVERRIDES[localOverride]);
    expect(stats.bySource.override).toBe(1);
    expect(stats.bySource.seoul).toBe(0);
  });

  it('marks unknown for unmatched stations and reports them', () => {
    const stations = [
      { id: '9-001', name: '개화', line: '9' },
      { id: 'sinbundang-001', name: '광교', line: 'sinbundang' },
    ];
    const { stations: out, stats } = build({ stations, csvText });
    expect(out[0].environment).toBe('unknown');
    expect(out[1].environment).toBe('unknown');
    expect(stats.bySource.unknown).toBe(2);
    expect(stats.unknownEntries).toEqual([
      { id: '9-001', name: '개화', line: '9' },
      { id: 'sinbundang-001', name: '광교', line: 'sinbundang' },
    ]);
  });

  it('treats non-string name/line as empty for lookup', () => {
    const stations = [{ id: 'weird', name: null, line: null }];
    const { stations: out } = build({ stations, csvText });
    expect(out[0].environment).toBe('unknown');
  });

  it('handles missing id/name in unknownEntries gracefully', () => {
    const stations = [{ line: '9' }];
    const { stations: out, stats } = build({ stations, csvText });
    expect(out[0].environment).toBe('unknown');
    expect(stats.unknownEntries[0]).toEqual({ id: '', name: '', line: '9' });
  });

  it('preserves all original station fields', () => {
    const stations = [
      { id: '2-009', name: '한양대', line: '2', lat: 37.555, lng: 127.044, lineColor: '#009D3E', nameEn: 'Hanyang' },
    ];
    const { stations: out } = build({ stations, csvText });
    expect(out[0]).toMatchObject({
      id: '2-009',
      name: '한양대',
      line: '2',
      lat: 37.555,
      lng: 127.044,
      lineColor: '#009D3E',
      nameEn: 'Hanyang',
    });
  });

  it('applies KRRIC classification via krricCsvTexts (#1466)', () => {
    const krricCsvTexts = {
      9:
        '"hdr","x","x","x","x","x","x"\n' +
        '서울시메트로9호선주식회사,9호선,개화,1,상행,지상,1,Y,N,N\n' +
        '서울시메트로9호선주식회사,9호선,개화,2,하행,지상,1,Y,N,N\n' +
        '서울시메트로9호선주식회사,9호선,김포공항,1,상행,지하,3,Y,Y,N\n' +
        '서울시메트로9호선주식회사,9호선,김포공항,2,하행,지하,4,Y,Y,N\n',
      bundang:
        '"hdr","x","x","x","x","x","x"\n' +
        '코레일,수인분당,서울숲,1,상행,지하,4,Y,Y,N\n' +
        '코레일,수인분당,서울숲,2,하행,지하,4,Y,Y,N\n',
    };
    const stations = [
      { id: '9-001', name: '개화', line: '9' },
      { id: '9-002', name: '김포공항', line: '9' },
      { id: 'bundang-x', name: '서울숲', line: 'bundang' },
    ];
    const { stations: out, stats } = build({ stations, csvText, krricCsvTexts });
    expect(out[0].environment).toBe('surface');
    expect(out[1].environment).toBe('underground');
    expect(out[2].environment).toBe('underground');
    expect(stats.bySource.krric).toBe(3);
    expect(stats.bySource.seoul).toBe(0);
    expect(stats.bySource.unknown).toBe(0);
    expect(stats.byEnv).toEqual({ surface: 1, underground: 2, mixed: 0, unknown: 0 });
  });

  it('override wins over KRRIC when both match', () => {
    const krricCsvTexts = {
      2:
        '"hdr","x","x","x","x","x","x"\n' +
        '서울교통공사,2호선,한양대,1,상행,지하,1,Y,N,N\n' +
        '서울교통공사,2호선,한양대,2,하행,지하,1,Y,N,N\n',
    };
    const stations = [{ id: '2-009', name: '한양대', line: '2' }];
    const { stations: out, stats } = build({ stations, csvText, krricCsvTexts });
    // override = surface, KRRIC = underground → override wins.
    expect(out[0].environment).toBe(ENVIRONMENT_OVERRIDES['2|한양대']);
    expect(stats.bySource.override).toBe(1);
    expect(stats.bySource.krric).toBe(0);
  });

  it('KRRIC wins over seoul CSV when both match', () => {
    // seoul says 동묘앞 = mixed (2FB3 layout), KRRIC overrides with underground.
    const krricCsvTexts = {
      1:
        '"hdr","x","x","x","x","x","x"\n' +
        '서울교통공사,1호선,동묘앞,1,상행,지하,2,Y,N,N\n' +
        '서울교통공사,1호선,동묘앞,2,하행,지하,2,Y,N,N\n',
    };
    const stations = [{ id: '1-029', name: '동묘앞', line: '1' }];
    const { stations: out, stats } = build({ stations, csvText, krricCsvTexts });
    expect(out[0].environment).toBe('underground');
    expect(stats.bySource.krric).toBe(1);
    expect(stats.bySource.seoul).toBe(0);
    // cross-check diff is reported
    expect(stats.crossCheckDiffs).toEqual([
      { key: '1|동묘앞', krric: 'underground', seoul: 'mixed' },
    ]);
  });

  it('legacy line9CsvText input is absorbed as krricCsvTexts["9"] (backward compat)', () => {
    const line9CsvText =
      '"hdr","x","x","x","x","x","x"\n' +
      '서울시메트로9호선주식회사,9호선,개화,1,상행,지상,1,Y,N,N\n' +
      '서울시메트로9호선주식회사,9호선,개화,2,하행,지상,1,Y,N,N\n';
    const stations = [{ id: '9-001', name: '개화', line: '9' }];
    const { stations: out, stats } = build({ stations, csvText, line9CsvText });
    expect(out[0].environment).toBe('surface');
    expect(stats.bySource.krric).toBe(1);
  });

  it('legacy line9CsvText is ignored when krricCsvTexts["9"] already set', () => {
    const line9CsvText =
      '"hdr","x","x","x","x","x","x"\n' +
      '서울시메트로9호선주식회사,9호선,개화,1,상행,지상,1,Y,N,N\n' +
      '서울시메트로9호선주식회사,9호선,개화,2,하행,지상,1,Y,N,N\n';
    const krricCsvTexts = {
      9:
        '"hdr","x","x","x","x","x","x"\n' +
        '서울시메트로9호선주식회사,9호선,개화,1,상행,지하,1,Y,Y,N\n' +
        '서울시메트로9호선주식회사,9호선,개화,2,하행,지하,1,Y,Y,N\n',
    };
    const stations = [{ id: '9-001', name: '개화', line: '9' }];
    const { stations: out } = build({ stations, csvText, krricCsvTexts, line9CsvText });
    // krricCsvTexts wins; line9CsvText ignored.
    expect(out[0].environment).toBe('underground');
  });

  it('legacy gyeonguiCsvText input is absorbed as krricCsvTexts["gyeongui"] (backward compat, #1461)', () => {
    const gyeonguiCsvText =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,공덕,1,상행,지하,2\n' +
      '코레일,경의중앙,공덕,2,하행,지하,2\n';
    const stations = [{ id: 'gyeongui-x', name: '공덕', line: 'gyeongui' }];
    const { stations: out, stats } = build({ stations, csvText, gyeonguiCsvText });
    expect(out[0].environment).toBe('underground');
    expect(stats.bySource.krric).toBe(1);
    expect(stats.bySource.override).toBe(0);
  });

  it('legacy gyeonguiCsvText is ignored when krricCsvTexts["gyeongui"] already set', () => {
    const gyeonguiCsvText =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,공덕,1,상행,지상,1\n';
    const krricCsvTexts = {
      gyeongui:
        '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
        '코레일,경의중앙,공덕,1,상행,지하,2\n' +
        '코레일,경의중앙,공덕,2,하행,지하,2\n',
    };
    const stations = [{ id: 'gyeongui-x', name: '공덕', line: 'gyeongui' }];
    const { stations: out } = build({ stations, csvText, krricCsvTexts, gyeonguiCsvText });
    expect(out[0].environment).toBe('underground');
  });

  it('overrides take priority over gyeongui KRRIC (#1461)', () => {
    // override 서울역=underground vs gyeongui KRRIC (가상으로) 지상.
    const krricCsvTexts = {
      gyeongui:
        '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
        '코레일,경의중앙,서울역,1,상행,지상,1\n' +
        '코레일,경의중앙,서울역,2,하행,지상,1\n',
    };
    const stations = [{ id: 'gyeongui-x', name: '서울역', line: 'gyeongui' }];
    const { stations: out, stats } = build({ stations, csvText, krricCsvTexts });
    expect(out[0].environment).toBe('underground');
    expect(stats.bySource.override).toBe(1);
  });

  it('overrides take priority over KRRIC for 신내 (#1465 cross-check)', () => {
    // KRRIC가 underground라고 해도 역사심도 -1.7m(지상) override가 우선.
    const krricCsvTexts = {
      6:
        '"hdr","x","x","x","x","x","x"\n' +
        '서울교통공사,6호선,신내,1,상행,지하,1,Y,N,N\n' +
        '서울교통공사,6호선,신내,2,하행,지하,1,Y,N,N\n',
    };
    const stations = [{ id: '6-039', name: '신내', line: '6' }];
    const { stations: out, stats } = build({ stations, csvText, krricCsvTexts });
    expect(out[0].environment).toBe('surface');
    expect(stats.bySource.override).toBe(1);
    expect(stats.bySource.krric).toBe(0);
  });

  it('KRRIC row with empty 지상구분 → station stays unknown (no krric source credit)', () => {
    const krricCsvTexts = {
      9:
        '"hdr","x","x","x","x","x","x"\n' +
        '서울시메트로9호선주식회사,9호선,개화,1,상행,?,1,Y,N,N\n',
    };
    const stations = [{ id: '9-001', name: '개화', line: '9' }];
    const { stations: out, stats } = build({ stations, csvText, krricCsvTexts });
    expect(out[0].environment).toBe('unknown');
    expect(stats.bySource.krric).toBe(0);
    expect(stats.bySource.unknown).toBe(1);
  });

  it('omitting krricCsvTexts leaves 9호선 entries unknown (backward compat)', () => {
    const stations = [{ id: '9-001', name: '개화', line: '9' }];
    const { stations: out, stats } = build({ stations, csvText });
    expect(out[0].environment).toBe('unknown');
    expect(stats.bySource.krric).toBe(0);
  });

  it('treats CSV row whose floor is empty as unknown source', () => {
    const csv =
      '"hdr","x","x","x","x","x","x"\n' +
      '"2","빈층","상대식","205","","0","1983"\n';
    const stations = [{ id: '2-x', name: '빈층', line: '2' }];
    const { stations: out, stats } = build({ stations, csvText: csv });
    expect(out[0].environment).toBe('unknown');
    expect(stats.bySource.unknown).toBe(1);
    expect(stats.bySource.seoul).toBe(0);
  });
});

describe('KRRIC_SOURCES', () => {
  it('covers 1~9호선 + 분당선 + 경의중앙선 fixture mapping (#1461/#1466)', () => {
    const expectedKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bundang', 'gyeongui'];
    const cmp = (a, b) => a.localeCompare(b);
    expect(Object.keys(KRRIC_SOURCES).toSorted(cmp)).toEqual(expectedKeys.toSorted(cmp));
    for (const f of Object.values(KRRIC_SOURCES)) {
      expect(f).toMatch(/\.csv$/u);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(KRRIC_SOURCES)).toBe(true);
  });
});

describe('VALID_ENVIRONMENTS', () => {
  it('exposes the four enum values', () => {
    const cmp = (a, b) => a.localeCompare(b);
    expect([...VALID_ENVIRONMENTS].sort(cmp)).toEqual(
      ['mixed', 'surface', 'underground', 'unknown'].sort(cmp),
    );
  });
});

describe('ENVIRONMENT_OVERRIDES', () => {
  it('covers all user-verification trip stations from ADR-015 §1', () => {
    const expected = {
      '2|성수': 'surface',
      '2|뚝섬': 'surface',
      '2|한양대': 'surface',
      '2|왕십리': 'underground',
      '5|왕십리': 'underground',
      '5|마장': 'underground',
      'gyeongui|왕십리': 'underground',
      'bundang|왕십리': 'underground',
    };
    for (const [key, env] of Object.entries(expected)) {
      expect(ENVIRONMENT_OVERRIDES[key]).toBe(env);
    }
  });

  it('covers gyeongui stations missing from KRRIC CSV (#1461)', () => {
    // 경의중앙선 CSV 누락 7개 환승/지방종착역.
    const expected = {
      'gyeongui|서울역': 'underground',
      'gyeongui|효창공원앞': 'underground',
      'gyeongui|신촌': 'surface',
      'gyeongui|외대앞': 'surface',
      'gyeongui|임진강': 'surface',
      'gyeongui|지평': 'surface',
      'gyeongui|화전': 'surface',
    };
    for (const [key, env] of Object.entries(expected)) {
      expect(ENVIRONMENT_OVERRIDES[key]).toBe(env);
    }
  });

  it('refines 신내(6) to surface via #1465 역사심도 cross-check', () => {
    // KRRIC underground이지만 seoul-station-depth.csv가 지상(-1.7m)으로 정밀화. override가 SSOT.
    expect(ENVIRONMENT_OVERRIDES['6|신내']).toBe('surface');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ENVIRONMENT_OVERRIDES)).toBe(true);
  });
});

describe('main()', () => {
  const seoulCsvText =
    '"hdr","x","x","x","x","x","x"\n' +
    '"2","한양대","상대식","205","2F","5974","1983"\n';
  const stationsJson = JSON.stringify([
    { id: '2-009', name: '한양대', line: '2' },
    { id: '9-001', name: '개화', line: '9' },
  ]);
  const krricLine9Csv =
    '"hdr","x","x","x","x","x","x"\n' +
    '서울시메트로9호선주식회사,9호선,개화,1,상행,지상,1,Y,N,N\n' +
    '서울시메트로9호선주식회사,9호선,개화,2,하행,지상,1,Y,N,N\n';

  function deps(extra = {}) {
    const outs = [];
    const errs = [];
    const writes = [];
    return {
      writeOut: (s) => outs.push(s),
      writeErr: (s) => errs.push(s),
      readFile: (p) => {
        if (p.endsWith('.json')) return stationsJson;
        if (p.includes('-platform.csv')) return krricLine9Csv;
        return seoulCsvText;
      },
      writeFile: (p, c) => writes.push({ p, c }),
      stationsPath: path.join(TEST_TMP_DIR, 's.json'),
      csvPath: path.join(TEST_TMP_DIR, 'c.csv'),
      krricSources: { 9: 'line9-platform.csv' },
      fixturesDir: path.join(TEST_TMP_DIR, 'fixtures'),
      ...extra,
      _captured: { outs, errs, writes },
    };
  }

  it('returns 0, prints stats, writes file by default', () => {
    const d = deps();
    const code = main([], d);
    expect(code).toBe(0);
    expect(d._captured.outs.some((s) => /2 stations classified/.test(s))).toBe(true);
    expect(d._captured.outs.some((s) => /surface=2.*unknown=0/.test(s))).toBe(true);
    expect(d._captured.outs.some((s) => /wrote/.test(s))).toBe(true);
    expect(d._captured.writes.length).toBe(1);
    const written = JSON.parse(d._captured.writes[0].c);
    expect(written[0].environment).toBe('surface');
    expect(written[1].environment).toBe('surface');
  });

  it('--dry-run skips file write and prints dry-run notice', () => {
    const d = deps();
    const code = main(['--dry-run'], d);
    expect(code).toBe(0);
    expect(d._captured.writes).toEqual([]);
    expect(d._captured.outs.some((s) => /dry-run/.test(s))).toBe(true);
  });

  it('omits manual-curation block when all stations matched', () => {
    const d = deps();
    const code = main(['--dry-run'], d);
    expect(code).toBe(0);
    expect(d._captured.outs.every((s) => !/need manual curation/.test(s))).toBe(true);
  });

  it('lists unknown stations when present', () => {
    const d = deps({
      readFile: (p) => {
        if (p.endsWith('.json'))
          return JSON.stringify([{ id: 'sinbundang-001', name: '광교', line: 'sinbundang' }]);
        if (p.includes('-platform.csv')) return krricLine9Csv;
        return seoulCsvText;
      },
    });
    const code = main(['--dry-run'], d);
    expect(code).toBe(0);
    expect(d._captured.outs.some((s) => /need manual curation/.test(s))).toBe(true);
    expect(d._captured.outs.some((s) => /광교/.test(s))).toBe(true);
  });

  it('returns 1 when stations.json read fails', () => {
    const d = deps({
      readFile: (p) => {
        if (p.endsWith('.json')) throw new Error('boom');
        return seoulCsvText;
      },
    });
    const code = main([], d);
    expect(code).toBe(1);
    expect(d._captured.errs.some((s) => /stations\.json 읽기 실패.*boom/.test(s))).toBe(true);
  });

  it('returns 1 when seoul CSV read fails', () => {
    const d = deps({
      readFile: (p) => {
        if (p.endsWith('.json')) return stationsJson;
        if (p.includes('-platform.csv')) return krricLine9Csv;
        throw new Error('no-csv');
      },
    });
    const code = main([], d);
    expect(code).toBe(1);
    expect(d._captured.errs.some((s) => /CSV 읽기 실패.*no-csv/.test(s))).toBe(true);
  });

  it('prints krric source counter in stats line (#1466)', () => {
    const d = deps();
    const code = main(['--dry-run'], d);
    expect(code).toBe(0);
    expect(d._captured.outs.some((s) => /source.*krric=/.test(s))).toBe(true);
  });

  it('returns 1 when KRRIC CSV read fails', () => {
    const d = deps({
      readFile: (p) => {
        if (p.includes('-platform.csv')) throw new Error('no-krric');
        if (p.endsWith('.json')) return stationsJson;
        return seoulCsvText;
      },
    });
    const code = main([], d);
    expect(code).toBe(1);
    expect(d._captured.errs.some((s) => /KRRIC CSV\(9\) 읽기 실패.*no-krric/.test(s))).toBe(true);
  });

  it('classifies 9호선 stations via line9 CSV in main()', () => {
    const d = deps();
    const code = main([], d);
    expect(code).toBe(0);
    const written = JSON.parse(d._captured.writes[0].c);
    const line9 = written.find((s) => s.line === '9');
    expect(line9.environment).toBe('surface');
  });

  it('prints cross-check diffs when KRRIC disagrees with seoul', () => {
    // KRRIC: 개화 = surface (지상), seoul: 개화 = underground (B2) → diff.
    const seoulMismatch =
      '"hdr","x","x","x","x","x","x"\n' +
      '"9","개화","상대식","205","B2","100","2009"\n';
    const d = deps({
      readFile: (p) => {
        if (p.endsWith('.json')) return JSON.stringify([{ id: '9-001', name: '개화', line: '9' }]);
        if (p.includes('-platform.csv')) return krricLine9Csv;
        return seoulMismatch;
      },
    });
    const code = main(['--dry-run'], d);
    expect(code).toBe(0);
    expect(d._captured.outs.some((s) => /cross-check diffs/.test(s))).toBe(true);
    expect(
      d._captured.outs.some((s) => /9\|개화\s+krric=surface\s+seoul=underground/.test(s)),
    ).toBe(true);
  });
});
