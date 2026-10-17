/**
 * #474 — fetch-last-train ETL 단위 테스트.
 *
 * 정책:
 *  - 외부 fetch는 mock으로 대체, sleep은 noop.
 *  - 결과 파일 IO는 임시 디렉토리 격리(REPO 경로 직접 쓰기 없음).
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeLastTime,
  fetchLastTime,
  fetchStation,
  collectTargets,
  parseArgs,
  selectTargetLines,
  buildLinesMap,
  writeOutput,
  processTargets,
  main,
  ALL_LINES,
  TARGET_LINES,
} = require('../fetch-last-train');

function mockOk(json) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(json) });
}

function mockNotOk(status) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });
}

function noopSleep() {
  return Promise.resolve();
}

describe('normalizeLastTime', () => {
  it('"HH:MM:SS" → "HH:MM"', () => {
    expect(normalizeLastTime('23:47:00')).toBe('23:47');
  });

  it('24+ 표기 → 익일 정규화', () => {
    expect(normalizeLastTime('24:36:00')).toBe('00:36');
    expect(normalizeLastTime('25:05:00')).toBe('01:05');
  });

  it('"HH:MM"만 있어도 매칭', () => {
    expect(normalizeLastTime('05:30')).toBe('05:30');
  });

  it('형식 불일치는 null', () => {
    expect(normalizeLastTime('abc')).toBeNull();
    expect(normalizeLastTime('5:30')).toBeNull();
    expect(normalizeLastTime('')).toBeNull();
  });

  it('비문자열은 null', () => {
    expect(normalizeLastTime(null)).toBeNull();
    expect(normalizeLastTime(undefined)).toBeNull();
    expect(normalizeLastTime(530)).toBeNull();
  });
});

describe('fetchLastTime', () => {
  it('단일 row → 시각 정규화', async () => {
    const fetchImpl = jest.fn(() =>
      mockOk({
        SearchLastTrainTimeByIDService: { row: [{ LAST_TIME: '23:47:00' }] },
      }),
    );
    const last = await fetchLastTime('KEY', '0150', '1', '1', { fetchImpl });
    expect(last).toBe('23:47');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('SearchLastTrainTimeByIDService/1/5/0150/1/1'),
    );
  });

  it('여러 row 중 가장 늦은 시각 채택 (자정 넘김 = 가장 늦음)', async () => {
    const fetchImpl = jest.fn(() =>
      mockOk({
        SearchLastTrainTimeByIDService: {
          row: [
            { LAST_TIME: '23:47:00' },
            { LAST_TIME: '24:36:00' },
            { LAST_TIME: '00:10:00' },
          ],
        },
      }),
    );
    const last = await fetchLastTime('KEY', '0150', '1', '1', { fetchImpl });
    // "00:36" (24:36 정규화) — 23:47보다 늦고 00:10보다 늦음(0~3시 wrap)
    expect(last).toBe('00:36');
  });

  it('row 빈 배열 → null', async () => {
    const fetchImpl = jest.fn(() => mockOk({ SearchLastTrainTimeByIDService: { row: [] } }));
    const last = await fetchLastTime('KEY', '0150', '1', '1', { fetchImpl });
    expect(last).toBeNull();
  });

  it('row 누락 → null (기본값)', async () => {
    const fetchImpl = jest.fn(() => mockOk({ SearchLastTrainTimeByIDService: {} }));
    const last = await fetchLastTime('KEY', '0150', '1', '1', { fetchImpl });
    expect(last).toBeNull();
  });

  it('row 시각 모두 invalid → null', async () => {
    const fetchImpl = jest.fn(() =>
      mockOk({
        SearchLastTrainTimeByIDService: {
          row: [{ LAST_TIME: 'invalid' }, { LAST_TIME: null }],
        },
      }),
    );
    const last = await fetchLastTime('KEY', '0150', '1', '1', { fetchImpl });
    expect(last).toBeNull();
  });

  it('INFO-200 → null (graceful)', async () => {
    const fetchImpl = jest.fn(() => mockOk({ RESULT: { CODE: 'INFO-200' } }));
    const last = await fetchLastTime('KEY', '0150', '1', '1', { fetchImpl });
    expect(last).toBeNull();
  });

  it('wrapper 누락 + RESULT 코드 없음 → throw', async () => {
    const fetchImpl = jest.fn(() => mockOk({ foo: 'bar' }));
    await expect(fetchLastTime('KEY', '0150', '1', '1', { fetchImpl })).rejects.toThrow(
      /unexpected response/,
    );
  });

  it('HTTP non-OK → throw', async () => {
    const fetchImpl = jest.fn(() => mockNotOk(500));
    await expect(fetchLastTime('KEY', '0150', '1', '1', { fetchImpl })).rejects.toThrow(
      /HTTP 500/,
    );
  });
});

describe('fetchStation', () => {
  it('6개 weekTag×inoutTag 모두 호출 후 머지', async () => {
    let call = 0;
    const fetchImpl = jest.fn(() => {
      call += 1;
      return mockOk({
        SearchLastTrainTimeByIDService: { row: [{ LAST_TIME: `23:${String(call).padStart(2, '0')}:00` }] },
      });
    });
    const out = await fetchStation('KEY', '0150', { fetchImpl, sleepImpl: noopSleep });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(out.weekday.up).toBe('23:01');
    expect(out.weekday.down).toBe('23:02');
    expect(out.saturday.up).toBe('23:03');
    expect(out.saturday.down).toBe('23:04');
    expect(out.sunday.up).toBe('23:05');
    expect(out.sunday.down).toBe('23:06');
  });

  it('일부 step null → 결과는 null로 저장', async () => {
    let call = 0;
    const fetchImpl = jest.fn(() => {
      call += 1;
      if (call === 2) return mockOk({ RESULT: { CODE: 'INFO-200' } });
      return mockOk({
        SearchLastTrainTimeByIDService: { row: [{ LAST_TIME: '23:00:00' }] },
      });
    });
    const out = await fetchStation('KEY', '0150', { fetchImpl, sleepImpl: noopSleep });
    expect(out.weekday.up).toBe('23:00');
    expect(out.weekday.down).toBeNull();
  });
});

describe('collectTargets', () => {
  const stations = [
    { id: '1-001', name: '소요산', line: '1' },
    { id: '5-001', name: '방화', line: '5' },
    { id: 'airport-001', name: '서울역', line: 'airport' },
    { id: 'orphan-001', name: 'X', line: '1' },
  ];
  const codes = {
    '1-001': { stationCd: '0150', frCode: '150' },
    '5-001': { stationCd: '2511', frCode: '510' },
    'airport-001': { stationCd: '4101', frCode: '410' },
    '99-999': { stationCd: '9999', frCode: '999' },
  };

  it('1~9호선만 join + sort', () => {
    const targets = collectTargets(codes, stations);
    expect(targets.map((t) => t.stationsJsonId)).toEqual(['1-001', '5-001']);
    expect(targets[0].stationCd).toBe('0150');
    expect(targets[1].line).toBe('5');
  });

  it('lines 지정 시 그 노선만', () => {
    const targets = collectTargets(codes, stations, ['5']);
    expect(targets).toHaveLength(1);
    expect(targets[0].stationsJsonId).toBe('5-001');
  });

  it('stationCd 누락 entry skip', () => {
    const codesWithMissing = {
      ...codes,
      '5-001': { frCode: '510' }, // stationCd 없음
    };
    const targets = collectTargets(codesWithMissing, stations);
    expect(targets.map((t) => t.stationsJsonId)).toEqual(['1-001']);
  });
});

describe('parseArgs / selectTargetLines', () => {
  it('parseArgs는 LINE env만 추출', () => {
    expect(parseArgs([], { LINE: ' 5 ' })).toEqual({ lineEnv: '5' });
    expect(parseArgs([], {})).toEqual({ lineEnv: null });
  });

  it('selectTargetLines는 LINE 없으면 1~9 전체', () => {
    expect(selectTargetLines({ lineEnv: null })).toEqual(TARGET_LINES);
  });

  it('selectTargetLines는 지정 시 단일 노선', () => {
    expect(selectTargetLines({ lineEnv: '7' })).toEqual(['7']);
  });

  it('지원 안 되는 노선은 throw', () => {
    expect(() => selectTargetLines({ lineEnv: 'airport' })).toThrow(/지원 대상이 아닙니다/);
  });
});

describe('buildLinesMap', () => {
  it('13 LineNumber 모두 entry, covered/uncovered 구분', () => {
    const map = buildLinesMap(['1', '2']);
    expect(Object.keys(map)).toHaveLength(ALL_LINES.length);
    expect(map['1']).toBe('covered');
    expect(map['3']).toBe('uncovered');
    expect(map.airport).toBe('uncovered');
  });
});

describe('writeOutput', () => {
  let writeSpy;
  let writtenPayload;

  beforeEach(() => {
    writtenPayload = null;
    writeSpy = jest
      .spyOn(fs, 'writeFileSync')
      .mockImplementation((_outPath, content) => {
        writtenPayload = content;
      });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('id 사전순 정렬 + JSON 직렬화 + 13 노선 lines 맵', () => {
    const stations = {
      '5-001': { weekday: { up: '23:30' } },
      '1-001': { weekday: { up: '23:55' } },
    };
    const outPath = writeOutput(stations, ['1', '5']);
    expect(outPath).toMatch(/lastTrains\.json$/);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writtenPayload);
    expect(Object.keys(written.stations)).toEqual(['1-001', '5-001']);
    expect(written.lines['1']).toBe('covered');
    expect(written.lines['5']).toBe('covered');
    expect(written.lines['2']).toBe('uncovered');
    expect(Object.keys(written.lines)).toHaveLength(13);
  });
});

describe('processTargets', () => {
  it('각 target fetch → success entry + coveredLines 집계', async () => {
    const logs = [];
    const fetchImpl = jest.fn(() =>
      mockOk({
        SearchLastTrainTimeByIDService: { row: [{ LAST_TIME: '23:55:00' }] },
      }),
    );
    const targets = [
      { stationsJsonId: '1-001', stationCd: '0150', line: '1' },
      { stationsJsonId: '5-001', stationCd: '2511', line: '5' },
    ];
    const { stations, coveredLines } = await processTargets('KEY', targets, {
      fetchImpl,
      sleepImpl: noopSleep,
      log: (m) => logs.push(m),
    });
    expect(stations['1-001'].weekday.up).toBe('23:55');
    expect([...coveredLines].sort()).toEqual(['1', '5']);
    expect(logs.filter((l) => l.startsWith('o'))).toHaveLength(2);
  });

  it('fetchStation throw → log error + skip', async () => {
    const logs = [];
    const fetchImpl = jest.fn(() => mockNotOk(500));
    const targets = [{ stationsJsonId: '1-001', stationCd: '0150', line: '1' }];
    const { stations, coveredLines } = await processTargets('KEY', targets, {
      fetchImpl,
      sleepImpl: noopSleep,
      log: (m) => logs.push(m),
    });
    expect(stations).toEqual({});
    expect(coveredLines.size).toBe(0);
    expect(logs.some((l) => l.startsWith('E('))).toBe(true);
  });

  it('모든 시각 null → log "." + skip', async () => {
    const logs = [];
    const fetchImpl = jest.fn(() => mockOk({ SearchLastTrainTimeByIDService: { row: [] } }));
    const targets = [{ stationsJsonId: '1-001', stationCd: '0150', line: '1' }];
    const { stations, coveredLines } = await processTargets('KEY', targets, {
      fetchImpl,
      sleepImpl: noopSleep,
      log: (m) => logs.push(m),
    });
    expect(stations).toEqual({});
    expect(coveredLines.size).toBe(0);
    expect(logs.some((l) => l.startsWith('.'))).toBe(true);
  });
});

describe('main', () => {
  let stderrSpy;
  let stdoutSpy;
  let exitSpy;
  let exitArg;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitArg = null;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      exitArg = code;
      throw new Error(`__exit:${code}`);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('API key 없으면 stderr + exit(1)', async () => {
    await expect(main([], {})).rejects.toThrow('__exit:1');
    expect(exitArg).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/EXPO_PUBLIC_SEOUL_DATA_API_KEY/));
  });

  it('stationCodes.json 비어있으면 exit(1)', async () => {
    // STATION_CODES_PATH가 실제 파일이라 비우기 어렵다. fs.readFileSync 모킹:
    const fsReal = require('node:fs');
    const realReadFile = fsReal.readFileSync;
    const readSpy = jest.spyOn(fsReal, 'readFileSync').mockImplementation((p, ...rest) => {
      if (typeof p === 'string' && p.endsWith('stationCodes.json')) return '{}';
      return realReadFile.call(fsReal, p, ...rest);
    });
    await expect(main([], { EXPO_PUBLIC_SEOUL_DATA_API_KEY: 'KEY' })).rejects.toThrow('__exit:1');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/stationCodes\.json/));
    readSpy.mockRestore();
  });

  it('정상 흐름: targets 산출 → process → writeOutput', async () => {
    // 실제 stationCodes.json + stations.json 사용 (worktree에 있음). fetch만 모킹.
    const fetchImpl = jest.fn(() =>
      mockOk({
        SearchLastTrainTimeByIDService: { row: [{ LAST_TIME: '23:00:00' }] },
      }),
    );
    const writeSpy = jest
      .spyOn(require('node:fs'), 'writeFileSync')
      .mockImplementation(() => undefined);
    try {
      const result = await main(
        [],
        { EXPO_PUBLIC_SEOUL_DATA_API_KEY: 'KEY', LINE: '5' },
        { fetchImpl, sleepImpl: noopSleep },
      );
      expect(result.coveredLines).toContain('5');
      expect(result.stationCount).toBeGreaterThan(0);
      expect(fetchImpl).toHaveBeenCalled();
      expect(writeSpy).toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('require.main 엔트리', () => {
  it('직접 실행 path는 module.exports를 통해 노출됨', () => {
    // require.main === module 분기는 jest 환경에서 자동 미진입 (모듈을 require로 load).
    // 본 모듈이 module.exports에 모든 helper를 노출하고 있는지 자가 점검.
    const exported = require('../fetch-last-train');
    expect(typeof exported.main).toBe('function');
    expect(Array.isArray(exported.ALL_LINES)).toBe(true);
    expect(exported.ALL_LINES).toHaveLength(13);
  });
});
