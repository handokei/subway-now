/**
 * build-station-environment (#1434) — classifyFloor / parseCsv / build / main
 * 단위 테스트. ADR-015 §1 Deterministic Environment SSOT.
 */

const {
  classifyFloor,
  parseCsv,
  parseCsvRow,
  build,
  ENVIRONMENT_OVERRIDES,
  VALID_ENVIRONMENTS,
  main,
} = require('../build-station-environment');

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
    expect(Object.prototype.hasOwnProperty.call(ENVIRONMENT_OVERRIDES, localOverride)).toBe(true);
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
});

describe('VALID_ENVIRONMENTS', () => {
  it('exposes the four enum values', () => {
    expect([...VALID_ENVIRONMENTS].sort()).toEqual(
      ['mixed', 'surface', 'underground', 'unknown'].sort(),
    );
  });
});

describe('ENVIRONMENT_OVERRIDES', () => {
  it('covers all user-verification trip stations from ADR-015 §1', () => {
    // E1 acceptance: 사용자 trip 역들이 모두 명시 분류되어야 함.
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

  it('is frozen', () => {
    expect(Object.isFrozen(ENVIRONMENT_OVERRIDES)).toBe(true);
  });
});

describe('main()', () => {
  const csvText =
    '"hdr","x","x","x","x","x","x"\n' +
    '"2","한양대","상대식","205","2F","5974","1983"\n';
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
      readFile: (p) => (p.endsWith('.csv') ? csvText : stationsJson),
      writeFile: (p, c) => writes.push({ p, c }),
      stationsPath: '/tmp/s.json',
      csvPath: '/tmp/c.csv',
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
        if (p.endsWith('.csv')) throw new Error('no-csv');
        return stationsJson;
      },
    });
    const code = main([], d);
    expect(code).toBe(1);
    expect(d._captured.errs.some((s) => /CSV 읽기 실패.*no-csv/.test(s))).toBe(true);
  });
});
