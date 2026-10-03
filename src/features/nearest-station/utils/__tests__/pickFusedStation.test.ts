import { pickFusedStation } from '../pickFusedStation';
import type { NearestStationResult } from '../../../../shared/types/station';
import type { StationArrival, ArrivalInfo } from '../../../../shared/types/arrival';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';

const NOW = 1_700_000_000_000; // 신선한 receivedAtMs

function info(arrivalCode: number, overrides?: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: 'X',
    arrivalMinutes: 0,
    arrivalSeconds: 0,
    statusMessage: '',
    trainCode: 'T1',
    line: '2',
    receivedAtMs: NOW,
    arrivalCode,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

function arrival(...codes: number[]): StationArrival {
  return { up: codes.map((c) => info(c)), down: [] };
}

function cand(stationKey: keyof typeof MOCK_STATIONS, distanceKm: number): NearestStationResult {
  return { station: MOCK_STATIONS[stationKey], distanceKm };
}

describe('pickFusedStation', () => {
  it('빈 후보면 null', () => {
    expect(pickFusedStation([])).toBeNull();
  });

  it('arrival 신호 없으면 GPS 최근접 + gps-only', () => {
    const result = pickFusedStation([
      { candidate: cand('gangnam', 0.1), arrival: null },
      { candidate: cand('chungmuro', 0.3), arrival: null },
    ]);
    expect(result?.result.station.id).toBe(MOCK_STATIONS.gangnam.id);
    expect(result?.confidence).toBe('gps-only');
    expect(result?.source).toBe('gps');
  });

  it('arvlCd=1(도착)인 후보가 있으면 GPS 최근접보다 우선', () => {
    const result = pickFusedStation([
      { candidate: cand('gangnam', 0.1), arrival: arrival(ARRIVAL_CODE.RUNNING) },
      { candidate: cand('chungmuro', 0.3), arrival: arrival(ARRIVAL_CODE.ARRIVED) },
    ]);
    expect(result?.result.station.id).toBe(MOCK_STATIONS.chungmuro.id);
    expect(result?.confidence).toBe('arrival-confirmed');
    expect(result?.source).toBe('arrival');
  });

  it('arvlCd=0(진입)은 arrival-arriving 신뢰도', () => {
    const result = pickFusedStation([
      { candidate: cand('gangnam', 0.1), arrival: arrival(ARRIVAL_CODE.ENTERING) },
    ]);
    expect(result?.confidence).toBe('arrival-arriving');
    expect(result?.source).toBe('arrival');
  });

  it('1(도착) > 0(진입) 우선순위', () => {
    const result = pickFusedStation([
      { candidate: cand('gangnam', 0.1), arrival: arrival(ARRIVAL_CODE.ENTERING) },
      { candidate: cand('chungmuro', 0.3), arrival: arrival(ARRIVAL_CODE.ARRIVED) },
    ]);
    expect(result?.result.station.id).toBe(MOCK_STATIONS.chungmuro.id);
  });

  it('mock 데이터(isMock)는 신호로 사용되지 않는다', () => {
    const mockArrival: StationArrival = { ...arrival(ARRIVAL_CODE.ARRIVED), isMock: true };
    const result = pickFusedStation([
      { candidate: cand('gangnam', 0.1), arrival: null },
      { candidate: cand('chungmuro', 0.3), arrival: mockArrival },
    ]);
    expect(result?.result.station.id).toBe(MOCK_STATIONS.gangnam.id);
    expect(result?.source).toBe('gps');
  });

  it('receivedAtMs=0(stale)인 신호는 무시된다', () => {
    const stale: StationArrival = { up: [info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: 0 })], down: [] };
    const result = pickFusedStation([
      { candidate: cand('gangnam', 0.1), arrival: null },
      { candidate: cand('chungmuro', 0.3), arrival: stale },
    ]);
    expect(result?.result.station.id).toBe(MOCK_STATIONS.gangnam.id);
    expect(result?.source).toBe('gps');
  });

  it('동점이면 먼저 발견된 후보 유지(첫 항목 = GPS 최근접)', () => {
    const result = pickFusedStation([
      { candidate: cand('gangnam', 0.1), arrival: arrival(ARRIVAL_CODE.ARRIVED) },
      { candidate: cand('chungmuro', 0.3), arrival: arrival(ARRIVAL_CODE.ARRIVED) },
    ]);
    expect(result?.result.station.id).toBe(MOCK_STATIONS.gangnam.id);
  });

  it('출발(2)/전역출발(3)/운행중(99)은 신호 점수 0', () => {
    const result = pickFusedStation([
      { candidate: cand('gangnam', 0.1), arrival: arrival(ARRIVAL_CODE.DEPARTED, ARRIVAL_CODE.RUNNING) },
    ]);
    expect(result?.confidence).toBe('gps-only');
    expect(result?.source).toBe('gps');
  });

  it('up/down 모두에서 최댓값을 찾는다', () => {
    const mixed: StationArrival = {
      up: [info(ARRIVAL_CODE.ENTERING)],
      down: [info(ARRIVAL_CODE.ARRIVED)],
    };
    const result = pickFusedStation([{ candidate: cand('gangnam', 0.1), arrival: mixed }]);
    expect(result?.confidence).toBe('arrival-confirmed');
  });

  describe('position 신호 (Phase 3)', () => {
    const train = (trainStatus: number, receivedAtMs = NOW) => ({
      statnId: 'X',
      statnNm: 'X',
      trainNo: 'T',
      trainStatus,
      updnLine: 0,
      terminalStationId: '',
      terminalStationName: '',
      trainType: 'normal' as const,
      isLastTrain: false,
      receivedAtMs,
    });

    it('positionMatches에 ARRIVED(1) 트레인 → arrival-confirmed + source=position', () => {
      const result = pickFusedStation([
        { candidate: cand('gangnam', 0.1), positionMatches: [train(1)] },
      ]);
      expect(result?.confidence).toBe('arrival-confirmed');
      expect(result?.source).toBe('position');
    });

    it('positionMatches에 ENTERING(0) → arrival-arriving + source=position', () => {
      const result = pickFusedStation([
        { candidate: cand('gangnam', 0.1), positionMatches: [train(0)] },
      ]);
      expect(result?.confidence).toBe('arrival-arriving');
      expect(result?.source).toBe('position');
    });

    it('arrival과 position 동시 ARRIVED → source=position 우선', () => {
      const result = pickFusedStation([
        {
          candidate: cand('gangnam', 0.1),
          arrival: arrival(ARRIVAL_CODE.ARRIVED),
          positionMatches: [train(1)],
        },
      ]);
      expect(result?.source).toBe('position');
    });

    it('positionMatches stale(receivedAtMs<=0)는 무시', () => {
      const result = pickFusedStation([
        { candidate: cand('gangnam', 0.1), positionMatches: [train(1, 0)] },
      ]);
      expect(result?.source).toBe('gps');
    });

    it('positionMatches 빈 배열/null → 신호 없음', () => {
      const r1 = pickFusedStation([{ candidate: cand('gangnam', 0.1), positionMatches: [] }]);
      const r2 = pickFusedStation([{ candidate: cand('gangnam', 0.1), positionMatches: null }]);
      expect(r1?.source).toBe('gps');
      expect(r2?.source).toBe('gps');
    });

    it('positionMatches에 여러 트레인 있으면 가장 강한 신호 채택', () => {
      const result = pickFusedStation([
        {
          candidate: cand('gangnam', 0.1),
          // ARRIVED → ENTERING 순서: 첫 번째 트레인이 더 강해 두 번째는 무시되는 분기 커버
          positionMatches: [train(1), train(0)],
        },
      ]);
      expect(result?.confidence).toBe('arrival-confirmed');
    });

    it('두 후보 중 position 신호가 있는 후보로 fusion 전환', () => {
      const result = pickFusedStation([
        { candidate: cand('gangnam', 0.1) }, // 신호 없음
        { candidate: cand('chungmuro', 0.3), positionMatches: [train(1)] },
      ]);
      expect(result?.result.station.id).toBe(MOCK_STATIONS.chungmuro.id);
      expect(result?.source).toBe('position');
    });
  });
});
