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
  it('순환선 외(monotonic) 노선은 null', () => {
    expect(inferLoopDirection('3', '대화', '주엽')).toBeNull();
  });

  it('2호선이지만 stations 빈 경우는 null', () => {
    // line '6'을 빈 배열로 mock — 동일 분기 검증 위해 line '2'에 대해 빈 배열 시나리오를
    // 별도로 만들 수 없으므로 LOOP_LINES 분기 후 stations.length === 0 가드를 보장하기 위해
    // 임시로 mock을 덮어쓰지 않고, 빈 루프 가드는 다음 케이스(필터 결과 < 2)에서 함께 검증한다.
    // 여기서는 monotonic skip만 우선 확인.
    expect(inferLoopDirection('3', '대화', '대화')).toBeNull();
  });

  it('id 증가 방향이 짧으면 외선순환(down)', () => {
    // 시청(0) → 을지로4가(3): forward=3, backward=5 → down
    expect(inferLoopDirection('2', '시청', '을지로4가')).toBe('down');
  });

  it('id 감소(wrap) 방향이 짧으면 내선순환(up)', () => {
    // 시청(0) → 왕십리(7): forward=7, backward=1 → up
    expect(inferLoopDirection('2', '시청', '왕십리')).toBe('up');
  });

  it('정반대 위치(두 호 동일 길이)는 null', () => {
    // 루프 길이 8 → 시청(0) ↔ 동대문역사문화공원(4): forward=4, backward=4 → null
    expect(inferLoopDirection('2', '시청', '동대문역사문화공원')).toBeNull();
  });

  it('동일 역이면 null', () => {
    expect(inferLoopDirection('2', '시청', '시청')).toBeNull();
  });

  it('from이 지선(까치산)이면 메인 루프 인덱스 매칭 실패 → null', () => {
    expect(inferLoopDirection('2', '까치산', '시청')).toBeNull();
  });

  it('to가 지선이면 null', () => {
    expect(inferLoopDirection('2', '시청', '까치산')).toBeNull();
  });

  it('역명에 별칭 괄호가 붙어도 normalize로 매칭', () => {
    // 시청(0) → 을지로3가(별칭)(2): forward=2, backward=6 → down
    expect(inferLoopDirection('2', '시청', '을지로3가(별칭)')).toBe('down');
  });

  it('정확 매칭이 normalize 매칭보다 우선', () => {
    // 시청(0) → 을지로입구(1): forward=1, backward=7 → down (정확 매칭 경로 검증)
    expect(inferLoopDirection('2', '시청', '을지로입구')).toBe('down');
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
    stationRoute.getStationsOnLine = (line: string) => (line === '2' ? [] : []);
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
