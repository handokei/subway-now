import { detectTransfer, TRANSFER_DETECT_IMMINENT_SECONDS } from '../transferDetect';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import type { NearestStationsResult } from '../../../../shared/types/station';

const transferNearest: NearestStationsResult = {
  primary: MOCK_STATIONS.chungmuro,
  variants: [MOCK_STATIONS.chungmuro],
  distanceKm: 0.05,
  isTransfer: true,
};

const nonTransferNearest: NearestStationsResult = {
  primary: MOCK_STATIONS.gangnam,
  variants: [MOCK_STATIONS.gangnam],
  distanceKm: 0.05,
  isTransfer: false,
};

describe('detectTransfer', () => {
  it('환승역 + walking + 임박 다른노선 → detected=true', () => {
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [{ line: '4', arrivalSeconds: 60 }],
    });
    expect(result).toEqual({ detected: true, candidateLines: ['4'] });
  });

  it('nearestStations=null → detect 불가', () => {
    const result = detectTransfer({
      nearestStations: null,
      motionWalking: true,
      otherLineArrivals: [{ line: '4', arrivalSeconds: 60 }],
    });
    expect(result.detected).toBe(false);
    expect(result.candidateLines).toEqual([]);
  });

  it('환승역 아님 → detect 불가', () => {
    const result = detectTransfer({
      nearestStations: nonTransferNearest,
      motionWalking: true,
      otherLineArrivals: [{ line: '4', arrivalSeconds: 60 }],
    });
    expect(result.detected).toBe(false);
  });

  it('motionWalking=false (정지) → detect 불가', () => {
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: false,
      otherLineArrivals: [{ line: '4', arrivalSeconds: 60 }],
    });
    expect(result.detected).toBe(false);
  });

  it('다른노선 도착 신호 없음 → detect 불가', () => {
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [],
    });
    expect(result.detected).toBe(false);
  });

  it('다른노선 도착이 임박 임계 초과 → detect 불가', () => {
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [{ line: '4', arrivalSeconds: TRANSFER_DETECT_IMMINENT_SECONDS + 1 }],
    });
    expect(result.detected).toBe(false);
  });

  it('임계 경계값(=180초) 포함', () => {
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [{ line: '4', arrivalSeconds: TRANSFER_DETECT_IMMINENT_SECONDS }],
    });
    expect(result.detected).toBe(true);
    expect(result.candidateLines).toEqual(['4']);
  });

  it('음수 arrivalSeconds(누락/이상값)은 제외', () => {
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [{ line: '4', arrivalSeconds: -1 }],
    });
    expect(result.detected).toBe(false);
  });

  it('다중 노선 후보 모두 반환(입력 순서 보존)', () => {
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [
        { line: '4', arrivalSeconds: 60 },
        { line: '5', arrivalSeconds: 90 },
      ],
    });
    expect(result.candidateLines).toEqual(['4', '5']);
  });

  it('같은 노선 중복 도착은 dedup, 임박한 것 우선', () => {
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [
        { line: '4', arrivalSeconds: 60 },
        { line: '4', arrivalSeconds: 180 },
      ],
    });
    expect(result.candidateLines).toEqual(['4']);
  });

  it('임박/비임박 섞임 → 임박만 candidate', () => {
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [
        { line: '4', arrivalSeconds: 60 },
        { line: '5', arrivalSeconds: 600 },
      ],
    });
    expect(result.candidateLines).toEqual(['4']);
  });
});
