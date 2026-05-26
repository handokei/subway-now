import {
  journeyDisplayToStops,
  arrivalInfoToArrivalTrain,
  nearestResultToNearest,
} from '../journeyAdapter';
import type { Stop, StopArrivalContext } from '../journeyAdapter';
import type { JourneyDisplay } from '../stationRoute';
import type { LineNumber } from '../../types/station';
import { MOCK_JOURNEYS, makeNearestResult, makeArrivalInfo } from '../../testUtils/fixtures';

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
