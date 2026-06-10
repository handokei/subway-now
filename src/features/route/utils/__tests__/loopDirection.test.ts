import { inferLoopDirection, parseTrainLineDirection } from '../loopDirection';

jest.mock('../../../../shared/utils/stationRoute', () => ({
  getStationsOnLine: (line: string) => {
    if (line === '2') {
      // 8역짜리 가짜 루프 + 지선(2-105) 1개. 메인 루프만 추론 대상.
      return [
        { id: '2-001', name: '시청', line: '2' },
        { id: '2-002', name: '을지로입구', line: '2' },
        { id: '2-003', name: '을지로3가', line: '2' },
        { id: '2-004', name: '을지로4가', line: '2' },
        { id: '2-005', name: '동대문역사문화공원', line: '2' },
        { id: '2-006', name: '신당', line: '2' },
        { id: '2-007', name: '상왕십리', line: '2' },
        { id: '2-008', name: '왕십리', line: '2' },
        { id: '2-105', name: '까치산', line: '2' }, // 지선 — 추론 대상 외
      ];
    }
    if (line === '3') return [{ id: '3-0', name: '대화', line: '3' }];
    if (line === '6') return []; // 빈 노선
    return [];
  },
  normalizeStationName: (name: string) => {
    if (name.endsWith(')')) {
      const open = name.lastIndexOf('(');
      if (open > 0) return name.slice(0, open).trim();
    }
    return name;
  },
}));

describe('inferLoopDirection', () => {
  // 케이스: [설명, line, from, to, 기대값]
  // - LOOP_LINES(2호선) 외 / 동일 역 / 정반대 위치 / 지선 매칭 실패 → null
  // - id 증가 방향이 짧으면 'down' (외선순환), wrap 방향이 짧으면 'up' (내선순환)
  // - normalize는 정확 매칭 다음 fallback
  const cases: Array<[string, '2' | '3', string, string, 'up' | 'down' | null]> = [
    ['순환선 외(monotonic) 노선은 null', '3', '대화', '주엽', null],
    ['LOOP_LINES 미포함 노선은 동일 역도 null', '3', '대화', '대화', null],
    ['시청(0) → 을지로4가(3): forward=3, backward=5 → down', '2', '시청', '을지로4가', 'down'],
    ['시청(0) → 왕십리(7): forward=7, backward=1 → up', '2', '시청', '왕십리', 'up'],
    ['시청(0) ↔ 동대문역사문화공원(4): 정반대 → null', '2', '시청', '동대문역사문화공원', null],
    ['동일 역이면 null', '2', '시청', '시청', null],
    ['from이 지선(까치산) → null', '2', '까치산', '시청', null],
    ['to가 지선(까치산) → null', '2', '시청', '까치산', null],
    ['시청(0) → 을지로3가(별칭)(2): normalize 매칭 → down', '2', '시청', '을지로3가(별칭)', 'down'],
    ['시청(0) → 을지로입구(1): 정확 매칭 우선 → down', '2', '시청', '을지로입구', 'down'],
  ];

  it.each(cases)('%s', (_desc, line, from, to, expected) => {
    expect(inferLoopDirection(line, from, to)).toBe(expected);
  });
});

describe('inferLoopDirection — empty/small loop guards', () => {
  // line '6'은 빈 배열을 반환하지만 LOOP_LINES에 포함돼있지 않아 stations.length === 0 분기에
  // 도달하지 않는다. 해당 가드 + 'loop.length < 2' 가드를 명시적으로 커버하기 위해
  // 임시로 mock을 재설정해 line '2'를 빈 배열 / 단일 항목으로 만든다.
  const stationRoute = jest.requireMock('../../../../shared/utils/stationRoute') as {
    getStationsOnLine: (line: string) => Array<{ id: string; name: string; line: string }>;
  };
  const original = stationRoute.getStationsOnLine;

  afterEach(() => {
    stationRoute.getStationsOnLine = original;
  });

  it('순환선이지만 stations 빈 배열이면 null', () => {
    stationRoute.getStationsOnLine = () => [];
    expect(inferLoopDirection('2', '시청', '왕십리')).toBeNull();
  });

  it('메인 루프 station이 1개 이하면 null', () => {
    stationRoute.getStationsOnLine = (line: string) =>
      line === '2' ? [{ id: '2-001', name: '시청', line: '2' }] : [];
    expect(inferLoopDirection('2', '시청', '왕십리')).toBeNull();
  });
});

describe('parseTrainLineDirection', () => {
  it('"내선순환" → up', () => {
    expect(parseTrainLineDirection('내선순환')).toBe('up');
  });

  it('"외선순환" → down', () => {
    expect(parseTrainLineDirection('외선순환')).toBe('down');
  });

  it('내선순환 부분 문자열도 인식', () => {
    expect(parseTrainLineDirection('2호선 내선순환 열차')).toBe('up');
  });

  it('역명행 패턴은 null (이 util 범위 외)', () => {
    expect(parseTrainLineDirection('성수행')).toBeNull();
  });

  it('빈 문자열은 null', () => {
    expect(parseTrainLineDirection('')).toBeNull();
  });
});
