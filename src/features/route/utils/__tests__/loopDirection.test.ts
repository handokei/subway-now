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
    if (line === '6') {
      // 6호선 hybrid 노선: 응암 단방향 루프(6-001~6-007) + 본선(6-008~6-039).
      // 본 fixture는 운영 구간(6-001~6-017)만 발췌 — main range 안에서 id 단조 비교만으로
      // 방향 결정. 6-007 새절은 루프와 본선의 연결점.
      return [
        { id: '6-001', name: '응암', line: '6' },
        { id: '6-002', name: '역촌', line: '6' },
        { id: '6-003', name: '불광', line: '6' },
        { id: '6-004', name: '독바위', line: '6' },
        { id: '6-005', name: '연신내', line: '6' },
        { id: '6-006', name: '구산', line: '6' },
        { id: '6-007', name: '새절', line: '6' }, // normalize 매칭(원본 '새절(신사)')
        { id: '6-008', name: '증산', line: '6' },
        { id: '6-009', name: '디지털미디어시티', line: '6' },
        { id: '6-010', name: '월드컵경기장', line: '6' },
        { id: '6-011', name: '마포구청', line: '6' },
        { id: '6-012', name: '망원', line: '6' },
        { id: '6-013', name: '합정', line: '6' },
        { id: '6-014', name: '상수', line: '6' },
        { id: '6-015', name: '광흥창', line: '6' },
        { id: '6-016', name: '대흥', line: '6' },
        { id: '6-017', name: '공덕', line: '6' },
      ];
    }
    if (line === '9') return []; // 빈 노선 (closedLoops에 없음)
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

describe('inferLoopDirection — 순환선 (2호선)', () => {
  // 케이스: [설명, line, from, to, 기대값]
  // - CLOSED_LOOPS 미포함 노선 / 동일 역 / 정반대 위치 / 지선 매칭 실패 → null
  // - id 증가 방향이 짧으면 'down' (외선순환), wrap 방향이 짧으면 'up' (내선순환)
  // - normalize는 정확 매칭 다음 fallback
  const cases: Array<[string, '2' | '3', string, string, 'up' | 'down' | null]> = [
    ['CLOSED_LOOPS 외(monotonic) 노선은 null', '3', '대화', '주엽', null],
    ['CLOSED_LOOPS 미포함 노선은 동일 역도 null', '3', '대화', '대화', null],
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

describe('inferLoopDirection — 하이브리드 노선 (6호선 응암 루프, #1703)', () => {
  // 6호선은 P자 노선(응암 단방향 꼬리 + 본선). closedLoops.6.loopTailRange 존재 → wrap 비교
  // 비활성화. 단순 id 단조 비교로 동작:
  //   - id 증가 = 'down' (신내 방면)
  //   - id 감소 = 'up' (응암 방면)
  // 사용자 6/23 트립 evidence: 합정(6-013) → 공덕(6-017) 'down'이어야 backend가 응암 방면
  // 6184 train code를 잘못 잡지 않는다.
  const cases: Array<[string, string, string, 'up' | 'down' | null]> = [
    ['합정(12) → 공덕(16) 본선 forward → down', '합정', '공덕', 'down'],
    ['합정(12) → 망원(11) 본선 backward → up', '합정', '망원', 'up'],
    ['응암(0) → 연신내(4) 루프 안 forward → down', '응암', '연신내', 'down'],
    ['새절(6) → 증산(7) 루프 끝→본선 forward → down', '새절', '증산', 'down'],
    ['공덕(16) → 응암(0) 본선→루프 backward → up', '공덕', '응암', 'up'],
    ['연신내(4) → 응암(0) 루프 backward → up', '연신내', '응암', 'up'],
    ['동일 역이면 null', '합정', '합정', null],
    ['미존재 from → null', '없는역', '공덕', null],
    ['미존재 to → null', '합정', '없는역', null],
    ['새절(신사) 원본명 → normalize 매칭으로 새절 → down 유지', '새절(신사)', '증산', 'down'],
  ];

  it.each(cases)('%s', (_desc, from, to, expected) => {
    expect(inferLoopDirection('6', from, to)).toBe(expected);
  });
});

describe('inferLoopDirection — empty/small loop guards', () => {
  // line '9'는 closedLoops에 없어 stations.length === 0 분기 자체에 도달하지 않는다.
  // stations 빈 배열 + small loop 가드를 명시적으로 커버하기 위해 mock을 재설정.
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

  it('하이브리드 노선(6)도 메인 구간 1개 이하면 null', () => {
    stationRoute.getStationsOnLine = (line: string) =>
      line === '6' ? [{ id: '6-001', name: '응암', line: '6' }] : [];
    expect(inferLoopDirection('6', '응암', '공덕')).toBeNull();
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
