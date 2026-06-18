/**
 * cross-check-line-1-8-environment (#1465) — E1 follow-up.
 *
 * classifyDepthFloor / parseDepthRow / parseDepthCsv / build / main 단위 테스트.
 * ADR-015 §1 + 역사심도정보 CSV cross-check + mixed 정밀화.
 */

const path = require('node:path');
const os = require('node:os');
const {
  classifyDepthFloor,
  parseDepthRow,
  parseDepthCsv,
  build,
  LINES_IN_SCOPE,
  VALID_ENVIRONMENTS,
  main,
} = require('../cross-check-line-1-8-environment');

const TEST_TMP_DIR = path.join(os.tmpdir(), 'subway-now-test-1465');

describe('classifyDepthFloor', () => {
  it.each([
    ['B1', 'underground'],
    ['B2', 'underground'],
    ['B8', 'underground'],
    ['고가', 'surface'],
    ['지상', 'surface'],
    ['', 'unknown'],
    ['?', 'unknown'],
    ['1F', 'unknown'],
    ['B', 'unknown'],
    ['B999', 'unknown'],
  ])('classifies %s → %s', (floor, expected) => {
    expect(classifyDepthFloor(floor)).toBe(expected);
  });

  it.each([[null], [undefined], [123], [{}], [[]]])(
    'returns unknown for non-string input (%p)',
    (input) => {
      expect(classifyDepthFloor(input)).toBe('unknown');
    },
  );

  it('trims whitespace', () => {
    expect(classifyDepthFloor('  B2  ')).toBe('underground');
    expect(classifyDepthFloor('  고가  ')).toBe('surface');
  });
});

describe('parseDepthRow', () => {
  it('parses basic underground row', () => {
    const row = '1,1,서울,B2,섬식,129.99,117.04,12.95,11.85,"4호선,경의중앙선,공항철도환승"';
    expect(parseDepthRow(row)).toEqual({
      line: '1',
      name: '서울',
      floor: 'B2',
      depth: 11.85,
    });
  });

  it('parses 고가 surface row with negative depth', () => {
    const row = '40,2,성수,고가,상대식,18.5,30.2,-11.7,-12.8,';
    expect(parseDepthRow(row)).toEqual({
      line: '2',
      name: '성수',
      floor: '고가',
      depth: -12.8,
    });
  });

  it('strips parenthetical 부역명 via normalizeStationName', () => {
    const row = '99,2,왕십리(성동구청),B4,섬식,18,7,10.93,9.83,';
    const result = parseDepthRow(row);
    expect(result).not.toBeNull();
    expect(result.name).toBe('왕십리');
  });

  it('returns null for malformed row', () => {
    expect(parseDepthRow('')).toBeNull();
    expect(parseDepthRow('헤더,헤더,헤더')).toBeNull();
  });

  it('returns null when depth column does not match numeric pattern (NaN literal)', () => {
    const row = '1,1,서울,B2,섬식,129.99,117.04,12.95,NaN,';
    // NaN literal은 (-?[\d.]+) 패턴에 매치 안 됨 → row 자체가 null.
    expect(parseDepthRow(row)).toBeNull();
  });
});

describe('parseDepthCsv', () => {
  it('skips header and builds map', () => {
    const csv = [
      '연번,호선,역명,층수,형식,지반고,레일면고,선로기준정거장깊이,정거장깊이,비고',
      '1,1,서울,B2,섬식,129.99,117.04,12.95,11.85,',
      '2,2,성수,고가,상대식,18,30,-11.7,-12.8,',
    ].join('\n');
    const m = parseDepthCsv(csv);
    expect(m.size).toBe(2);
    expect(m.get('1|서울')).toEqual({ environment: 'underground', floor: 'B2', depth: 11.85 });
    expect(m.get('2|성수')).toEqual({ environment: 'surface', floor: '고가', depth: -12.8 });
  });

  it('skips empty lines and malformed rows', () => {
    const csv = [
      '연번,호선,역명,층수,형식,지반고,레일면고,선로기준정거장깊이,정거장깊이,비고',
      '',
      'malformed',
      '1,1,서울,B2,섬식,1,2,3,4,',
    ].join('\n');
    const m = parseDepthCsv(csv);
    expect(m.size).toBe(1);
  });

  it('handles CRLF line endings', () => {
    const csv =
      '연번,호선,역명,층수,형식,지반고,레일면고,선로기준정거장깊이,정거장깊이,비고\r\n' +
      '1,1,서울,B2,섬식,1,2,3,4,\r\n';
    expect(parseDepthCsv(csv).size).toBe(1);
  });
});

