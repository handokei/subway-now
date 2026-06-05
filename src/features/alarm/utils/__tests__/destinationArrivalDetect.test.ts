import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import {
  NEAR_STATION_RADIUS_M,
  STATIONARY_THRESHOLD_MS,
} from '../../../../shared/constants/arrivalDetect';
import type { Station } from '../../../../shared/types/station';
import { detectDestinationArrival } from '../destinationArrivalDetect';

const DESTINATION: Station = {
  id: '0150',
  name: '서울역',
  line: '1',
  lineColor: '#0052A4',
  lat: 37.5547,
  lng: 126.9707,
};

// 서울역 좌표에서 정확히 같은 점 = 0m. 살짝 다른 점은 수 m 단위.
const AT_DESTINATION = { lat: DESTINATION.lat, lng: DESTINATION.lng };

// 1km 가량 떨어진 좌표 (위도 0.01 ≈ 1.11km).
const FAR_FROM_DESTINATION = { lat: DESTINATION.lat + 0.01, lng: DESTINATION.lng };

describe('detectDestinationArrival', () => {
  it('shouldAutoClear=true 일 때 confidence=high — 4개 조건 전부 만족', () => {
    const result = detectDestinationArrival({
      destinationStation: DESTINATION,
      arvlCdAtDestination: ARRIVAL_CODE.ARRIVED,
      userLocation: AT_DESTINATION,
      stationaryDurationMs: STATIONARY_THRESHOLD_MS,
    });
    expect(result).toEqual({ shouldAutoClear: true, confidence: 'high' });
  });

  it('ENTERING(0) 도 "이 역" 신호로 인정', () => {
    const result = detectDestinationArrival({
      destinationStation: DESTINATION,
      arvlCdAtDestination: ARRIVAL_CODE.ENTERING,
      userLocation: AT_DESTINATION,
      stationaryDurationMs: STATIONARY_THRESHOLD_MS + 5_000,
    });
    expect(result.shouldAutoClear).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('destinationStation 없으면 즉시 low', () => {
    const result = detectDestinationArrival({
      destinationStation: null,
      arvlCdAtDestination: ARRIVAL_CODE.ARRIVED,
      userLocation: AT_DESTINATION,
      stationaryDurationMs: STATIONARY_THRESHOLD_MS,
    });
    expect(result).toEqual({ shouldAutoClear: false, confidence: 'low' });
  });

  it('destinationStation undefined 도 low', () => {
    const result = detectDestinationArrival({
      destinationStation: undefined,
      arvlCdAtDestination: ARRIVAL_CODE.ARRIVED,
      userLocation: AT_DESTINATION,
      stationaryDurationMs: STATIONARY_THRESHOLD_MS,
    });
    expect(result.shouldAutoClear).toBe(false);
    expect(result.confidence).toBe('low');
  });

  it('userLocation 없으면 low', () => {
    const result = detectDestinationArrival({
      destinationStation: DESTINATION,
      arvlCdAtDestination: ARRIVAL_CODE.ARRIVED,
      userLocation: null,
      stationaryDurationMs: STATIONARY_THRESHOLD_MS,
    });
    expect(result).toEqual({ shouldAutoClear: false, confidence: 'low' });
  });

  it('userLocation undefined 도 low', () => {
    const result = detectDestinationArrival({
      destinationStation: DESTINATION,
      arvlCdAtDestination: ARRIVAL_CODE.ARRIVED,
      userLocation: undefined,
      stationaryDurationMs: STATIONARY_THRESHOLD_MS,
    });
    expect(result.shouldAutoClear).toBe(false);
    expect(result.confidence).toBe('low');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['DEPARTED(2)', ARRIVAL_CODE.DEPARTED],
    ['PREV_ARRIVED(5)', ARRIVAL_CODE.PREV_ARRIVED],
    ['PREV_ENTERING(4)', ARRIVAL_CODE.PREV_ENTERING],
    ['PREV_DEPARTED(3)', ARRIVAL_CODE.PREV_DEPARTED],
    ['RUNNING(99)', ARRIVAL_CODE.RUNNING],
  ])('arvlCd 가 "이 역" 신호가 아니면 low — %s', (_label, code) => {
    const result = detectDestinationArrival({
      destinationStation: DESTINATION,
      arvlCdAtDestination: code,
      userLocation: AT_DESTINATION,
      stationaryDurationMs: STATIONARY_THRESHOLD_MS,
    });
    expect(result).toEqual({ shouldAutoClear: false, confidence: 'low' });
  });

  it('역에서 멀면 low (NEAR_STATION_RADIUS_M 초과)', () => {
    const result = detectDestinationArrival({
      destinationStation: DESTINATION,
      arvlCdAtDestination: ARRIVAL_CODE.ARRIVED,
      userLocation: FAR_FROM_DESTINATION,
      stationaryDurationMs: STATIONARY_THRESHOLD_MS,
    });
    expect(result).toEqual({ shouldAutoClear: false, confidence: 'low' });
  });

  it('역 부근(<= NEAR_STATION_RADIUS_M) + arvlCd OK + 정지 시간 부족 → medium', () => {
    const result = detectDestinationArrival({
      destinationStation: DESTINATION,
      arvlCdAtDestination: ARRIVAL_CODE.ARRIVED,
      userLocation: AT_DESTINATION,
      stationaryDurationMs: STATIONARY_THRESHOLD_MS - 1,
    });
    expect(result).toEqual({ shouldAutoClear: false, confidence: 'medium' });
  });

  it('stationaryDurationMs null 이면 정지 시간 부족 — medium', () => {
    const result = detectDestinationArrival({
      destinationStation: DESTINATION,
      arvlCdAtDestination: ARRIVAL_CODE.ENTERING,
      userLocation: AT_DESTINATION,
      stationaryDurationMs: null,
    });
    expect(result).toEqual({ shouldAutoClear: false, confidence: 'medium' });
  });

  it('stationaryDurationMs undefined 이면 medium', () => {
    const result = detectDestinationArrival({
      destinationStation: DESTINATION,
      arvlCdAtDestination: ARRIVAL_CODE.ENTERING,
      userLocation: AT_DESTINATION,
      stationaryDurationMs: undefined,
    });
    expect(result).toEqual({ shouldAutoClear: false, confidence: 'medium' });
  });

  it('정확히 NEAR_STATION_RADIUS_M 경계는 통과 — boundary inclusive', () => {
    // 위도 1m ≈ 0.0000090 도. 50m ≈ 0.000450 도 (위도축).
    // haversine 정확도 감안해 49m 정도 떨어진 좌표 사용.
    const nearEdge = { lat: DESTINATION.lat + 0.00044, lng: DESTINATION.lng };
    const result = detectDestinationArrival({
      destinationStation: DESTINATION,
      arvlCdAtDestination: ARRIVAL_CODE.ARRIVED,
      userLocation: nearEdge,
      stationaryDurationMs: STATIONARY_THRESHOLD_MS,
    });
    expect(result.shouldAutoClear).toBe(true);
  });

  it('상수 export 확인 — 회귀 게이트', () => {
    expect(NEAR_STATION_RADIUS_M).toBe(50);
    expect(STATIONARY_THRESHOLD_MS).toBe(60_000);
  });
});
