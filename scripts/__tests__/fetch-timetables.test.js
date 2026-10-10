/**
 * #1497: fetch-timetables — stationCodes.json 기반 FR_CODE 확장.
 * 누락 16역(5호선 마천 지선/6호선 응암 순환/2호선 지선/4호선 당고개/1호선 가산디지털단지) 케이스 + 레거시 모드 회귀.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  compactTime,
  fetchOne,
  fetchStation,
  collectFrCodesByLine,
  collectMissingFrCodes,
  legacyRangeFrCodes,
  parseArgs,
  selectTargetLines,
  resolveFrCodeSets,
  readExistingLine,
  writeLine,
  processLine,
  main,
} = require('../fetch-timetables');

// fetch 응답 mock helper
function mockOk(json) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(json) });
}
function mockNotOk(status) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });
}
function noopSleep() {
  return Promise.resolve();
}

describe('compactTime', () => {
  it('"HH:MM:SS" → "HHMM"', () => {
    expect(compactTime('05:18:00')).toBe('0518');
    expect(compactTime('23:59:30')).toBe('2359');
  });

  it('24시간 초과 표기 보존', () => {
    expect(compactTime('24:09:30')).toBe('2409');
  });

  it('형식 불일치는 null', () => {
    expect(compactTime('abc')).toBeNull();
    expect(compactTime('5:18:00')).toBeNull();
    expect(compactTime('')).toBeNull();
  });

  it('비문자열은 null', () => {
    expect(compactTime(null)).toBeNull();
    expect(compactTime(undefined)).toBeNull();
    expect(compactTime(530)).toBeNull();
  });
});

describe('fetchOne', () => {
  it('정상 응답 row 배열 반환', async () => {
    const fetchImpl = jest.fn(() =>
      mockOk({
        SearchSTNTimeTableByFRCodeService: {
          row: [{ STATION_NM: '서울역', ARRIVETIME: '05:18:00' }],
        },
      }),
    );
    const rows = await fetchOne('KEY', '100', '1', '1', { fetchImpl });
    expect(rows).toEqual([{ STATION_NM: '서울역', ARRIVETIME: '05:18:00' }]);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('SearchSTNTimeTableByFRCodeService/1/1000/100/1/1'));
  });

  it('row 누락 시 빈 배열', async () => {
    const fetchImpl = jest.fn(() => mockOk({ SearchSTNTimeTableByFRCodeService: {} }));
    const rows = await fetchOne('KEY', '100', '1', '1', { fetchImpl });
    expect(rows).toEqual([]);
  });

  it('INFO-200 (데이터 없음)은 null', async () => {
    const fetchImpl = jest.fn(() => mockOk({ RESULT: { CODE: 'INFO-200', MESSAGE: 'no data' } }));
    const rows = await fetchOne('KEY', '999', '1', '1', { fetchImpl });
    expect(rows).toBeNull();
  });

  it('HTTP non-OK는 throw', async () => {
    const fetchImpl = jest.fn(() => mockNotOk(500));
    await expect(fetchOne('KEY', '100', '1', '1', { fetchImpl })).rejects.toThrow(/HTTP 500/);
  });

  it('wrapper 누락 + RESULT 코드 없음 → throw', async () => {
    const fetchImpl = jest.fn(() => mockOk({ unexpected: true }));
    await expect(fetchOne('KEY', '100', '1', '1', { fetchImpl })).rejects.toThrow(/unexpected response/);
  });
});

describe('fetchStation', () => {
  it('probe 실패 시 stationName=null + 빈 timetable, 나머지 호출 skip', async () => {
    const fetchImpl = jest.fn(() => mockOk({ RESULT: { CODE: 'INFO-200' } }));
    const { stationName, timetable } = await fetchStation('KEY', '999', { fetchImpl, sleepImpl: noopSleep });
    expect(stationName).toBeNull();
    expect(timetable).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('6개 weekTag×inoutTag 조합 모두 호출 + 결과 머지', async () => {
    const fetchImpl = jest.fn((url) => {
      // path 끝 "/{frCode}/{w}/{i}" 추출
      const parts = url.split('/');
      const inout = parts.at(-1);
      const week = parts.at(-2);
      return mockOk({
        SearchSTNTimeTableByFRCodeService: {
          row: [
            { STATION_NM: '마천', ARRIVETIME: `0${week}:0${inout}:00` },
          ],
        },
      });
    });
    const { stationName, timetable } = await fetchStation('KEY', '548', { fetchImpl, sleepImpl: noopSleep });
    expect(stationName).toBe('마천');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(timetable.weekday.up).toEqual(['0101']);
    expect(timetable.weekday.down).toEqual(['0102']);
    expect(timetable.saturday.up).toEqual(['0201']);
    expect(timetable.saturday.down).toEqual(['0202']);
    expect(timetable.sunday.up).toEqual(['0301']);
    expect(timetable.sunday.down).toEqual(['0302']);
  });

  it('일부 weekTag×inoutTag만 데이터 있어도 정상 머지 (빈 row skip)', async () => {
    let call = 0;
    const fetchImpl = jest.fn(() => {
      call++;
      // probe(1)만 데이터, 나머지 5는 INFO-200
      if (call === 1) {
        return mockOk({
          SearchSTNTimeTableByFRCodeService: {
            row: [{ STATION_NM: '신설동', ARRIVETIME: '05:30:00' }],
          },
        });
      }
      return mockOk({ RESULT: { CODE: 'INFO-200' } });
    });
    const { stationName, timetable } = await fetchStation('KEY', '211', { fetchImpl, sleepImpl: noopSleep });
    expect(stationName).toBe('신설동');
    expect(timetable.weekday.up).toEqual(['0530']);
    expect(timetable.weekday.down).toBeUndefined();
    expect(timetable.saturday).toBeUndefined();
  });

  it('rest step에서 빈 배열도 skip 처리', async () => {
    let call = 0;
    const fetchImpl = jest.fn(() => {
      call++;
      if (call === 1) {
        return mockOk({
          SearchSTNTimeTableByFRCodeService: {
            row: [{ STATION_NM: '둔촌동', ARRIVETIME: '05:35:00' }],
          },
        });
      }
      if (call === 2) {
        return mockOk({ SearchSTNTimeTableByFRCodeService: { row: [] } });
      }
      return mockOk({
        SearchSTNTimeTableByFRCodeService: {
          row: [{ STATION_NM: '둔촌동', ARRIVETIME: '06:00:00' }],
        },
      });
    });
    const { timetable } = await fetchStation('KEY', '548', { fetchImpl, sleepImpl: noopSleep });
    expect(timetable.weekday.up).toEqual(['0535']);
    expect(timetable.weekday.down).toBeUndefined();
    expect(timetable.saturday.up).toEqual(['0600']);
  });
});

describe('collectFrCodesByLine', () => {
  const stations = [
    { id: '1-001', name: '소요산', line: '1' },
    { id: '1-100', name: '가산디지털단지', line: '1' },
    { id: '5-001', name: '방화', line: '5' },
    { id: '5-046', name: '마천', line: '5' },
    { id: '6-002', name: '역촌', line: '6' },
    { id: 'airport-001', name: '서울역', line: 'airport' }, // skip
  ];
  const codes = {
    '1-001': { stationCd: '0150', frCode: '150' },
    '1-100': { stationCd: '1800', frCode: '801' }, // 1호선 가산디지털단지: range 밖
    '5-001': { stationCd: '2511', frCode: '510' },
    '5-046': { stationCd: '2548', frCode: '744' }, // 마천: 5호선 range 밖
    '6-002': { stationCd: '2611', frCode: '610' },
    'airport-001': { stationCd: '4101', frCode: '410' },
  };

  it('1~9호선 entry만 line별로 모음', () => {
    const byLine = collectFrCodesByLine(codes, stations);
    expect(byLine.get('1')).toEqual(new Set(['150', '801']));
    expect(byLine.get('5')).toEqual(new Set(['510', '744']));
    expect(byLine.get('6')).toEqual(new Set(['610']));
    expect(byLine.get('airport')).toBeUndefined();
  });

  it('stations 미포함 id는 무시', () => {
    const byLine = collectFrCodesByLine({ 'unknown-9': { frCode: '999' } }, stations);
    expect([...byLine.values()].every((s) => !s.has('999'))).toBe(true);
  });

  it('frCode 없는 entry는 skip', () => {
    const byLine = collectFrCodesByLine({ '1-001': { stationCd: '0150' } }, stations);
    expect(byLine.get('1').size).toBe(0);
  });

  it('frCode가 string 아니면 skip', () => {
    const byLine = collectFrCodesByLine({ '1-001': { stationCd: '0150', frCode: 150 } }, stations);
    expect(byLine.get('1').size).toBe(0);
  });

  it('lines 인자로 대상 노선 제한', () => {
    const byLine = collectFrCodesByLine(codes, stations, ['5']);
    expect([...byLine.keys()]).toEqual(['5']);
    expect(byLine.get('5')).toEqual(new Set(['510', '744']));
  });

  it('frCode가 3자리 미만이면 0-pad', () => {
    const byLine = collectFrCodesByLine({ '1-001': { frCode: '99' } }, [{ id: '1-001', line: '1', name: 'X' }]);
    expect(byLine.get('1')).toEqual(new Set(['099']));
  });
});

describe('collectMissingFrCodes', () => {
  const stations = [
    { id: '1-001', name: '소요산', line: '1' },
    { id: '1-100', name: '가산디지털단지', line: '1' },
    { id: '5-046', name: '마천', line: '5' },
    { id: '6-002', name: '역촌', line: '6' },
  ];
  const codes = {
    '1-001': { frCode: '150' },
    '1-100': { frCode: '801' },
    '5-046': { frCode: '744' },
    '6-002': { frCode: '610' },
  };

  it('firstLastTrainTimes에 없는 id만 수집', () => {
    const flt = { '1-001': { weekday: { up: { first: '05:18', last: '23:48' } } } };
    const byLine = collectMissingFrCodes(codes, stations, flt);
    expect(byLine.get('1')).toEqual(new Set(['801']));
    expect(byLine.get('5')).toEqual(new Set(['744']));
    expect(byLine.get('6')).toEqual(new Set(['610']));
  });

  it('1~9호선 외 station은 무시', () => {
    const external = [{ id: 'airport-001', name: '인천공항', line: 'airport' }];
    const byLine = collectMissingFrCodes({ 'airport-001': { frCode: '410' } }, external, {});
    for (const s of byLine.values()) expect(s.size).toBe(0);
  });

  it('frCode 누락 entry는 skip', () => {
    const byLine = collectMissingFrCodes({ '1-001': {} }, [{ id: '1-001', line: '1' }], {});
    expect(byLine.get('1').size).toBe(0);
  });

  it('stationCodes에 아예 없는 station은 skip', () => {
    const byLine = collectMissingFrCodes({}, stations, {});
    for (const s of byLine.values()) expect(s.size).toBe(0);
  });
});

describe('legacyRangeFrCodes', () => {
  it('line N → N*100 ~ N*100+99', () => {
    const set = legacyRangeFrCodes('1');
    expect(set.size).toBe(100);
    expect(set.has('100')).toBe(true);
    expect(set.has('199')).toBe(true);
    expect(set.has('200')).toBe(false);
  });

  it('한자리 padding 적용', () => {
    const set = legacyRangeFrCodes('1');
    expect(set.has('100')).toBe(true);
    // 1호선 100~199 — 모두 3자리
    for (const c of set) expect(c).toMatch(/^\d{3}$/);
  });
});

describe('parseArgs', () => {
  let originalEnv;
  beforeEach(() => {
    originalEnv = process.env.LINE;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LINE;
    else process.env.LINE = originalEnv;
  });

  it('기본값', () => {
    delete process.env.LINE;
    expect(parseArgs([])).toEqual({ legacyRange: false, missingOnly: false, lineEnv: null });
  });

  it('--legacy-range / --missing-only flag', () => {
    delete process.env.LINE;
    expect(parseArgs(['--legacy-range'])).toMatchObject({ legacyRange: true });
    expect(parseArgs(['--missing-only'])).toMatchObject({ missingOnly: true });
  });

  it('LINE env 흡수 + trim', () => {
    process.env.LINE = '  5  ';
    expect(parseArgs([])).toMatchObject({ lineEnv: '5' });
  });
});

describe('selectTargetLines', () => {
  it('lineEnv 없으면 1~9 전체', () => {
    expect(selectTargetLines({ lineEnv: null })).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('lineEnv 지정 시 단일', () => {
    expect(selectTargetLines({ lineEnv: '5' })).toEqual(['5']);
  });

  it('1~9 밖이면 throw', () => {
    expect(() => selectTargetLines({ lineEnv: '0' })).toThrow(/지원 대상이 아닙니다/);
    expect(() => selectTargetLines({ lineEnv: 'airport' })).toThrow(/지원 대상이 아닙니다/);
  });
});

describe('resolveFrCodeSets', () => {
  const stations = [
    { id: '1-001', name: '소요산', line: '1' },
    { id: '5-046', name: '마천', line: '5' },
  ];
  const codes = {
    '1-001': { frCode: '150' },
    '5-046': { frCode: '744' },
  };

  it('legacyRange 모드 → range probe set', () => {
    const sets = resolveFrCodeSets(['1'], {
      legacyRange: true,
      missingOnly: false,
      stationCodes: codes,
      stations,
      firstLastTimes: {},
    });
    expect(sets.get('1').size).toBe(100);
  });

  it('missingOnly 모드 → 누락 id만', () => {
    const sets = resolveFrCodeSets(['1', '5'], {
      legacyRange: false,
      missingOnly: true,
      stationCodes: codes,
      stations,
      firstLastTimes: { '1-001': {} },
    });
    expect(sets.get('1').size).toBe(0);
    expect(sets.get('5')).toEqual(new Set(['744']));
  });

  it('기본 모드 → stationCodes 전체', () => {
    const sets = resolveFrCodeSets(['1', '5'], {
      legacyRange: false,
      missingOnly: false,
      stationCodes: codes,
      stations,
      firstLastTimes: {},
    });
    expect(sets.get('1')).toEqual(new Set(['150']));
    expect(sets.get('5')).toEqual(new Set(['744']));
  });
});

describe('readExistingLine / writeLine', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftt-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('파일 없으면 빈 stations', () => {
    // 실제 파일 시스템 의존 — 존재하지 않는 line으로 호출
    const data = readExistingLine('zzz-nonexistent');
    expect(data).toEqual({ stations: {} });
  });

  it('JSON 파싱 실패 시 빈 stations로 fallback', () => {
    // 임시로 깨진 JSON 파일을 timetables/ 위치에 만들고 모듈 다시 호출
    // module이 path를 ROOT 기준 고정하므로 우회: 작성/검증 통합 테스트는 writeLine 흐름으로 대체
    // 여기선 fallback 분기를 별도로 강제하기 어려우니, mock fs 사용
    const realRead = fs.readFileSync;
    const realExists = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (String(p).endsWith('line-9.json')) return true;
      return realExists(p);
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation((p, enc) => {
      if (String(p).endsWith('line-9.json')) return '{not json';
      return realRead(p, enc);
    });
    try {
      expect(readExistingLine('9')).toEqual({ stations: {} });
    } finally {
      fs.existsSync.mockRestore();
      fs.readFileSync.mockRestore();
    }
  });

  it('writeLine — sorted key + line-N.json 위치', () => {
    // OUT_DIR을 임시로 mock — writeFileSync를 capture
    const writes = [];
    jest.spyOn(fs, 'writeFileSync').mockImplementation((p, content) => {
      writes.push({ p, content });
    });
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    try {
      const stations = { 영등포: { weekday: { up: ['0500'] } }, 가산디지털단지: { weekday: { up: ['0510'] } } };
      const outPath = writeLine('1', stations);
      expect(outPath).toMatch(/line-1\.json$/);
      const parsed = JSON.parse(writes[0].content);
      // sort by localeCompare en — '가' < '영' (가 has lower code point)
      const keys = Object.keys(parsed.stations);
      expect(keys).toEqual(['가산디지털단지', '영등포']);
    } finally {
      fs.writeFileSync.mockRestore();
      fs.mkdirSync.mockRestore();
      fs.existsSync.mockRestore();
    }
  });

  it('writeLine — OUT_DIR 없으면 생성', () => {
    let createdDir = null;
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'mkdirSync').mockImplementation((p) => {
      createdDir = p;
    });
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    try {
      writeLine('2', {});
      expect(String(createdDir)).toMatch(/timetables$/);
    } finally {
      fs.existsSync.mockRestore();
      fs.mkdirSync.mockRestore();
      fs.writeFileSync.mockRestore();
    }
  });
});

describe('processLine', () => {
  const noLog = () => {};

  it('frCode 후보 없으면 skip', async () => {
    const fetchImpl = jest.fn();
    const result = await processLine('KEY', '1', new Set(), { fetchImpl, sleepImpl: noopSleep, log: noLog });
    expect(result).toEqual({ line: '1', stationCount: 0, outPath: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('정상 fetch → writeLine 호출, 기존 데이터 merge', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest
      .spyOn(fs, 'readFileSync')
      .mockReturnValue(JSON.stringify({ stations: { 기존역: { weekday: { up: ['0400'] } } } }));
    const writes = [];
    jest.spyOn(fs, 'writeFileSync').mockImplementation((p, c) => writes.push({ p, c }));
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});

    const fetchImpl = jest.fn(() =>
      mockOk({
        SearchSTNTimeTableByFRCodeService: { row: [{ STATION_NM: '마천', ARRIVETIME: '05:18:00' }] },
      }),
    );
    try {
      const r = await processLine('KEY', '5', new Set(['744']), { fetchImpl, sleepImpl: noopSleep, log: noLog });
      expect(r.added).toBe(1);
      expect(r.stationCount).toBe(2); // 기존역 + 마천
      const parsed = JSON.parse(writes[0].c);
      expect(Object.keys(parsed.stations).sort((a, b) => a.localeCompare(b))).toEqual(['기존역', '마천']);
    } finally {
      fs.existsSync.mockRestore();
      fs.readFileSync.mockRestore();
      fs.writeFileSync.mockRestore();
      fs.mkdirSync.mockRestore();
    }
  });

  it('fetch error → 해당 frCode skip, 다음 진행', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    let call = 0;
    const fetchImpl = jest.fn(() => {
      call++;
      if (call === 1) return mockNotOk(500);
      return mockOk({
        SearchSTNTimeTableByFRCodeService: { row: [{ STATION_NM: '둔촌동', ARRIVETIME: '05:20:00' }] },
      });
    });
    try {
      const r = await processLine('KEY', '5', new Set(['999', '548']), {
        fetchImpl,
        sleepImpl: noopSleep,
        log: noLog,
      });
      expect(r.added).toBe(1);
    } finally {
      fs.existsSync.mockRestore();
      fs.writeFileSync.mockRestore();
      fs.mkdirSync.mockRestore();
    }
  });

  it('빈 timetable(probe 실패) → skip', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const fetchImpl = jest.fn(() => mockOk({ RESULT: { CODE: 'INFO-200' } }));
    try {
      const r = await processLine('KEY', '5', new Set(['999']), { fetchImpl, sleepImpl: noopSleep, log: noLog });
      expect(r.added).toBe(0);
    } finally {
      fs.existsSync.mockRestore();
      fs.writeFileSync.mockRestore();
      fs.mkdirSync.mockRestore();
    }
  });
});

describe('main', () => {
  let exitSpy, stderrSpy, stdoutSpy;
  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`__EXIT_${code}__`);
    });
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('API 키 없으면 exit 1', async () => {
    await expect(main([], {})).rejects.toThrow('__EXIT_1__');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('EXPO_PUBLIC_SEOUL_DATA_API_KEY'));
  });

  it('stationCodes.json 비어있고 legacy-range 아니면 exit 1', async () => {
    jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (String(p).endsWith('stationCodes.json')) return true;
      if (String(p).endsWith('stations.json')) return true;
      if (String(p).endsWith('firstLastTrainTimes.json')) return true;
      return false;
    });
    jest.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('stationCodes.json')) return '{}';
      if (String(p).endsWith('stations.json')) return '[]';
      if (String(p).endsWith('firstLastTrainTimes.json')) return '{}';
      return '';
    });
    await expect(main([], { EXPO_PUBLIC_SEOUL_DATA_API_KEY: 'X', LINE: '1' })).rejects.toThrow('__EXIT_1__');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('stationCodes.json이 비어있습니다'));
  });

  it('legacy-range 모드는 stationCodes 빈 상태도 통과', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('stationCodes.json')) return '{}';
      if (String(p).endsWith('stations.json')) return '[]';
      if (String(p).endsWith('firstLastTrainTimes.json')) return '{}';
      return '';
    });
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const fetchImpl = jest.fn(() => mockOk({ RESULT: { CODE: 'INFO-200' } }));
    await main(['--legacy-range'], { EXPO_PUBLIC_SEOUL_DATA_API_KEY: 'X', LINE: '1' }, {
      fetchImpl,
      sleepImpl: noopSleep,
    });
    // legacy 모드 + 1호선 → 100회 fetch (probe만 호출, INFO-200으로 stop)
    expect(fetchImpl).toHaveBeenCalledTimes(100);
  });

  it('stationCodes 기반 + LINE=5 → 5호선만 처리', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('stationCodes.json'))
        return JSON.stringify({ '5-046': { frCode: '744' } });
      if (String(p).endsWith('stations.json')) return JSON.stringify([{ id: '5-046', line: '5', name: '마천' }]);
      if (String(p).endsWith('firstLastTrainTimes.json')) return '{}';
      if (String(p).endsWith('line-5.json')) return JSON.stringify({ stations: {} });
      return '';
    });
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const fetchImpl = jest.fn(() =>
      mockOk({ SearchSTNTimeTableByFRCodeService: { row: [{ STATION_NM: '마천', ARRIVETIME: '05:18:00' }] } }),
    );
    await main([], { EXPO_PUBLIC_SEOUL_DATA_API_KEY: 'X', LINE: '5' }, { fetchImpl, sleepImpl: noopSleep });
    // 5호선 마천 1역 × 6 호출
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('--missing-only → firstLastTimes 누락 id만', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('stationCodes.json'))
        return JSON.stringify({
          '1-001': { frCode: '150' },
          '1-100': { frCode: '801' },
        });
      if (String(p).endsWith('stations.json'))
        return JSON.stringify([
          { id: '1-001', line: '1', name: '소요산' },
          { id: '1-100', line: '1', name: '가산디지털단지' },
        ]);
      if (String(p).endsWith('firstLastTrainTimes.json'))
        return JSON.stringify({ '1-001': { weekday: { up: { first: '05:18', last: '23:48' } } } });
      if (String(p).endsWith('line-1.json')) return JSON.stringify({ stations: {} });
      return '';
    });
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const fetchImpl = jest.fn(() =>
      mockOk({
        SearchSTNTimeTableByFRCodeService: { row: [{ STATION_NM: '가산디지털단지', ARRIVETIME: '05:30:00' }] },
      }),
    );
    await main(['--missing-only'], { EXPO_PUBLIC_SEOUL_DATA_API_KEY: 'X', LINE: '1' }, {
      fetchImpl,
      sleepImpl: noopSleep,
    });
    // 누락 1역(1-100) × 6 호출
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
});