describe('build', () => {
  const csvText = [
    '연번,호선,역명,층수,형식,지반고,레일면고,선로기준정거장깊이,정거장깊이,비고',
    '1,1,동묘앞,B1,섬식,30,20,9.94,8.84,',
    '2,2,성수,고가,상대식,18,30,-11.7,-12.8,',
    '3,2,한양대,B2,상대식,18,7,-2.22,-3.12,',
    '4,5,개화산,B2,상대식,30,23,8.18,7.08,',
    '5,1,서울역,B2,섬식,30,16,15.05,13.95,',
    '6,9,노들,B2,섬식,1,1,1,1,',
    '7,1,unknownFloor,XYZ,섬식,1,1,1,1,',
  ].join('\n');

  const stations = [
    { id: '101', name: '동묘앞', line: '1', environment: 'mixed' },
    { id: '102', name: '성수', line: '2', environment: 'surface' },
    { id: '103', name: '한양대', line: '2', environment: 'surface' }, // conflict
    { id: '104', name: '개화산', line: '5', environment: 'mixed' },
    { id: '105', name: '서울역', line: '4', environment: 'unknown' }, // CSV line 1 only — unmatched
    { id: '106', name: '서울역', line: '1', environment: 'unknown' }, // fill
    { id: '107', name: '노들', line: '9', environment: 'underground' }, // out of scope
    { id: '108', name: '소요산', line: '1', environment: 'unknown' }, // CSV에 없음
    { id: '109', name: 'unknownFloor', line: '1', environment: 'unknown' }, // CSV unknown floor
  ];

  it('refines mixed → CSV value', () => {
    const { stations: next, stats } = build({ stations, csvText });
    const dongmyo = next.find((s) => s.id === '101');
    expect(dongmyo.environment).toBe('underground');
    expect(stats.refinedMixed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: '1', name: '동묘앞', before: 'mixed', after: 'underground' }),
      ]),
    );
  });

  it('fills unknown → CSV value', () => {
    const { stations: next, stats } = build({ stations, csvText });
    const seoul1 = next.find((s) => s.id === '106');
    expect(seoul1.environment).toBe('underground');
    expect(stats.refinedMixed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: '1', name: '서울역', before: 'unknown', after: 'underground' }),
      ]),
    );
  });

  it('preserves agree case without refinement', () => {
    const { stations: next, stats } = build({ stations, csvText });
    const seongsu = next.find((s) => s.id === '102');
    expect(seongsu.environment).toBe('surface');
    expect(stats.agree).toBeGreaterThanOrEqual(1);
  });

  it('reports conflict without auto-updating', () => {
    const { stations: next, stats } = build({ stations, csvText });
    const hanyang = next.find((s) => s.id === '103');
    expect(hanyang.environment).toBe('surface'); // 자동 갱신 X
    expect(stats.conflicts).toEqual([
      expect.objectContaining({
        line: '2',
        name: '한양대',
        current: 'surface',
        csv: 'underground',
        floor: 'B2',
        depth: -3.12,
      }),
    ]);
  });

  it('skips stations outside lines 1~8', () => {
    const { stations: next } = build({ stations, csvText });
    const nodeul = next.find((s) => s.id === '107');
    expect(nodeul.environment).toBe('underground'); // 변경 X
  });

  it('records unmatched when CSV has no entry for (line, name)', () => {
    const { stats } = build({ stations, csvText });
    expect(stats.unmatched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: '1', name: '소요산', current: 'unknown' }),
      ]),
    );
  });

  it('records unmatched when CSV entry classifies to unknown', () => {
    const { stats } = build({ stations, csvText });
    expect(stats.unmatched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: '1', name: 'unknownFloor', current: 'unknown' }),
      ]),
    );
  });

  it('counts scoped stations correctly', () => {
    const { stats } = build({ stations, csvText });
    expect(stats.scoped).toBe(8); // 9 - 1 (line 9)
  });

  it('handles non-string line via empty fallback', () => {
    const out = build({ stations: [{ id: 'x', name: '서울', line: 7, environment: 'unknown' }], csvText });
    // line이 number이므로 scoped X
    expect(out.stats.scoped).toBe(0);
  });

  it('handles non-string name via empty fallback', () => {
    const out = build({ stations: [{ id: 'x', name: 123, line: '1', environment: 'unknown' }], csvText });
    expect(out.stats.scoped).toBe(1);
    expect(out.stats.unmatched).toHaveLength(1);
  });

  it('normalizes non-string current to unknown then fills from CSV', () => {
    const csv =
      '연번,호선,역명,층수,형식,지반고,레일면고,선로기준정거장깊이,정거장깊이,비고\n' +
      '1,1,서울,B2,섬식,1,1,1,11.85,\n';
    const out = build({
      stations: [{ id: 'x', name: '서울', line: '1', environment: 7 }],
      csvText: csv,
    });
    // current가 string 아니므로 'unknown'으로 normalize → CSV underground 채움.
    expect(out.stations[0].environment).toBe('underground');
  });
});

