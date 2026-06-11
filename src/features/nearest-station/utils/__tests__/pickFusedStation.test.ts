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

  describe('R-10 §4.3 tie-break (#1169)', () => {
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

    it('같은 tier(arrival-confirmed) + score 동률 + freshness 다름 → 더 최근 신호 후보 선택', () => {
      // gangnam: 오래된 ARRIVED, chungmuro: 최근 ARRIVED. 점수는 둘 다 100(arrival-confirmed).
      const olderArrival: StationArrival = {
        up: [info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: NOW - 60_000 })],
        down: [],
      };
      const newerArrival: StationArrival = {
        up: [info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: NOW })],
        down: [],
      };
      const result = pickFusedStation([
        { candidate: cand('gangnam', 0.1), arrival: olderArrival },
        { candidate: cand('chungmuro', 0.3), arrival: newerArrival },
      ]);
      expect(result?.result.station.id).toBe(MOCK_STATIONS.chungmuro.id);
      expect(result?.confidence).toBe('arrival-confirmed');
    });

    it('score + freshness 모두 동률 → 거리 가까운(첫) 후보 유지 (결정론)', () => {
      const result = pickFusedStation([
        { candidate: cand('gangnam', 0.1), arrival: arrival(ARRIVAL_CODE.ARRIVED) },
        { candidate: cand('chungmuro', 0.3), arrival: arrival(ARRIVAL_CODE.ARRIVED) },
      ]);
      expect(result?.result.station.id).toBe(MOCK_STATIONS.gangnam.id);
    });

    it('arrival up/down 중 더 최근 신호의 receivedAtMs가 freshness가 된다', () => {
      // gangnam: up=오래된 ARRIVED, down=최근 ARRIVED → freshness = down.receivedAtMs.
      // chungmuro: 중간 ARRIVED 단일 → gangnam(down)이 더 최근 → gangnam 선택.
      const gangnamMixed: StationArrival = {
        up: [info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: NOW - 60_000 })],
        down: [info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: NOW })],
      };
      const chungmuroMid: StationArrival = {
        up: [info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: NOW - 30_000 })],
        down: [],
      };
      const result = pickFusedStation([
        { candidate: cand('chungmuro', 0.1), arrival: chungmuroMid },
        { candidate: cand('gangnam', 0.3), arrival: gangnamMixed },
      ]);
      expect(result?.result.station.id).toBe(MOCK_STATIONS.gangnam.id);
    });

    it('position 신호도 동일 tier + score 동률 시 freshness 비교', () => {
      const result = pickFusedStation([
        { candidate: cand('gangnam', 0.1), positionMatches: [train(1, NOW - 60_000)] },
        { candidate: cand('chungmuro', 0.3), positionMatches: [train(1, NOW)] },
      ]);
      expect(result?.result.station.id).toBe(MOCK_STATIONS.chungmuro.id);
      expect(result?.source).toBe('position');
    });

    it('source 라벨: 같은 후보 내 pos/arr score 동률 + freshness 차이 → 더 최근 신호의 source 라벨', () => {
      // 같은 후보에 arrival ARRIVED(최근) + position ARRIVED(오래됨) → score 동률.
      // 기본은 position이 우선이지만, freshness가 arrival이 더 최근이라 arrival 라벨이 되어야 함.
      const recentArrival: StationArrival = {
        up: [info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: NOW })],
        down: [],
      };
      const result = pickFusedStation([
        {
          candidate: cand('gangnam', 0.1),
          arrival: recentArrival,
          positionMatches: [train(1, NOW - 60_000)],
        },
      ]);
      expect(result?.source).toBe('arrival');
      expect(result?.confidence).toBe('arrival-confirmed');
    });

    it('source 라벨: 같은 후보 내 pos/arr score 동률 + position freshness가 더 큼 → position 라벨', () => {
      // 대칭 케이스 — position이 더 최근.
      const olderArrival: StationArrival = {
        up: [info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: NOW - 60_000 })],
        down: [],
      };
      const result = pickFusedStation([
        {
          candidate: cand('gangnam', 0.1),
          arrival: olderArrival,
          positionMatches: [train(1, NOW)],
        },
      ]);
      expect(result?.source).toBe('position');
    });

    it('source 라벨: 같은 후보 내 score + freshness 모두 동률 → tier 표 순서(position 우선)', () => {
      // 동일 receivedAtMs → 기존 tier 동작 유지(position 우선).
      const result = pickFusedStation([
        {
          candidate: cand('gangnam', 0.1),
          arrival: arrival(ARRIVAL_CODE.ARRIVED),
          positionMatches: [train(1, NOW)],
        },
      ]);
      expect(result?.source).toBe('position');
    });

    it('한 후보 내 같은 점수의 position 트레인 여러 개 → 더 최근 receivedAtMs가 freshness', () => {
      // 두 후보 모두 ARRIVED 점수 100. gangnam 후보의 두 번째 트레인이 chungmuro보다 더 최근.
      // → gangnam의 freshness가 max(older, newer)=newer로 잡혀 chungmuro보다 우선.
      const result = pickFusedStation([
        {
          candidate: cand('chungmuro', 0.1),
          positionMatches: [train(1, NOW - 30_000)],
        },
        {
          candidate: cand('gangnam', 0.3),
          positionMatches: [train(1, NOW - 60_000), train(1, NOW)],
        },
      ]);
      expect(result?.result.station.id).toBe(MOCK_STATIONS.gangnam.id);
    });

    it('한 후보 내 같은 점수의 arrival info 여러 개 → 더 최근 receivedAtMs가 freshness', () => {
      // arrival 동일 score, 두 번째 info가 더 신선해 freshness 갱신.
      const gangnamMulti: StationArrival = {
        up: [
          info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: NOW - 60_000 }),
          info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: NOW }),
        ],
        down: [],
      };
      const chungmuroOlder: StationArrival = {
        up: [info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: NOW - 30_000 })],
        down: [],
      };
      const result = pickFusedStation([
        { candidate: cand('chungmuro', 0.1), arrival: chungmuroOlder },
        { candidate: cand('gangnam', 0.3), arrival: gangnamMulti },
      ]);
      expect(result?.result.station.id).toBe(MOCK_STATIONS.gangnam.id);
    });

    it('한 후보가 명확히 더 높은 score면 freshness 무관하게 채택', () => {
      // gangnam: ENTERING(낮은 점수) but 최근. chungmuro: ARRIVED(높은 점수) but 오래됨.
      const result = pickFusedStation([
        { candidate: cand('gangnam', 0.1), arrival: arrival(ARRIVAL_CODE.ENTERING) },
        {
          candidate: cand('chungmuro', 0.3),
          arrival: { up: [info(ARRIVAL_CODE.ARRIVED, { receivedAtMs: NOW - 120_000 })], down: [] },
        },
      ]);
      expect(result?.result.station.id).toBe(MOCK_STATIONS.chungmuro.id);
    });
  });
});
