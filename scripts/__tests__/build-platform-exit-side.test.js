/**
 * #3129 — build-platform-exit-side: 공식 역사심도정보 기반 재빌드.
 *
 * 스펙(이슈 #3129):
 *   - 'both'는 어떤 경로로도 만들지 않는다 (종착역 override 제거, 복합식/단선도 both 아님).
 *   - 심도 CSV와 건축 CSV가 둘 다 단순 섬식/상대식으로 일치할 때만 left/right 도출.
 *     불일치·섬식(복합)·단선·건축 CSV 미수록은 null (추정 금지).
 *   - 우측통행: 상대식=right / 섬식=left. 좌측통행 노선은 반전. 주행방향 근거 없는 노선은 null.
 *   - 항목마다 출처 등급(grade)을 가진다.
 */
'use strict';

const fs = require('node:fs');

const {
  build,
  mapFormatToSide,
  resolveStationSide,
  parseCsvLine,
  buildNameAliases,
  stripParens,
  SUPPORTED_LINES,
  GRADE_OFFICIAL_DERIVED,
} = require('../build-platform-exit-side');

describe('SUPPORTED_LINES', () => {
  it('1~8호선 8개 노선', () => {
    expect(SUPPORTED_LINES).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });

  it('Object.freeze 봉인 (재할당 방지)', () => {
    expect(Object.isFrozen(SUPPORTED_LINES)).toBe(true);
  });
});

describe('mapFormatToSide (주행방향별 형식 → 좌/우)', () => {
  it.each([
    ['상대식', 'right', 'right'],
    ['섬식', 'right', 'left'],
    ['상대식', 'left', 'left'],
    ['섬식', 'left', 'right'],
  ])('"%s" + %s통행 → %s', (format, running, expected) => {
    expect(mapFormatToSide(format, running)).toBe(expected);
  });

  it.each(['섬식(복합)', '단선', '복합식', '지하4층식', '', null, undefined])(
    '단순형이 아닌 형식 %p는 null (both 아님)',
    (format) => {
      expect(mapFormatToSide(format, 'right')).toBeNull();
    },
  );

  it.each([null, undefined, 'both', 'unknown'])('주행방향 %p는 null', (running) => {
    expect(mapFormatToSide('상대식', running)).toBeNull();
    expect(mapFormatToSide('섬식', running)).toBeNull();
  });

  it('앞뒤 공백은 trim 후 매칭', () => {
    expect(mapFormatToSide('  상대식  ', 'right')).toBe('right');
  });
});

describe('resolveStationSide (실패 사유까지 판정)', () => {
  const base = { depthFormat: '상대식', archFormat: '상대식', runningSide: 'right' };

  it('두 CSV가 일치하는 단순형이면 derived', () => {
    expect(resolveStationSide(base)).toEqual({ side: 'right', reason: 'derived' });
    expect(resolveStationSide({ ...base, depthFormat: '섬식', archFormat: '섬식' })).toEqual({
      side: 'left',
      reason: 'derived',
    });
  });

  it('심도 행이 없으면 no-depth-row', () => {
    expect(resolveStationSide({ ...base, depthFormat: null })).toEqual({
      side: null,
      reason: 'no-depth-row',
    });
  });

  it.each(['섬식(복합)', '단선'])('심도 형식 %s는 depth-not-plain', (depthFormat) => {
    expect(resolveStationSide({ ...base, depthFormat })).toEqual({
      side: null,
      reason: 'depth-not-plain',
    });
  });

  it('건축 CSV에 없으면 arch-missing (교차 검증 불가 → null)', () => {
    expect(resolveStationSide({ ...base, archFormat: null })).toEqual({
      side: null,
      reason: 'arch-missing',
    });
  });

  it('두 CSV가 다르면 format-disagree', () => {
    expect(resolveStationSide({ ...base, archFormat: '복합식' })).toEqual({
      side: null,
      reason: 'format-disagree',
    });
    expect(resolveStationSide({ ...base, depthFormat: '섬식', archFormat: '상대식' })).toEqual({
      side: null,
      reason: 'format-disagree',
    });
  });

  it('주행방향 근거가 없으면 running-side-unknown', () => {
    expect(resolveStationSide({ ...base, runningSide: null })).toEqual({
      side: null,
      reason: 'running-side-unknown',
    });
  });
});

