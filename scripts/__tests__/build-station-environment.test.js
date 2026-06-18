/**
 * build-station-environment (#1434) — classifyFloor / parseCsv / build / main
 * 단위 테스트. ADR-015 §1 Deterministic Environment SSOT.
 */

const path = require('node:path');
const os = require('node:os');
const {
  classifyFloor,
  classifySurfaceColumn,
  parseCsv,
  parseCsvRow,
  parseGyeonguiCsv,
  reduceEnvSet,
  build,
  ENVIRONMENT_OVERRIDES,
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

describe('classifySurfaceColumn (#1461)', () => {
  it.each([
    ['지상', 'surface'],
    ['지하', 'underground'],
    [' 지상 ', 'surface'],
    [' 지하 ', 'underground'],
    ['', 'unknown'],
    ['지상부', 'unknown'],
  ])('classifies %p → %s', (col, expected) => {
    expect(classifySurfaceColumn(col)).toBe(expected);
  });

  it.each([[null], [undefined], [123], [{}]])(
    'returns unknown for non-string (%p)',
    (input) => {
      expect(classifySurfaceColumn(input)).toBe('unknown');
    },
  );
});

describe('reduceEnvSet (#1461)', () => {
  it.each([
    [['surface'], 'surface'],
    [['underground'], 'underground'],
    [['surface', 'underground'], 'mixed'],
    [['surface', 'unknown'], 'surface'],
    [['underground', 'unknown'], 'underground'],
    [['unknown'], 'unknown'],
    [[], 'unknown'],
  ])('reduces %p → %s', (arr, expected) => {
    expect(reduceEnvSet(new Set(arr))).toBe(expected);
  });
});

describe('parseGyeonguiCsv (#1461)', () => {
  it('classifies dual surface row as surface', () => {
    const csv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,회기,1,하행,지상,1\n' +
      '코레일,경의중앙,회기,2,상행,지상,1\n';
    const map = parseGyeonguiCsv(csv);
    expect(map.get('gyeongui|회기')).toBe('surface');
  });

  it('classifies dual underground row as underground', () => {
    const csv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,공덕,2,하행,지하,2\n' +
      '코레일,경의중앙,공덕,1,상행,지하,2\n';
    const map = parseGyeonguiCsv(csv);
    expect(map.get('gyeongui|공덕')).toBe('underground');
  });

  it('classifies station with both surface and underground rows as mixed', () => {
    // 가좌 — 상행/하행 지상구분 다른 실제 케이스.
    const csv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,가좌,1,상행,지상,1\n' +
      '코레일,경의중앙,가좌,2,하행,지하,2\n';
    const map = parseGyeonguiCsv(csv);
    expect(map.get('gyeongui|가좌')).toBe('mixed');
  });

  it('normalizes parenthesized station names', () => {
    const csv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,양원(서울시북부병원),1,상행,지상,1\n';
    const map = parseGyeonguiCsv(csv);
    expect(map.has('gyeongui|양원')).toBe(true);
    expect(map.has('gyeongui|양원(서울시북부병원)')).toBe(false);
  });

  it('skips rows with fewer than 6 columns', () => {
    const csv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분\n' +
      '코레일,경의중앙,공덕,1,상행\n';
    const map = parseGyeonguiCsv(csv);
    expect(map.size).toBe(0);
  });

  it('skips rows with empty station name', () => {
    const csv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,,1,상행,지상,1\n';
    const map = parseGyeonguiCsv(csv);
    expect(map.size).toBe(0);
  });

  it('handles CRLF', () => {
    const csv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\r\n' +
      '코레일,경의중앙,공덕,1,상행,지하,2\r\n';
    const map = parseGyeonguiCsv(csv);
    expect(map.get('gyeongui|공덕')).toBe('underground');
  });
});

describe('build', () => {
  const csvText =
    '"hdr","x","x","x","x","x","x"\n' +
    '"2","왕십리(성동구청)","상대식","205","B2","9877","1983"\n' +
    '"2","한양대","상대식","205","2F","5974","1983"\n' +
    '"1","동묘앞","상대식","210","5FB2","9894.75","2005"\n';

  it('applies CSV classification for 1~8 stations not covered by overrides', () => {
    // 1-동묘앞=mixed via CSV; override map covers 2호선 trip stations only.
    const stations = [{ id: '1-029', name: '동묘앞', line: '1' }];
    const { stations: out, stats } = build({ stations, csvText });
    expect(out[0].environment).toBe('mixed');
    expect(stats.bySource.csv).toBe(1);
    expect(stats.bySource.override).toBe(0);
    expect(stats.bySource.unknown).toBe(0);
    expect(stats.byEnv).toEqual({ surface: 0, underground: 0, mixed: 1, unknown: 0 });
    expect(stats.unknownEntries).toEqual([]);
  });

  it('applies overrides with priority over CSV', () => {
    // CSV says 한양대=surface but override could pick anything; we verify override wins.
    const localOverride = '2|한양대';
    // we cannot mutate frozen ENVIRONMENT_OVERRIDES, so verify override map contains user trip key.
    expect(Object.hasOwn(ENVIRONMENT_OVERRIDES, localOverride)).toBe(true);
    const stations = [{ id: '2-009', name: '한양대', line: '2' }];
    const { stations: out, stats } = build({ stations, csvText });
    expect(out[0].environment).toBe(ENVIRONMENT_OVERRIDES[localOverride]);
    expect(stats.bySource.override).toBe(1);
    expect(stats.bySource.csv).toBe(0);
  });

  it('marks unknown for unmatched stations and reports them', () => {
    const stations = [
      { id: '9-001', name: '개화', line: '9' },
      { id: 'bundang-001', name: '인천', line: 'bundang' },
    ];
    const { stations: out, stats } = build({ stations, csvText });
    expect(out[0].environment).toBe('unknown');
    expect(out[1].environment).toBe('unknown');
    expect(stats.bySource.unknown).toBe(2);
    expect(stats.unknownEntries).toEqual([
      { id: '9-001', name: '개화', line: '9' },
      { id: 'bundang-001', name: '인천', line: 'bundang' },
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

  it('treats CSV row whose floor is empty as unknown source', () => {
    const csv =
      '"hdr","x","x","x","x","x","x"\n' +
      '"2","빈층","상대식","205","","0","1983"\n';
    const stations = [{ id: '2-x', name: '빈층', line: '2' }];
    const { stations: out, stats } = build({ stations, csvText: csv });
    expect(out[0].environment).toBe('unknown');
    expect(stats.bySource.unknown).toBe(1);
    expect(stats.bySource.csv).toBe(0);
  });

  it('applies gyeongui CSV classification when no override and no seoul CSV match (#1461)', () => {
    const gyeonguiCsv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,공덕,1,상행,지하,2\n';
    const stations = [{ id: 'gyeongui-x', name: '공덕', line: 'gyeongui' }];
    const { stations: out, stats } = build({
      stations,
      csvText,
      gyeonguiCsvText: gyeonguiCsv,
    });
    expect(out[0].environment).toBe('underground');
    expect(stats.bySource.gyeonguiCsv).toBe(1);
    expect(stats.bySource.csv).toBe(0);
    expect(stats.bySource.override).toBe(0);
  });

  it('treats gyeongui CSV row whose 지상구분 is invalid as unknown source (#1461)', () => {
    const gyeonguiCsv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,빈층,1,상행,?,1\n';
    const stations = [{ id: 'gyeongui-x', name: '빈층', line: 'gyeongui' }];
    const { stations: out, stats } = build({
      stations,
      csvText,
      gyeonguiCsvText: gyeonguiCsv,
    });
    expect(out[0].environment).toBe('unknown');
    expect(stats.bySource.unknown).toBe(1);
    expect(stats.bySource.gyeonguiCsv).toBe(0);
  });

  it('overrides take priority over gyeongui CSV (#1461)', () => {
    // override가 서울역=underground라고 했고, CSV에 같은 키가 (가상으로) 지상으로 있어도 override 우선.
    const gyeonguiCsv =
      '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
      '코레일,경의중앙,서울역,1,상행,지상,1\n';
    const stations = [{ id: 'gyeongui-x', name: '서울역', line: 'gyeongui' }];
    const { stations: out, stats } = build({
      stations,
      csvText,
      gyeonguiCsvText: gyeonguiCsv,
    });
    expect(out[0].environment).toBe('underground');
    expect(stats.bySource.override).toBe(1);
  });

  it('skips gyeongui CSV when input omitted (back-compat)', () => {
    const stations = [{ id: 'gyeongui-x', name: '공덕', line: 'gyeongui' }];
    const { stations: out, stats } = build({ stations, csvText });
    expect(out[0].environment).toBe('unknown');
    expect(stats.bySource.gyeonguiCsv).toBe(0);
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
    // E1 acceptance: 사용자 trip 역들이 모두 명시 분류되어야 함.
    // 경의중앙선 왕십리는 국가철도공단 CSV가 SSOT(지상) — override에서 제외.
    const expected = {
      '2|성수': 'surface',
      '2|뚝섬': 'surface',
      '2|한양대': 'surface',
      '2|왕십리': 'underground',
      '5|왕십리': 'underground',
      '5|마장': 'underground',
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

  it('is frozen', () => {
    expect(Object.isFrozen(ENVIRONMENT_OVERRIDES)).toBe(true);
  });
});

describe('main()', () => {
  const csvText =
    '"hdr","x","x","x","x","x","x"\n' +
    '"2","한양대","상대식","205","2F","5974","1983"\n';
  const gyeonguiCsvText =
    '철도운영기관명,선명,역명,승강장번호,상하행,지상구분,역층\n' +
    '코레일,경의중앙,공덕,1,상행,지하,2\n';
  const stationsJson = JSON.stringify([
    { id: '2-009', name: '한양대', line: '2' },
    { id: '9-001', name: '개화', line: '9' },
  ]);

  function deps(extra = {}) {
    const outs = [];
    const errs = [];
    const writes = [];
    return {
      writeOut: (s) => outs.push(s),
      writeErr: (s) => errs.push(s),
      readFile: (p) => {
        if (p.endsWith('gyeongui-platform.csv')) return gyeonguiCsvText;
        if (p.endsWith('.csv')) return csvText;
        return stationsJson;
      },
      writeFile: (p, c) => writes.push({ p, c }),
      stationsPath: path.join(TEST_TMP_DIR, 's.json'),
      csvPath: path.join(TEST_TMP_DIR, 'c.csv'),
      gyeonguiCsvPath: path.join(TEST_TMP_DIR, 'gyeongui-platform.csv'),
      ...extra,
      _captured: { outs, errs, writes },
    };
  }

  it('returns 0, prints stats, writes file by default', () => {
    const d = deps();
    const code = main([], d);
    expect(code).toBe(0);
    expect(d._captured.outs.some((s) => /2 stations classified/.test(s))).toBe(true);
    expect(d._captured.outs.some((s) => /surface=1.*unknown=1/.test(s))).toBe(true);
    expect(d._captured.outs.some((s) => /1 stations need manual curation/.test(s))).toBe(true);
    expect(d._captured.outs.some((s) => /wrote/.test(s))).toBe(true);
    expect(d._captured.writes.length).toBe(1);
    // sanity: written content has environment field on both
    const written = JSON.parse(d._captured.writes[0].c);
    expect(written[0].environment).toBe('surface');
    expect(written[1].environment).toBe('unknown');
  });

  it('--dry-run skips file write and prints dry-run notice', () => {
    const d = deps();
    const code = main(['--dry-run'], d);
    expect(code).toBe(0);
    expect(d._captured.writes).toEqual([]);
    expect(d._captured.outs.some((s) => /dry-run/.test(s))).toBe(true);
  });

  it('omits manual-curation block when all stations matched', () => {
    const d = deps({
      readFile: (p) =>
        p.endsWith('.csv')
          ? csvText
          : JSON.stringify([{ id: '2-009', name: '한양대', line: '2' }]),
    });
    const code = main(['--dry-run'], d);
    expect(code).toBe(0);
    expect(d._captured.outs.every((s) => !/need manual curation/.test(s))).toBe(true);
  });

  it('returns 1 when stations.json read fails', () => {
    const d = deps({
      readFile: (p) => {
        if (p.endsWith('.json')) throw new Error('boom');
        return csvText;
      },
    });
    const code = main([], d);
    expect(code).toBe(1);
    expect(d._captured.errs.some((s) => /stations\.json 읽기 실패.*boom/.test(s))).toBe(true);
  });

  it('returns 1 when CSV read fails', () => {
    const d = deps({
      readFile: (p) => {
        // 서울교통공사 CSV만 실패시키기 위해 경의중앙 CSV 경로는 먼저 처리.
        if (p.endsWith('gyeongui-platform.csv')) return gyeonguiCsvText;
        if (p.endsWith('.csv')) throw new Error('no-csv');
        return stationsJson;
      },
    });
    const code = main([], d);
    expect(code).toBe(1);
    expect(d._captured.errs.some((s) => /CSV 읽기 실패.*no-csv/.test(s))).toBe(true);
  });

  it('returns 1 when gyeongui CSV read fails', () => {
    const d = deps({
      readFile: (p) => {
        if (p.endsWith('gyeongui-platform.csv')) throw new Error('no-gy');
        if (p.endsWith('.csv')) return csvText;
        return stationsJson;
      },
    });
    const code = main([], d);
    expect(code).toBe(1);
    expect(d._captured.errs.some((s) => /경의중앙선 CSV 읽기 실패.*no-gy/.test(s))).toBe(true);
  });

  it('prints gyeonguiCsv source count in stats line', () => {
    const d = deps();
    const code = main(['--dry-run'], d);
    expect(code).toBe(0);
    expect(d._captured.outs.some((s) => /gyeonguiCsv=/.test(s))).toBe(true);
  });
});
