/**
 * #1397: regenerate-stations 스크립트 단위 테스트.
 * 변환 로직을 pure function으로 분리해 결정론성 + 회귀 방지 검증.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  LINE_TO_ROUTES,
  ROUTE_TO_LINE,
  RENAME_MAP,
  MATCH_RATIO_FLOOR,
  joinKey,
  splitName,
  fetchPage,
  fetchAll,
  buildApiIndex,
  normalizePatch,
  applyRenames,
  serialize,
  main,
} = require('../regenerate-stations');

describe('상수', () => {
  it('LINE_TO_ROUTES + ROUTE_TO_LINE 역방향 일관성', () => {
    for (const [line, routes] of Object.entries(LINE_TO_ROUTES)) {
      for (const r of routes) {
        expect(ROUTE_TO_LINE.get(r)).toBe(line);
      }
    }
  });

  it('RENAME_MAP은 자양(뚝섬한강공원) 케이스 포함', () => {
    expect(RENAME_MAP['7|뚝섬유원지']).toBeDefined();
    const v = RENAME_MAP['7|뚝섬유원지'];
    expect(typeof v).toBe('object');
    expect(v.name).toBe('자양(뚝섬한강공원)');
  });

  it('MATCH_RATIO_FLOOR은 보수적인 floor', () => {
    expect(MATCH_RATIO_FLOOR).toBeGreaterThan(0.5);
    expect(MATCH_RATIO_FLOOR).toBeLessThanOrEqual(1);
  });
});

describe('joinKey', () => {
  it('line | name 결합', () => {
    expect(joinKey('7', '자양')).toBe('7|자양');
    expect(joinKey('airport', '인천국제공항1터미널')).toBe('airport|인천국제공항1터미널');
  });
});

describe('splitName', () => {
  it('괄호 부제 분리', () => {
    expect(splitName('교대(법원.검찰청)')).toEqual({
      base: '교대',
      full: '교대(법원.검찰청)',
    });
  });

  it('괄호 없으면 base = full', () => {
    expect(splitName('서울역')).toEqual({ base: '서울역', full: '서울역' });
  });

  it('맨 앞 괄호는 base = full', () => {
    expect(splitName('(가상역)')).toEqual({ base: '(가상역)', full: '(가상역)' });
  });

  it('trim 적용', () => {
    expect(splitName('  자양(뚝섬한강공원)  ')).toEqual({
      base: '자양',
      full: '자양(뚝섬한강공원)',
    });
  });

  it('비문자열은 base/full 빈 문자열', () => {
    expect(splitName(null)).toEqual({ base: '', full: '' });
    expect(splitName(undefined)).toEqual({ base: '', full: '' });
    expect(splitName(123)).toEqual({ base: '', full: '' });
  });

  it('빈 문자열은 base/full 빈 문자열', () => {
    expect(splitName('')).toEqual({ base: '', full: '' });
  });
});

describe('buildApiIndex', () => {
  it('ROUTE → line + base name으로 인덱스 빌드', () => {
    const apiRows = [
      { BLDN_ID: '0150', BLDN_NM: '서울역', ROUTE: '1호선', LAT: '37.5', LOT: '127' },
      { BLDN_ID: '2522', BLDN_NM: '자양(뚝섬한강공원)', ROUTE: '7호선', LAT: '37.5', LOT: '127' },
      { BLDN_ID: '0329', BLDN_NM: '교대(법원.검찰청)', ROUTE: '3호선', LAT: '37.5', LOT: '127' },
    ];
    const idx = buildApiIndex(apiRows);
    expect(idx.get('1|서울역')).toBe('서울역');
    expect(idx.get('7|자양')).toBe('자양(뚝섬한강공원)');
    expect(idx.get('3|교대')).toBe('교대(법원.검찰청)');
  });

  it('매핑 안되는 ROUTE는 무시', () => {
    const idx = buildApiIndex([
      { BLDN_NM: '미스터리역', ROUTE: '미존재노선' },
    ]);
    expect(idx.size).toBe(0);
  });

  it('BLDN_NM 누락(빈 문자열) 행은 건너뜀', () => {
    const idx = buildApiIndex([
      { BLDN_NM: '', ROUTE: '1호선' },
      { BLDN_NM: '서울역', ROUTE: '1호선' },
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get('1|서울역')).toBe('서울역');
  });

  it('같은 (line, base)에 여러 매칭 시 첫 발견 유지', () => {
    const idx = buildApiIndex([
      { BLDN_NM: '자양(뚝섬한강공원)', ROUTE: '7호선' },
      { BLDN_NM: '자양(다른표기)', ROUTE: '7호선' },
    ]);
    expect(idx.get('7|자양')).toBe('자양(뚝섬한강공원)');
  });
});

describe('normalizePatch', () => {
  it('문자열은 { name }로 변환', () => {
    expect(normalizePatch('자양(뚝섬한강공원)')).toEqual({ name: '자양(뚝섬한강공원)' });
  });

  it('객체는 정의된 i18n 필드까지 patch', () => {
    expect(
      normalizePatch({
        name: '자양(뚝섬한강공원)',
        nameEn: 'Jayang',
        nameJa: 'チャヤン',
        nameHanja: '紫陽',
      }),
    ).toEqual({
      name: '자양(뚝섬한강공원)',
      nameEn: 'Jayang',
      nameJa: 'チャヤン',
      nameHanja: '紫陽',
    });
  });

  it('부분 정의된 객체는 정의된 필드만 patch', () => {
    expect(normalizePatch({ name: '자양', nameEn: 'Jayang' })).toEqual({
      name: '자양',
      nameEn: 'Jayang',
    });
  });

  it('타입 불일치 i18n 필드는 무시', () => {
    expect(
      normalizePatch({
        name: '자양',
        nameEn: 42,
        nameJa: null,
        nameHanja: undefined,
      }),
    ).toEqual({ name: '자양' });
  });

  it('name이 없거나 비문자열이면 null', () => {
    expect(normalizePatch({})).toBeNull();
    expect(normalizePatch({ name: 42 })).toBeNull();
    expect(normalizePatch(null)).toBeNull();
    expect(normalizePatch(undefined)).toBeNull();
    expect(normalizePatch(42)).toBeNull();
  });
});

describe('applyRenames', () => {
  const baseStation = (overrides = {}) => ({
    id: '7-020',
    name: '뚝섬유원지',
    line: '7',
    lineColor: '#747F00',
    lat: 37.5,
    lng: 127,
    nameEn: 'Ttukseom',
    nameJa: 'トゥクソム',
    ...overrides,
  });

  it('RENAME_MAP이 API보다 우선', () => {
    const stations = [baseStation()];
    const apiIndex = new Map([['7|뚝섬유원지', 'API임시명']]);
    const renameMap = { '7|뚝섬유원지': '자양(뚝섬한강공원)' };
    const { stations: out, stats } = applyRenames(stations, apiIndex, renameMap);
    expect(out[0].name).toBe('자양(뚝섬한강공원)');
    expect(stats.renamed).toBe(1);
    expect(stats.unchanged).toBe(0);
    expect(stats.renames).toEqual([
      { id: '7-020', line: '7', from: '뚝섬유원지', to: '자양(뚝섬한강공원)' },
    ]);
  });

  it('객체 patch는 i18n 필드도 갱신, 미지정 필드는 보존', () => {
    const stations = [baseStation()];
    const renameMap = {
      '7|뚝섬유원지': {
        name: '자양(뚝섬한강공원)',
        nameEn: 'Jayang(Ttukseom Hangang Park)',
        nameJa: 'チャヤン',
      },
    };
    const { stations: out } = applyRenames(stations, new Map(), renameMap);
    expect(out[0]).toMatchObject({
      id: '7-020',
      line: '7',
      lat: 37.5,
      lng: 127,
      name: '자양(뚝섬한강공원)',
      nameEn: 'Jayang(Ttukseom Hangang Park)',
      nameJa: 'チャヤン',
    });
  });

  it('RENAME_MAP에 없으면 API 인덱스로 fallback', () => {
    const stations = [baseStation({ name: '교대' })];
    const apiIndex = new Map([['7|교대', '교대(법원.검찰청)']]);
    const { stations: out, stats } = applyRenames(stations, apiIndex, {});
    expect(out[0].name).toBe('교대(법원.검찰청)');
    expect(stats.renamed).toBe(1);
  });

  it('변경 없으면 unchanged++, 원본 station 객체 그대로 반환', () => {
    const stations = [baseStation({ name: '서울역' })];
    const { stations: out, stats } = applyRenames(stations, new Map(), {});
    expect(out[0]).toBe(stations[0]); // same reference
    expect(stats.unchanged).toBe(1);
    expect(stats.renamed).toBe(0);
  });

  it('정식명이 이미 적용된 station(괄호 포함)은 base로 lookup해도 동일하면 unchanged', () => {
    const stations = [baseStation({ name: '자양(뚝섬한강공원)' })];
    const renameMap = {
      '7|자양': { name: '자양(뚝섬한강공원)' },
    };
    const { stations: out, stats } = applyRenames(stations, new Map(), renameMap);
    expect(out[0]).toBe(stations[0]);
    expect(stats.unchanged).toBe(1);
  });

  it('RENAME_MAP 누락 + API 누락이면 변경 없음', () => {
    const stations = [baseStation({ name: '존재하지않는역' })];
    const { stations: out, stats } = applyRenames(stations, new Map(), {});
    expect(out[0]).toBe(stations[0]);
    expect(stats.unchanged).toBe(1);
  });

  it('입력 순서 유지', () => {
    const stations = [
      baseStation({ id: 'a', name: 'A' }),
      baseStation({ id: 'b', name: 'B' }),
      baseStation({ id: 'c', name: 'C' }),
    ];
    const renameMap = { '7|B': { name: 'B2' } };
    const { stations: out } = applyRenames(stations, new Map(), renameMap);
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(out[1].name).toBe('B2');
  });

  it('default renameMap 인자로도 작동', () => {
    const stations = [baseStation()];
    // 기본 RENAME_MAP에 자양 케이스 등록되어 있음
    const { stations: out } = applyRenames(stations, new Map());
    expect(out[0].name).toBe('자양(뚝섬한강공원)');
  });
});

describe('serialize', () => {
  it('2-space indent + trailing newline', () => {
    const out = serialize([{ a: 1 }]);
    expect(out).toBe('[\n  {\n    "a": 1\n  }\n]\n');
  });
});

describe('fetchPage', () => {
  it('성공 응답 row 반환', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        subwayStationMaster: {
          RESULT: { CODE: 'INFO-000', MESSAGE: '정상 처리되었습니다' },
          row: [{ BLDN_NM: '서울역', ROUTE: '1호선' }],
        },
      }),
    });
    const rows = await fetchPage('key', 1, 1000, fetcher);
    expect(rows).toEqual([{ BLDN_NM: '서울역', ROUTE: '1호선' }]);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/subwayStationMaster/1/1000/'));
  });

  it('INFO-200(데이터 끝) 응답은 빈 배열', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ RESULT: { CODE: 'INFO-200', MESSAGE: '데이터 없음' } }),
    });
    const rows = await fetchPage('key', 1001, 2000, fetcher);
    expect(rows).toEqual([]);
  });

  it('row 없는 wrapper는 빈 배열', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        subwayStationMaster: { RESULT: { CODE: 'INFO-000', MESSAGE: 'ok' } },
      }),
    });
    const rows = await fetchPage('key', 1, 10, fetcher);
    expect(rows).toEqual([]);
  });

  it('HTTP not ok → throw', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await expect(fetchPage('key', 1, 10, fetcher)).rejects.toThrow(/HTTP 500/);
  });

  it('wrapper 누락 + INFO-200 아님 → throw', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unrelated: true }),
    });
    await expect(fetchPage('key', 1, 10, fetcher)).rejects.toThrow(/unexpected response/);
  });

  it('API 오류 코드(INFO-000 아님) → throw', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        subwayStationMaster: {
          RESULT: { CODE: 'ERROR-300', MESSAGE: '인증 키 오류' },
        },
      }),
    });
    await expect(fetchPage('key', 1, 10, fetcher)).rejects.toThrow(/API error: ERROR-300/);
  });
});

describe('fetchAll', () => {
  it('페이지네이션 — 한 페이지보다 적게 받으면 종료', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        subwayStationMaster: {
          RESULT: { CODE: 'INFO-000' },
          row: [{ BLDN_NM: '서울역', ROUTE: '1호선' }],
        },
      }),
    });
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const rows = await fetchAll('key', fetcher, sleepFn);
    expect(rows.length).toBe(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('페이지네이션 — 페이지 가득 차면 다음 페이지 fetch', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      BLDN_NM: `역${i}`,
      ROUTE: '1호선',
    }));
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          subwayStationMaster: { RESULT: { CODE: 'INFO-000' }, row: fullPage },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          subwayStationMaster: {
            RESULT: { CODE: 'INFO-000' },
            row: [{ BLDN_NM: '끝', ROUTE: '1호선' }],
          },
        }),
      });
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const rows = await fetchAll('key', fetcher, sleepFn);
    expect(rows.length).toBe(1001);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });
});

describe('main()', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-stations-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeStations = (data) => {
    const p = path.join(tmpDir, 'stations.json');
    fs.writeFileSync(p, JSON.stringify(data));
    return p;
  };

  const captureDeps = (overrides = {}) => {
    const outs = [];
    const errs = [];
    const writes = [];
    return {
      outs,
      errs,
      writes,
      deps: {
        writeOut: (s) => outs.push(s),
        writeErr: (s) => errs.push(s),
        writeFile: (p, c) => writes.push({ p, c }),
        env: {},
        ...overrides,
      },
    };
  };

  it('--offline + 기본 RENAME_MAP으로 자양 갱신', async () => {
    const stationsPath = writeStations([
      {
        id: '7-020',
        name: '뚝섬유원지',
        line: '7',
        lineColor: '#747F00',
        lat: 37.53154,
        lng: 127.066704,
      },
    ]);
    const { outs, errs, writes, deps } = captureDeps();
    const code = await main(['node', 'regen', '--offline'], {
      ...deps,
      stationsPath,
    });
    expect(code).toBe(0);
    expect(outs.some((s) => /offline mode/.test(s))).toBe(true);
    expect(outs.some((s) => /갱신: 1개, 유지: 0개/.test(s))).toBe(true);
    expect(outs.some((s) => /자양\(뚝섬한강공원\)/.test(s))).toBe(true);
    expect(errs).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0].p).toBe(stationsPath);
    const parsed = JSON.parse(writes[0].c);
    expect(parsed[0].name).toBe('자양(뚝섬한강공원)');
  });

  it('API 키 없음 + --offline 없음이면 exit 1', async () => {
    const stationsPath = writeStations([]);
    const { errs, deps } = captureDeps();
    const code = await main(['node', 'regen'], {
      ...deps,
      stationsPath,
    });
    expect(code).toBe(1);
    expect(errs.some((s) => /EXPO_PUBLIC_SEOUL_DATA_API_KEY/.test(s))).toBe(true);
  });

  it('stations.json 읽기 실패 시 exit 1', async () => {
    const { errs, deps } = captureDeps();
    const code = await main(['node', 'regen', '--offline'], {
      ...deps,
      stationsPath: path.join(tmpDir, 'does-not-exist.json'),
    });
    expect(code).toBe(1);
    expect(errs.some((s) => /stations\.json 읽기 실패/.test(s))).toBe(true);
  });

  it('stations.json root가 배열 아니면 exit 1', async () => {
    const stationsPath = writeStations({ not: 'array' });
    const { errs, deps } = captureDeps();
    const code = await main(['node', 'regen', '--offline'], {
      ...deps,
      stationsPath,
    });
    expect(code).toBe(1);
    expect(errs.some((s) => /root가 배열이 아님/.test(s))).toBe(true);
  });

  it('online mode + 성공적인 API fetch + 갱신', async () => {
    const stationsPath = writeStations([
      { id: '1-001', name: '서울역', line: '1', lineColor: '#0052A4', lat: 37.5, lng: 127 },
    ]);
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        subwayStationMaster: {
          RESULT: { CODE: 'INFO-000' },
          row: [{ BLDN_NM: '서울역', ROUTE: '1호선' }],
        },
      }),
    });
    const { outs, errs, writes, deps } = captureDeps({
      env: { EXPO_PUBLIC_SEOUL_DATA_API_KEY: 'fake-key' },
      fetcher,
      sleepFn: jest.fn().mockResolvedValue(undefined),
    });
    const code = await main(['node', 'regen'], {
      ...deps,
      stationsPath,
    });
    expect(code).toBe(0);
    expect(errs).toEqual([]);
    expect(outs.some((s) => /API 인덱스 매칭률/.test(s))).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it('online mode + API 매칭률 floor 미달 시 exit 1', async () => {
    const stationsPath = writeStations([
      { id: '1-001', name: '서울역', line: '1', lineColor: '#0052A4', lat: 37.5, lng: 127 },
      { id: '1-002', name: '시청', line: '1', lineColor: '#0052A4', lat: 37.5, lng: 127 },
    ]);
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        subwayStationMaster: {
          RESULT: { CODE: 'INFO-000' },
          row: [], // API 응답 비어있음 → 매칭률 0%
        },
      }),
    });
    const { errs, deps } = captureDeps({
      env: { EXPO_PUBLIC_SEOUL_DATA_API_KEY: 'fake-key' },
      fetcher,
    });
    const code = await main(['node', 'regen'], {
      ...deps,
      stationsPath,
    });
    expect(code).toBe(1);
    expect(errs.some((s) => /매칭률.*보존, abort/.test(s))).toBe(true);
  });

  it('online mode + fetch throw 시 exit 1', async () => {
    const stationsPath = writeStations([
      { id: '1-001', name: '서울역', line: '1', lineColor: '#0052A4', lat: 37.5, lng: 127 },
    ]);
    const fetcher = jest.fn().mockRejectedValue(new Error('network down'));
    const { errs, deps } = captureDeps({
      env: { EXPO_PUBLIC_SEOUL_DATA_API_KEY: 'fake-key' },
      fetcher,
    });
    const code = await main(['node', 'regen'], {
      ...deps,
      stationsPath,
    });
    expect(code).toBe(1);
    expect(errs.some((s) => /API fetch 실패: network down/.test(s))).toBe(true);
  });

  it('default deps(--offline + 실제 file write) 동작', async () => {
    const stationsPath = writeStations([
      {
        id: '7-020',
        name: '뚝섬유원지',
        line: '7',
        lineColor: '#747F00',
        lat: 37.53154,
        lng: 127.066704,
      },
    ]);
    // writeOut/writeErr 기본 — process.stdout/stderr 캡처
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const captured = { out: [], err: [] };
    process.stdout.write = (s) => {
      captured.out.push(String(s));
      return true;
    };
    process.stderr.write = (s) => {
      captured.err.push(String(s));
      return true;
    };
    let code;
    try {
      code = await main(['node', 'regen', '--offline'], { stationsPath });
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(code).toBe(0);
    expect(captured.out.join('')).toMatch(/자양/);
    const parsed = JSON.parse(fs.readFileSync(stationsPath, 'utf8'));
    expect(parsed[0].name).toBe('자양(뚝섬한강공원)');
  });
});
