import {
  journeyDisplayToStops,
  arrivalInfoToArrivalTrain,
  nearestResultToNearest,
} from '../journeyAdapter';
import { MOCK_JOURNEYS, makeNearestResult, makeArrivalInfo } from '../../testUtils/fixtures';

describe('journeyDisplayToStops', () => {
  it('should convert a direct route (single segment)', () => {
    const stops = journeyDisplayToStops(MOCK_JOURNEYS.direct);
    expect(stops).toEqual([
      { station: '강남', line: '2', mark: 'filled' },
      { station: '역삼', line: '2', stopsFromPrev: '1정거장', mark: 'dest', note: '도착' },
    ]);
  });

  it('should convert a transfer route (two segments)', () => {
    const stops = journeyDisplayToStops(MOCK_JOURNEYS.transfer);
    expect(stops).toEqual([
      { station: '효창공원앞', line: '6', mark: 'filled' },
      { station: '공덕', line: '5', stopsFromPrev: '2정거장', mark: 'transfer', note: '환승' },
      { station: '여의나루', line: '5', stopsFromPrev: '3정거장', mark: 'dest', note: '도착' },
    ]);
  });

  it('should convert a multi-transfer route (three segments)', () => {
    const journey = {
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
    expect(stops[1]).toEqual({ station: '시청', line: '2', stopsFromPrev: '1정거장', mark: 'transfer', note: '환승' });
    expect(stops[2]).toEqual({ station: '을지로3가', line: '3', stopsFromPrev: '2정거장', mark: 'transfer', note: '환승' });
    expect(stops[3]).toEqual({ station: '경복궁', line: '3', stopsFromPrev: '4정거장', mark: 'dest', note: '도착' });
  });

  it('should handle special line numbers', () => {
    const journey = {
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
});

describe('arrivalInfoToArrivalTrain', () => {
  beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(1000000); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('should convert arrival info with destination', () => {
    const items = [makeArrivalInfo({ destination: '봉화산행', arrivalSeconds: 134 })];
    const result = arrivalInfoToArrivalTrain(items, '상행', '6');
    expect(result).toEqual([
      { direction: '봉화산행', line: '6', arrivalAtMs: 1000000 + 134 * 1000, subtext: undefined },
    ]);
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
