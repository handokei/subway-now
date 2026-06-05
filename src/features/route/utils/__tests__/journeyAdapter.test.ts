import {
  journeyDisplayToStops,
  arrivalInfoToArrivalTrain,
  nearestResultToNearest,
} from '../journeyAdapter';
import type { Stop, StopArrivalContext } from '../journeyAdapter';
import type { JourneyDisplay } from '../../../../shared/utils/stationRoute';
import type { LineNumber } from '../../../../shared/types/station';
import { MOCK_JOURNEYS, makeNearestResult, makeArrivalInfo } from '../../../../testUtils/fixtures';

// Stop 기대값 빌더 — 중복 리터럴을 줄이고 의도(transfer/dest + arrivalContext)를 한 줄로 표현한다.
// transferTargetToLine은 'transfer' mark에서 자동으로 set되는 필드를 검증할 때 사용.
function expectedStop(
  mark: 'transfer' | 'dest',
  station: string,
  line: string,
  stopsFromPrev: string,
  note: string,
  arrivalContext: StopArrivalContext,
  transferTargetToLine?: LineNumber,
): Stop {
  return {
    station,
    line,
    stopsFromPrev,
    mark,
    note,
    arrivalContext,
    ...(transferTargetToLine && { transferTarget: { toLine: transferTargetToLine } }),
  };
}
function ctx(line: LineNumber, fromName: string, toName: string): StopArrivalContext {
  return { line, fromName, toName };
}