describe('exports', () => {
  it('LINES_IN_SCOPE includes 1~8', () => {
    for (const n of ['1', '2', '3', '4', '5', '6', '7', '8']) {
      expect(LINES_IN_SCOPE.has(n)).toBe(true);
    }
    expect(LINES_IN_SCOPE.has('9')).toBe(false);
  });

  it('VALID_ENVIRONMENTS covers 4 values', () => {
    expect(VALID_ENVIRONMENTS.has('surface')).toBe(true);
    expect(VALID_ENVIRONMENTS.has('underground')).toBe(true);
    expect(VALID_ENVIRONMENTS.has('mixed')).toBe(true);
    expect(VALID_ENVIRONMENTS.has('unknown')).toBe(true);
  });
});

describe('main (CLI)', () => {
  const fs = require('node:fs');
  beforeAll(() => fs.mkdirSync(TEST_TMP_DIR, { recursive: true }));

  function withFiles(stationsArr, csvText, fn) {
    const stationsPath = path.join(TEST_TMP_DIR, `stations-${Date.now()}-${Math.random()}.json`);
    const csvPath = path.join(TEST_TMP_DIR, `depth-${Date.now()}-${Math.random()}.csv`);
    fs.writeFileSync(stationsPath, JSON.stringify(stationsArr));
    fs.writeFileSync(csvPath, csvText);
    try {
      return fn({ stationsPath, csvPath });
    } finally {
      fs.unlinkSync(stationsPath);
      fs.unlinkSync(csvPath);
    }
  }

  it('writes refined stations.json when changes detected', () => {
    const csv =
      '연번,호선,역명,층수,형식,지반고,레일면고,선로기준정거장깊이,정거장깊이,비고\n' +
      '1,1,동묘앞,B1,섬식,1,1,1,8.84,\n';
    const stations = [{ id: '101', name: '동묘앞', line: '1', environment: 'mixed' }];
    withFiles(stations, csv, ({ stationsPath, csvPath }) => {
      const out = [];
      const code = main([], {
        stationsPath,
        csvPath,
        writeOut: (s) => out.push(s),
        writeErr: (s) => out.push(`ERR: ${s}`),
      });
      expect(code).toBe(0);
      const written = JSON.parse(fs.readFileSync(stationsPath, 'utf8'));
      expect(written[0].environment).toBe('underground');
      expect(out.join('\n')).toMatch(/refined 1 entries/u);
      expect(out.join('\n')).toMatch(/wrote/u);
    });
  });

  it('does NOT write when no changes (agree only)', () => {
    const csv =
      '연번,호선,역명,층수,형식,지반고,레일면고,선로기준정거장깊이,정거장깊이,비고\n' +
      '1,2,성수,고가,상대식,1,1,1,1,\n';
    const stations = [{ id: '102', name: '성수', line: '2', environment: 'surface' }];
    withFiles(stations, csv, ({ stationsPath, csvPath }) => {
      const before = fs.readFileSync(stationsPath, 'utf8');
      const out = [];
      const code = main([], {
        stationsPath,
        csvPath,
        writeOut: (s) => out.push(s),
        writeErr: (s) => out.push(`ERR: ${s}`),
      });
      expect(code).toBe(0);
      expect(fs.readFileSync(stationsPath, 'utf8')).toBe(before);
      expect(out.join('\n')).toMatch(/no changes/u);
    });
  });

  it('honors --dry-run (no write even with changes)', () => {
    const csv =
      '연번,호선,역명,층수,형식,지반고,레일면고,선로기준정거장깊이,정거장깊이,비고\n' +
      '1,1,동묘앞,B1,섬식,1,1,1,8.84,\n';
    const stations = [{ id: '101', name: '동묘앞', line: '1', environment: 'mixed' }];
    withFiles(stations, csv, ({ stationsPath, csvPath }) => {
      const before = fs.readFileSync(stationsPath, 'utf8');
      const out = [];
      const code = main(['--dry-run'], {
        stationsPath,
        csvPath,
        writeOut: (s) => out.push(s),
        writeErr: () => {},
      });
      expect(code).toBe(0);
      expect(fs.readFileSync(stationsPath, 'utf8')).toBe(before);
      expect(out.join('\n')).toMatch(/dry-run/u);
    });
  });

  it('returns 1 when stations.json read fails', () => {
    const errs = [];
    const code = main([], {
      stationsPath: '/no/such/path.json',
      csvPath: '/dev/null',
      writeOut: () => {},
      writeErr: (s) => errs.push(s),
    });
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/stations\.json 읽기 실패/u);
  });

  it('returns 1 when CSV read fails', () => {
    const stationsPath = path.join(TEST_TMP_DIR, `stations-err-${Date.now()}.json`);
    fs.writeFileSync(stationsPath, '[]');
    const errs = [];
    const code = main([], {
      stationsPath,
      csvPath: '/no/such/depth.csv',
      writeOut: () => {},
      writeErr: (s) => errs.push(s),
    });
    fs.unlinkSync(stationsPath);
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/depth CSV 읽기 실패/u);
  });

  it('reports conflicts when detected', () => {
    const csv =
      '연번,호선,역명,층수,형식,지반고,레일면고,선로기준정거장깊이,정거장깊이,비고\n' +
      '1,2,한양대,B2,상대식,1,1,1,-3.12,\n';
    const stations = [{ id: '103', name: '한양대', line: '2', environment: 'surface' }];
    withFiles(stations, csv, ({ stationsPath, csvPath }) => {
      const out = [];
      const code = main([], {
        stationsPath,
        csvPath,
        writeOut: (s) => out.push(s),
        writeErr: () => {},
      });
      expect(code).toBe(0);
      const written = JSON.parse(fs.readFileSync(stationsPath, 'utf8'));
      expect(written[0].environment).toBe('surface'); // 자동 갱신 X
      expect(out.join('\n')).toMatch(/1 conflicts/u);
    });
  });

  it('reports unmatched count', () => {
    const csv =
      '연번,호선,역명,층수,형식,지반고,레일면고,선로기준정거장깊이,정거장깊이,비고\n' +
      '1,1,서울,B2,섬식,1,1,1,1,\n';
    const stations = [{ id: '999', name: '소요산', line: '1', environment: 'unknown' }];
    withFiles(stations, csv, ({ stationsPath, csvPath }) => {
      const out = [];
      const code = main([], {
        stationsPath,
        csvPath,
        writeOut: (s) => out.push(s),
        writeErr: () => {},
      });
      expect(code).toBe(0);
      expect(out.join('\n')).toMatch(/1 unmatched/u);
    });
  });
});
