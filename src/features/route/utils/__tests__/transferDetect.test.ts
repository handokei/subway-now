import { detectTransfer, TRANSFER_DETECT_IMMINENT_SECONDS } from '../transferDetect';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
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

  it('다중 노선 후보 모두 반환(arrivalSeconds 작은 순)', () => {
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

  it('다중 노선: arvlCd priority 높은 line이 topPick (#973)', () => {
    // line 5는 60초 남았지만 arvlCd=1(도착) 강한 신호, line 4는 30초+arvlCd=2(출발=priority 0).
    // priority desc → ['5', '4'].
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [
        { line: '4', arrivalSeconds: 30, arrivalCode: ARRIVAL_CODE.DEPARTED },
        { line: '5', arrivalSeconds: 60, arrivalCode: ARRIVAL_CODE.ARRIVED },
      ],
    });
    expect(result.candidateLines).toEqual(['5', '4']);
  });

  it('다중 노선: 같은 priority면 arrivalSeconds 작은 순 (#973)', () => {
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [
        { line: '4', arrivalSeconds: 120, arrivalCode: ARRIVAL_CODE.ENTERING },
        { line: '5', arrivalSeconds: 60, arrivalCode: ARRIVAL_CODE.ENTERING },
      ],
    });
    expect(result.candidateLines).toEqual(['5', '4']);
  });

  it('arrivalCode 없는 항목은 priority 0, seconds로 tiebreak (#973)', () => {
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [
        { line: '4', arrivalSeconds: 90 },
        { line: '5', arrivalSeconds: 30 },
      ],
    });
    expect(result.candidateLines).toEqual(['5', '4']);
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

  it('같은 노선 dedup: 강한 arvlCd 신호가 정렬 키로 채택 (#973)', () => {
    // line 4는 weak(seconds=30 priority=0), line 5는 strong(seconds=120 priority=100).
    // 같은 line 4 안에서도 후순위로 들어온 priority=80(ENTERING)가 best로 채택되어야 한다.
    const result = detectTransfer({
      nearestStations: transferNearest,
      motionWalking: true,
      otherLineArrivals: [
        { line: '4', arrivalSeconds: 30 },
        { line: '4', arrivalSeconds: 60, arrivalCode: ARRIVAL_CODE.ENTERING },
        { line: '5', arrivalSeconds: 120, arrivalCode: ARRIVAL_CODE.ARRIVED },
      ],
    });
    // line 5: priority 100. line 4 best: priority 80 (ENTERING 채택). → ['5', '4'].
    expect(result.candidateLines).toEqual(['5', '4']);
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