describe('journeyDisplayToStops', () => {
  it('should convert a direct route (single segment)', () => {
    const stops = journeyDisplayToStops(MOCK_JOURNEYS.direct);
    expect(stops).toEqual([
      { station: '강남', line: '2', mark: 'filled' },
      expectedStop('dest', '역삼', '2', '1정거장', '도착', ctx('2', '강남', '역삼')),
    ]);
  });

  it('should convert a transfer route (two segments)', () => {
    const stops = journeyDisplayToStops(MOCK_JOURNEYS.transfer);
    expect(stops).toEqual([
      { station: '효창공원앞', line: '6', mark: 'filled' },
      expectedStop('transfer', '공덕', '5', '2정거장', '환승', ctx('6', '효창공원앞', '공덕'), '5'),
      expectedStop('dest', '여의나루', '5', '3정거장', '도착', ctx('5', '공덕', '여의나루')),
    ]);
  });

  it('should convert a multi-transfer route (three segments)', () => {
    const journey: JourneyDisplay = {
      segments: [
        { line: '1', lineColor: '#0052A4', fromName: '서울역', toName: '시청', stops: 1 },
        { line: '2', lineColor: '#009D3E', fromName: '시청', toName: '을지로3가', stops: 2 },
        { line: '3', lineColor: '#EF7C1C', fromName: '을지로3가', toName: '경복궁', stops: 4 },
      ],
      totalStops: 7,
    };
    const stops = journeyDisplayToStops(journey);
    expect(stops).toHaveLength(4);
    expect(stops[0]).toEqual({ station: '서울역', line: '1', mark: 'filled' });
    expect(stops[1]).toEqual(
      expectedStop('transfer', '시청', '2', '1정거장', '환승', ctx('1', '서울역', '시청'), '2'),
    );
    expect(stops[2]).toEqual(
      expectedStop('transfer', '을지로3가', '3', '2정거장', '환승', ctx('2', '시청', '을지로3가'), '3'),
    );
    expect(stops[3]).toEqual(
      expectedStop('dest', '경복궁', '3', '4정거장', '도착', ctx('3', '을지로3가', '경복궁')),
    );
  });

  it('should handle special line numbers', () => {
    const journey: JourneyDisplay = {
      segments: [
        { line: 'airport', lineColor: '#4B81BF', fromName: '서울역', toName: '인천공항', stops: 5 },
      ],
      totalStops: 5,
    };
    const stops = journeyDisplayToStops(journey);
    expect(stops[0].line).toBe('airport');
    expect(stops[1].line).toBe('airport');
  });

  it('should return empty array for empty segments', () => {
    expect(journeyDisplayToStops({ segments: [], totalStops: 0 })).toEqual([]);
  });

  it('환승역이 곧 목적지이면 도착 노드를 환승 노드에 흡수한다', () => {
    const journey: JourneyDisplay = {
      segments: [
        { line: '2', lineColor: '#009D3E', fromName: '삼성', toName: '건대입구', stops: 7 },
        { line: '7', lineColor: '#747F00', fromName: '건대입구', toName: '군자', stops: 2 },
        { line: '5', lineColor: '#996CAC', fromName: '군자', toName: '군자', stops: 0 },
      ],
      totalStops: 9,
    };
    const stops = journeyDisplayToStops(journey);
    expect(stops).toHaveLength(3);
    expect(stops[0]).toEqual({ station: '삼성', line: '2', mark: 'filled' });
    expect(stops[1]).toEqual(
      expectedStop('transfer', '건대입구', '7', '7정거장', '환승', ctx('2', '삼성', '건대입구'), '7'),
    );
    // 흡수 케이스: 마지막 0정거장 segment가 직전 transfer를 dest로 승격.
    // arrivalContext는 직전 segment(7호선 건대입구→군자) — 사용자가 실제로 그 노선으로 내림.
    // transferTarget은 흡수 시에도 보존된다 — UI가 mark==='transfer'에만 적용하므로 무해.
    expect(stops[2]).toEqual(
      expectedStop('dest', '군자', '5', '2정거장', '환승 → 도착', ctx('7', '건대입구', '군자'), '5'),
    );
  });

  it('#665 출발=첫 환승역(stops=0)이면 transfer 노드를 출발에 흡수 + line은 다음 segment line', () => {
    // 상봉(7) → 상봉(경의중앙) → 용산. 출발과 환승역이 같은 케이스.
    const journey: JourneyDisplay = {
      segments: [
        { line: '7', lineColor: '#747F00', fromName: '상봉', toName: '상봉', stops: 0 },
        { line: 'gyeongui', lineColor: '#77C4A3', fromName: '상봉', toName: '용산', stops: 7 },
      ],
      totalStops: 7,
    };
    const stops = journeyDisplayToStops(journey);
    // 출발 노드 1개 + 도착 노드 1개 = 2개. transfer 노드는 출발에 흡수되어 별도 노드 없음.
    expect(stops).toHaveLength(2);
    // 출발 line이 첫 seg('7') 아니라 다음 seg('gyeongui') — 환승 후 노선 시각 표시.
    expect(stops[0]).toEqual({ station: '상봉', line: 'gyeongui', mark: 'filled' });
    expect(stops[1].mark).toBe('dest');
    expect(stops[1].station).toBe('용산');
  });

  it('#665 출발역과 환승역 이름이 다르면 흡수하지 않음 (기존 동작 유지)', () => {
    const journey: JourneyDisplay = {
      segments: [
        { line: '7', lineColor: '#747F00', fromName: '면목', toName: '상봉', stops: 1 },
        { line: 'gyeongui', lineColor: '#77C4A3', fromName: '상봉', toName: '용산', stops: 7 },
      ],
      totalStops: 8,
    };
    const stops = journeyDisplayToStops(journey);
    expect(stops).toHaveLength(3);
    expect(stops[0].station).toBe('면목');
    expect(stops[1].mark).toBe('transfer');
  });

  describe('expanded option', () => {
    it('expanded: false (기본)이면 intermediate stop이 없다', () => {
      const stops = journeyDisplayToStops(MOCK_JOURNEYS.direct);
      expect(stops.some((s) => s.mark === 'intermediate')).toBe(false);
    });

    it('expanded: true이면 segment 사이의 중간 정거장이 intermediate로 삽입된다', () => {
      // 강남(2-022) → 역삼(2-021): 인접 역이므로 중간역이 없다.
      const adjacent = journeyDisplayToStops(MOCK_JOURNEYS.direct, { expanded: true });
      expect(adjacent.filter((s) => s.mark === 'intermediate')).toHaveLength(0);

      // 강남 → 서초(2-024)는 2호선에서 강남(2-022)→교대(2-023)→서초(2-024) 순서.
      // 중간역 교대 1개가 intermediate로 삽입돼야 한다.
      const journey: JourneyDisplay = {
        segments: [{ line: '2', lineColor: '#009D3E', fromName: '강남', toName: '서초', stops: 2 }],
        totalStops: 2,
      };
      const stops = journeyDisplayToStops(journey, { expanded: true });
      const intermediates = stops.filter((s) => s.mark === 'intermediate');
      expect(intermediates).toHaveLength(1);
      expect(intermediates[0].station).toBe('교대');
      expect(intermediates[0].line).toBe('2');
      // intermediate는 stopsFromPrev/note/arrivalContext가 없는 슬림 형태
      expect(intermediates[0].stopsFromPrev).toBeUndefined();
      expect(intermediates[0].note).toBeUndefined();
      expect(intermediates[0].arrivalContext).toBeUndefined();
    });

    it('expanded: 출발/intermediate/도착 순서가 보장된다', () => {
      const journey: JourneyDisplay = {
        segments: [{ line: '2', lineColor: '#009D3E', fromName: '강남', toName: '서초', stops: 2 }],
        totalStops: 2,
      };
      const stops = journeyDisplayToStops(journey, { expanded: true });
      expect(stops.map((s) => s.mark)).toEqual(['filled', 'intermediate', 'dest']);
    });

    it('expanded: 역방향(toName이 fromName보다 인덱스가 작음)에서도 from→to 순서로 중간역이 나열된다', () => {
      // 역삼(2-021) → 강남(2-022)은 인접이라 중간역 없음. 더 긴 예: 서초(2-024) → 강남(2-022) (역방향).
      // 정답 중간역: 교대(2-023).
      const journey: JourneyDisplay = {
        segments: [{ line: '2', lineColor: '#009D3E', fromName: '서초', toName: '강남', stops: 2 }],
        totalStops: 2,
      };
      const stops = journeyDisplayToStops(journey, { expanded: true });
      const intermediates = stops.filter((s) => s.mark === 'intermediate');
      expect(intermediates.map((s) => s.station)).toEqual(['교대']);
    });

    it('expanded: seg.stops가 실제 중간역 수와 불일치하면 fallback (invariant guard)', () => {
      // 강남(2-022) → 서초(2-024) 실제 중간역 = 1개(교대). seg.stops=99(허위)면 guard 발동 → 빈 배열.
      const journey: JourneyDisplay = {
        segments: [{ line: '2', lineColor: '#009D3E', fromName: '강남', toName: '서초', stops: 99 }],
        totalStops: 99,
      };
      const stops = journeyDisplayToStops(journey, { expanded: true });
      expect(stops.some((s) => s.mark === 'intermediate')).toBe(false);
    });

    it('expanded: 알 수 없는 역명은 중간역 없이 fallback (안전)', () => {
      const journey: JourneyDisplay = {
        segments: [{ line: '2', lineColor: '#009D3E', fromName: '없는역A', toName: '없는역B', stops: 0 }],
        totalStops: 0,
      };
      const stops = journeyDisplayToStops(journey, { expanded: true });
      expect(stops.some((s) => s.mark === 'intermediate')).toBe(false);
    });
  });
});