describe('parseCsvLine', () => {
  it('따옴표로 감싼 컬럼을 분리', () => {
    expect(parseCsvLine('"1","서울","섬식","B2"')).toEqual(['1', '서울', '섬식', 'B2']);
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

describe('stripParens / buildNameAliases', () => {
  it.each([
    ['한양대', '한양대'],
    ['청량리(서울시립대입구)', '청량리'],
    ['서울(메인)(B)역', '서울역'],
    ['동대문(역사', '동대문(역사'],
    ['', ''],
  ])('stripParens "%s" → "%s"', (input, expected) => {
    expect(stripParens(input)).toBe(expected);
  });

  it('buildNameAliases: 괄호·역 접미사 변형', () => {
    expect(buildNameAliases('한양대')).toEqual(['한양대']);
    expect(buildNameAliases('서울역(중앙)')).toEqual(['서울역(중앙)', '서울역', '서울']);
  });
});

describe('build (실데이터: 공식 역사심도정보 + 건축정보)', () => {
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

  const sideOf = (id) => result.output[id]?.side ?? null;

  it("'both'는 출력 어디에도 없다", () => {
    const sides = Object.values(result.output).map((entry) => entry.side);
    expect(sides).not.toContain('both');
    expect(new Set(sides)).toEqual(new Set(['left', 'right']));
    expect(JSON.stringify(result.output)).not.toContain('both');
  });

  it('모든 항목은 출처 등급을 가진다', () => {
    for (const entry of Object.values(result.output)) {
      expect(entry.grade).toBe(GRADE_OFFICIAL_DERIVED);
    }
  });

  it('사용자 단골역: 공식 형식과 일치하는 값', () => {
    expect(sideOf('7-015')).toBe('right'); // 용마산 (상대식)
    expect(sideOf('2-012')).toBe('right'); // 건대입구 2호선 (상대식)
    expect(sideOf('7-019')).toBe('right'); // 건대입구 7호선 (상대식)
    expect(sideOf('2-010')).toBe('right'); // 뚝섬 (상대식)
    expect(sideOf('7-022')).toBe('right'); // 강남구청 7호선 (상대식)
    expect(sideOf('5-035')).toBe('left'); // 군자 5호선 (섬식)
    expect(sideOf('7-017')).toBe('right'); // 군자 7호선 (상대식)
    expect(sideOf('7-018')).toBe('right'); // 어린이대공원 (상대식)
  });

  it('서울숲(수인분당)은 본 데이터셋(1~8호선) 밖이라 키가 없다', () => {
    expect(result.output['bundang-052']).toBeUndefined();
  });

  it('두 CSV가 불일치하는 13개 역은 전부 null (성수 포함: 추정 금지)', () => {
    const disagree = [
      '2-011', // 성수 (심도 섬식 / 건축 복합식)
      '2-034', // 신도림
      '3-041', // 수서
      '5-001', // 방화
      '5-039', // 강동
      '6-007', // 새절
      '6-033', // 상월곡
      '6-038', // 봉화산
      '6-039', // 신내
      '7-003', // 수락산
      '7-021', // 청담
      '7-042', // 온수
    ];
    for (const id of disagree) {
      expect(result.output[id]).toBeUndefined();
    }
    const reasons = Object.fromEntries(result.nullList.map((e) => [e.id, e.reason]));
    expect(reasons['2-011']).toBe('format-disagree');
    expect(reasons['7-003']).toBe('depth-not-plain'); // 섬식(복합)은 형식 비교 전에 탈락
  });

  it('섬식(복합)/단선 → null, 사유는 depth-not-plain 또는 format-disagree', () => {
    const reasons = Object.fromEntries(result.nullList.map((e) => [e.id, e.reason]));
    expect(['depth-not-plain', 'format-disagree']).toContain(reasons['7-003']); // 수락산 섬식(복합)
    expect(['depth-not-plain', 'format-disagree']).toContain(reasons['6-039']); // 신내 단선
  });

  it('종착역도 override 없이 CSV 형식대로 (암사·모란·마천·오금·응암)', () => {
    expect(sideOf('8-001')).toBe('right'); // 암사 (상대식)
    expect(sideOf('8-018')).toBe('right'); // 모란 (상대식)
    expect(sideOf('5-046')).toBe('right'); // 마천 (상대식)
    expect(sideOf('3-044')).toBe('right'); // 오금 (상대식)
    expect(sideOf('6-001')).toBe('left'); // 응암 (섬식)
  });

  it('주행방향 미검증 1호선은 전부 null (running-side-unknown)', () => {
    const line1 = Object.keys(result.output).filter((id) => id.startsWith('1-'));
    expect(line1).toEqual([]);
    const reasons = result.nullList.filter((e) => e.line === '1').map((e) => e.reason);
    expect(reasons).toContain('running-side-unknown');
  });

  it('이름 불일치 13쌍이 별칭으로 매칭된다 (을지3가→을지로3가 등)', () => {
    expect(sideOf('2-003')).toBe('right'); // 을지로3가
    expect(sideOf('2-004')).toBe('right'); // 을지로4가
    expect(sideOf('2-032')).toBe('right'); // 구로디지털단지 (depth: 구로디지털, 상대식)
    const noRow = result.nullList.filter((e) => e.reason === 'no-depth-row').map((e) => e.name);
    expect(noRow).not.toContain('을지로3가');
    expect(noRow).not.toContain('구로디지털단지');
  });

  it('커밋된 src/data/platformExitSide.json은 build() 결과와 일치한다 (drift 방지)', () => {
    const committed = JSON.parse(
      fs.readFileSync(require('node:path').join(__dirname, '../../src/data/platformExitSide.json'), 'utf8'),
    );
    expect(committed).toEqual(result.output);
  });

  it('출력 키는 id 사전순, 파일 끝 newline', () => {
    const writtenJson = writeSpy.mock.calls[0][1];
    const keys = Object.keys(JSON.parse(writtenJson));
    expect(keys).toEqual(keys.slice().sort((a, b) => a.localeCompare(b)));
    expect(writtenJson.endsWith('\n')).toBe(true);
  });

  it('stats: 1~8호선 354역 전부 분류(left+right+null)', () => {
    const { left, right, unknown } = result.stats;
    expect(left + right + unknown).toBe(354);
    expect(result.stats).not.toHaveProperty('both');
  });
});

describe('build (방어 경로: 합성 CSV)', () => {
  const realRead = fs.readFileSync;
  let readSpy;
  let writeSpy;
  let logSpy;

  const DEPTH_HEADER = '연번,호선,역명,층수,형식,지반고\n';
  const ARCH_HEADER = '"호선","역명","형식","층수"\n';

  function mockFiles({ depth, arch, stations, aliases = {}, running }) {
    readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, enc) => {
      const name = String(file);
      if (name.endsWith('서울교통공사_역사심도정보_20241104.csv')) return DEPTH_HEADER + depth;
      if (name.endsWith('seoul-station-architecture.csv')) return ARCH_HEADER + arch;
      if (name.endsWith('src/data/stations.json')) return JSON.stringify(stations);
      if (name.endsWith('platform-name-aliases.json')) return JSON.stringify(aliases);
      if (name.endsWith('line-running-side.json')) return JSON.stringify(running);
      return realRead(file, enc);
    });
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  }

  afterEach(() => {
    readSpy?.mockRestore();
    writeSpy?.mockRestore();
    logSpy?.mockRestore();
  });

  const RUNNING = {
    1: { side: 'left' },
    2: { side: 'right' },
  };

  it('좌측통행 노선은 좌/우가 반전된다 (테이블 주도)', () => {
    mockFiles({
      depth: '1,1,시청,B2,상대식,1\n2,1,서울,B2,섬식,1\n',
      arch: '"1","시청","상대식","B2"\n"1","서울","섬식","B2"\n',
      stations: [
        { id: '1-001', line: '1', name: '시청' },
        { id: '1-002', line: '1', name: '서울역' },
      ],
      running: RUNNING,
    });
    const r = build();
    expect(r.output['1-001']).toEqual({ side: 'left', grade: GRADE_OFFICIAL_DERIVED });
    expect(r.output['1-002']).toEqual({ side: 'right', grade: GRADE_OFFICIAL_DERIVED });
  });

  it('주행방향 테이블에 없는 노선/null 노선은 running-side-unknown', () => {
    mockFiles({
      depth: '1,2,시청,B2,상대식,1\n',
      arch: '"2","시청","상대식","B2"\n',
      stations: [{ id: '2-001', line: '2', name: '시청' }],
      running: { 2: { side: null } },
    });
    const r = build();
    expect(r.output).toEqual({});
    expect(r.nullList).toEqual([
      { id: '2-001', line: '2', name: '시청', reason: 'running-side-unknown', depthFormat: '상대식', archFormat: '상대식' },
    ]);
  });

  it('별칭: 심도 CSV 표기를 건축/stations 표기로 정규화한다', () => {
    mockFiles({
      depth: '1,2,을지3가,B2,상대식,1\n',
      arch: '"2","을지로3가","상대식","B2"\n',
      stations: [{ id: '2-003', line: '2', name: '을지로3가' }],
      aliases: { '2|을지3가': '을지로3가' },
      running: RUNNING,
    });
    const r = build();
    expect(r.output['2-003']).toEqual({ side: 'right', grade: GRADE_OFFICIAL_DERIVED });
  });

  it('빈 행·짧은 행은 건너뛰고, 행이 없는 역은 no-depth-row', () => {
    mockFiles({
      depth: '\n1,2\n',
      arch: '\n"x"\n',
      stations: [{ id: '2-001', line: '2', name: '가상역' }],
      running: RUNNING,
    });
    const r = build();
    expect(r.nullList[0]).toMatchObject({ id: '2-001', reason: 'no-depth-row' });
    expect(r.stats.unknown).toBe(1);
  });

  it('unknown이 비면 검수 헤더를 출력하지 않는다', () => {
    mockFiles({
      depth: '1,2,시청,B2,상대식,1\n',
      arch: '"2","시청","상대식","B2"\n',
      stations: [{ id: '2-001', line: '2', name: '시청' }],
      running: RUNNING,
    });
    build();
    const logs = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(logs).not.toContain('null 리스트 (사유별)');
  });
});
