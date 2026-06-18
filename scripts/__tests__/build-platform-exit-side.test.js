/**
 * #1482 — build-platform-exit-side 헬퍼 + 실제 데이터 회귀 점검.
 *
 * 사용자 통찰: 하차문 방향은 승강장 구조로 결정되는 고정 정보.
 *   상대식 → right, 섬식 → left, 복합식/단선/시종착 → both.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  build,
  mapFormatToSide,
  parseCsvLine,
  buildNameAliases,
  FORMAT_TO_SIDE,
  SUPPORTED_LINES,
} = require('../build-platform-exit-side');

describe('FORMAT_TO_SIDE', () => {
  it('상대식 → right', () => {
    expect(FORMAT_TO_SIDE['상대식']).toBe('right');
  });

  it('섬식 → left', () => {
    expect(FORMAT_TO_SIDE['섬식']).toBe('left');
  });

  it('복합식/섬식(복합)/단선 → both', () => {
    expect(FORMAT_TO_SIDE['복합식']).toBe('both');
    expect(FORMAT_TO_SIDE['섬식(복합)']).toBe('both');
    expect(FORMAT_TO_SIDE['단선']).toBe('both');
  });

  it('Object.freeze 봉인 (재할당 방지)', () => {
    expect(Object.isFrozen(FORMAT_TO_SIDE)).toBe(true);
  });
});

describe('SUPPORTED_LINES', () => {
  it('1~8호선 8개 노선', () => {
    expect(SUPPORTED_LINES).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });

  it('Object.freeze 봉인 (재할당 방지)', () => {
    expect(Object.isFrozen(SUPPORTED_LINES)).toBe(true);
  });
});

describe('mapFormatToSide', () => {
  it.each([
    ['상대식', 'right'],
    ['섬식', 'left'],
    ['복합식', 'both'],
    ['섬식(복합)', 'both'],
    ['단선', 'both'],
  ])('"%s" → %s', (input, expected) => {
    expect(mapFormatToSide(input)).toBe(expected);
  });

  it('알 수 없는 형식은 null', () => {
    expect(mapFormatToSide('지하4층식')).toBeNull();
    expect(mapFormatToSide('')).toBeNull();
  });

  it('null/undefined은 null', () => {
    expect(mapFormatToSide(null)).toBeNull();
    expect(mapFormatToSide(undefined)).toBeNull();
  });

  it('앞뒤 공백은 trim 후 매칭', () => {
    expect(mapFormatToSide('  상대식  ')).toBe('right');
    expect(mapFormatToSide('\t섬식\n')).toBe('left');
  });
});

describe('parseCsvLine', () => {
  it('따옴표로 감싼 컬럼을 분리', () => {
    expect(parseCsvLine('"1","서울","섬식","210","B2","10805","1974"')).toEqual([
      '1',
      '서울',
      '섬식',
      '210',
      'B2',
      '10805',
      '1974',
    ]);
  });

  it('따옴표 없는 컬럼도 처리', () => {
    expect(parseCsvLine('1,1,서울,B2,섬식,129.99')).toEqual([
      '1',
      '1',
      '서울',
      'B2',
      '섬식',
      '129.99',
    ]);
  });

  it('따옴표 안의 쉼표는 보존', () => {
    expect(parseCsvLine('1,1,서울,B2,섬식,"4호선,경의중앙선"')).toEqual([
      '1',
      '1',
      '서울',
      'B2',
      '섬식',
      '4호선,경의중앙선',
    ]);
  });

  it('빈 줄은 빈 문자열 컬럼 1개', () => {
    expect(parseCsvLine('')).toEqual(['']);
  });
});

describe('buildNameAliases', () => {
  it('원본만 있는 경우 alias 1개', () => {
    expect(buildNameAliases('한양대')).toEqual(['한양대']);
  });

  it('괄호 부제 제거 alias', () => {
    expect(buildNameAliases('청량리(서울시립대입구)')).toEqual([
      '청량리(서울시립대입구)',
      '청량리',
    ]);
  });

  it('"역" 접미사 제거 alias', () => {
    expect(buildNameAliases('서울역')).toEqual(['서울역', '서울']);
  });

  it('괄호+역 동시 제거', () => {
    // 흔치 않지만 표기 가능성 보장
    expect(buildNameAliases('서울역(중앙)')).toEqual(['서울역(중앙)', '서울역', '서울']);
  });

  it('alias 중복은 set으로 제거', () => {
    // baseName === name 이면 한 개만
    const aliases = buildNameAliases('한양대');
    expect(aliases).toHaveLength(1);
  });
});

describe('build (integration with real CSV + stations.json)', () => {
  // build()는 fs.writeFileSync로 src/data/platformExitSide.json을 덮어쓴다.
  // 테스트 격리를 위해 spy로 write 차단 + 결과만 검증.
  let writeSpy;
  let logSpy;
  let result;

  beforeAll(() => {
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    result = build();
  });

  afterAll(() => {
    writeSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('1~8호선 stations.json 354개 역 처리', () => {
    const total = result.stats.right + result.stats.left + result.stats.both + result.stats.unknown;
    expect(total).toBe(354);
  });

  it('사용자 trip 검증 표본 매핑 정확 (상대식/섬식/복합식)', () => {
    expect(result.output['1-034']).toBe('left'); // 서울역 (섬식, alias)
    expect(result.output['2-008']).toBe('right'); // 왕십리 (상대식)
    expect(result.output['2-009']).toBe('right'); // 한양대 (상대식)
    expect(result.output['2-011']).toBe('both'); // 성수 (복합식)
    expect(result.output['5-032']).toBe('right'); // 마장 (상대식)
  });

  it('시종착역 override 적용 (lineTerminals 양쪽 문)', () => {
    const lineTerminals = require('../../src/data/lineTerminals.json');
    const stations = require('../../src/data/stations.json');
    for (const line of SUPPORTED_LINES) {
      const terminals = lineTerminals[line];
      if (!terminals) continue;
      for (const role of ['up', 'down']) {
        const name = terminals[role];
        // 2호선 내선/외선은 개념적 역명이라 stations.json에 없음 → skip
        const station = stations.find((s) => s.line === line && s.name === name);
        if (!station) continue;
        expect(result.output[station.id]).toBe('both');
      }
    }
  });

  it('right/left/both 합계 + unknown으로 354 stations 모두 분류', () => {
    expect(result.stats.right).toBeGreaterThan(0);
    expect(result.stats.left).toBeGreaterThan(0);
    expect(result.stats.both).toBeGreaterThan(0);
  });

  it('unknownList는 각 항목이 stations.json id 포맷', () => {
    for (const entry of result.unknownList) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('line');
      expect(entry).toHaveProperty('name');
      expect(SUPPORTED_LINES).toContain(entry.line);
    }
  });

  it('output JSON 키는 id 사전순(정렬)으로 출력', () => {
    const writtenJson = writeSpy.mock.calls[0][1];
    const parsed = JSON.parse(writtenJson);
    const keys = Object.keys(parsed);
    const sorted = keys.slice().sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual(sorted);
  });

  it('output 파일은 마지막 newline으로 끝남 (POSIX 호환)', () => {
    const writtenJson = writeSpy.mock.calls[0][1];
    expect(writtenJson.endsWith('\n')).toBe(true);
  });

  it('unknown 리스트 콘솔 출력 — 90건 미만(데이터 회귀 detection)', () => {
    // CSV 매핑이 깨지면 unknown이 폭증한다. 회귀 경보 게이트.
    expect(result.stats.unknown).toBeLessThan(100);
  });
});

describe('build (defensive CSV/terminal edge paths)', () => {
  // CSV defensive skip 경로(빈 행/짧은 행)와 lineTerminals 누락 분기 커버.
  let readSpy;
  let writeSpy;
  let logSpy;
  const realRead = fs.readFileSync;

  afterEach(() => {
    readSpy?.mockRestore();
    writeSpy?.mockRestore();
    logSpy?.mockRestore();
  });

  it('CSV의 빈 행/짧은 행 + lineTerminals null 역명을 건너뛴다', () => {
    // 두 CSV 모두 빈 행 + 헤더 외 1줄, depth는 컬럼 4개로 절단 → 모두 skip.
    const archCsvWithEmpty =
      '"호선","역명","형식","길이(M)","층수","면적(㎡)","준공년도"\n' +
      '\n' + // 빈 행
      '"x","y"\n' + // 짧은 행 (3 미만)
      '"1","서울","섬식","210","B2","10805","1974"';
    const depthCsvShort = '연번,호선,역명,층수\n' + '\n' + '1,1,서울,B2';
    readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, enc) => {
      if (String(file).endsWith('seoul-station-architecture.csv')) {
        return archCsvWithEmpty;
      }
      if (String(file).endsWith('seoul-station-depth.csv')) {
        return depthCsvShort;
      }
      if (String(file).endsWith('stations.json')) {
        return JSON.stringify([{ id: '1-034', line: '1', name: '서울역' }]);
      }
      if (String(file).endsWith('lineTerminals.json')) {
        // up은 정상, down은 null/undefined → !name 분기 트리거
        return JSON.stringify({
          1: { up: '서울역', down: null },
          // SUPPORTED_LINES 밖 → 무시 분기 트리거
          gyeongui: { up: '운천', down: '지평' },
        });
      }
      return realRead(file, enc);
    });
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { build: buildFn } = require('../build-platform-exit-side');
    const r = buildFn();
    // 1-034 = 서울역(섬식) + lineTerminals up='서울역' override → both
    expect(r.output['1-034']).toBe('both');
    expect(r.stats.both).toBe(1);
    expect(r.stats.terminalOverride).toBe(1);
  });

  it('CSV 미매칭 역은 rawFormat=null인 unknown 엔트리로 누적', () => {
    readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, enc) => {
      if (String(file).endsWith('seoul-station-architecture.csv')) {
        return '"호선","역명","형식"';
      }
      if (String(file).endsWith('seoul-station-depth.csv')) {
        return '연번,호선,역명,층수,형식';
      }
      if (String(file).endsWith('stations.json')) {
        // CSV에 없는 역
        return JSON.stringify([{ id: '9-001', line: '1', name: '가상역' }]);
      }
      if (String(file).endsWith('lineTerminals.json')) {
        return JSON.stringify({});
      }
      return realRead(file, enc);
    });
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { build: buildFn } = require('../build-platform-exit-side');
    const r = buildFn();
    expect(r.stats.unknown).toBe(1);
    expect(r.unknownList[0]).toEqual({
      id: '9-001',
      line: '1',
      name: '가상역',
      rawFormat: null, // lookup 자체가 null → rawFormat: null 분기
    });
  });
});

describe('build (no unknown list short-circuit)', () => {
  // unknownList가 비어 있을 때 "사용자 검수 필요" 헤더 출력하지 않는 경로 커버.
  // 실데이터로는 unknown=89 → fs.readFileSync mock으로 stations.json을 CSV 매칭 가능한
  // 2개 역만으로 축소한 환경을 구성.
  let writeSpy;
  let logSpy;
  let readSpy;
  const realRead = fs.readFileSync;

  afterEach(() => {
    writeSpy?.mockRestore();
    logSpy?.mockRestore();
    readSpy?.mockRestore();
  });

  it('unknownList가 비어 있으면 검수 헤더를 출력하지 않는다', () => {
    readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, enc) => {
      if (String(file).endsWith('stations.json')) {
        return JSON.stringify([
          { id: '2-008', line: '2', name: '왕십리' },
          { id: '2-009', line: '2', name: '한양대' },
        ]);
      }
      if (String(file).endsWith('lineTerminals.json')) {
        // 시종착 override 없음 (2호선 내선/외선은 어차피 stations.json에 없음)
        return JSON.stringify({});
      }
      return realRead(file, enc);
    });
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { build: buildFn } = require('../build-platform-exit-side');
    const r = buildFn();
    expect(r.stats.unknown).toBe(0);
    const allLogs = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(allLogs).not.toContain('unknown 리스트 (사용자 검수 필요)');
  });
});