describe('arrivalInfoToArrivalTrain', () => {
  beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(1000000); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('should convert arrival info with destination', () => {
    const items = [makeArrivalInfo({ destination: '봉화산행', arrivalSeconds: 134 })];
    const result = arrivalInfoToArrivalTrain(items, '상행', '6');
    expect(result).toEqual([
      {
        direction: '봉화산행',
        line: '6',
        arrivalAtMs: 1000000 + 134 * 1000,
        subtext: undefined,
        isLastTrain: false,
        trainType: 'normal',
        arrivalCode: -1,
      },
    ]);
  });

  it('should pass through meta fields (isLastTrain/trainType/arrivalCode)', () => {
    const items = [
      makeArrivalInfo({
        destination: '봉화산행',
        arrivalSeconds: 60,
        isLastTrain: true,
        trainType: 'express',
        arrivalCode: 1,
      }),
    ];
    const result = arrivalInfoToArrivalTrain(items, '상행', '6');
    expect(result[0].isLastTrain).toBe(true);
    expect(result[0].trainType).toBe('express');
    expect(result[0].arrivalCode).toBe(1);
  });

  it('should use direction fallback when destination is empty', () => {
    const items = [makeArrivalInfo({ destination: '', arrivalSeconds: 60 })];
    const result = arrivalInfoToArrivalTrain(items, '하행', '2');
    expect(result[0].direction).toBe('하행');
  });

  it('should include statusMessage as subtext when present', () => {
    const items = [makeArrivalInfo({ destination: '응암행', arrivalSeconds: 271, statusMessage: '전역 출발' })];
    const result = arrivalInfoToArrivalTrain(items, '상행', '6');
    expect(result[0].subtext).toBe('전역 출발');
  });

  it('should handle multiple items', () => {
    const items = [
      makeArrivalInfo({ destination: '봉화산행', arrivalSeconds: 134 }),
      makeArrivalInfo({ destination: '응암행', arrivalSeconds: 271, statusMessage: '진입 중', trainCode: 'T002' }),
    ];
    const result = arrivalInfoToArrivalTrain(items, '상행', '6');
    expect(result).toHaveLength(2);
    expect(result[1].arrivalAtMs).toBe(1000000 + 271 * 1000);
    expect(result[1].subtext).toBe('진입 중');
  });

  it('should handle special line number', () => {
    const items = [makeArrivalInfo({ destination: '인천공항행', arrivalSeconds: 600, trainCode: 'A001' })];
    const result = arrivalInfoToArrivalTrain(items, '상행', 'airport');
    expect(result[0].line).toBe('airport');
  });

  it('should return empty array for empty items', () => {
    expect(arrivalInfoToArrivalTrain([], '상행', '1')).toEqual([]);
  });
});

describe('nearestResultToNearest', () => {
  it('should convert distance from km to meters', () => {
    const nearest = nearestResultToNearest(makeNearestResult('hyochang', 0.541));
    expect(nearest.name).toBe('효창공원앞');
    expect(nearest.line).toBe('6');
    expect(nearest.distanceM).toBe(541);
  });

  it('should calculate walk time at 80m/min', () => {
    const nearest = nearestResultToNearest(makeNearestResult('gangnam', 0.4));
    expect(nearest.distanceM).toBe(400);
    expect(nearest.walkMin).toBe(5);
  });

  it('should have minimum 1 minute walk time', () => {
    const nearest = nearestResultToNearest(makeNearestResult('chungmuro', 0.01));
    expect(nearest.distanceM).toBe(10);
    expect(nearest.walkMin).toBe(1);
  });

  it('should round distance to nearest meter', () => {
    const nearest = nearestResultToNearest(makeNearestResult('yeouinaru', 0.1234));
    expect(nearest.distanceM).toBe(123);
  });

  it('should handle special line (airport)', () => {
    const nearest = nearestResultToNearest(makeNearestResult('seoulStation', 0.25));
    expect(nearest.line).toBe('airport');
    expect(nearest.walkMin).toBe(4);
  });
});
