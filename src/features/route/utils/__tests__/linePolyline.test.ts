import {
  MAX_SNAP_DISTANCE_M,
  __resetLinePolylineCacheForTests,
  getLinePolyline,
  mapMatchedSpeedKmh,
  snapToLinePolyline,
} from '../linePolyline';
import { getStationsOnLine } from '../stationRoute';
import type { LineNumber } from '../../../../shared/types/station';

describe('linePolyline', () => {
  beforeEach(() => {
    __resetLinePolylineCacheForTests();
  });

  describe('getLinePolyline', () => {
    it('호선의 정거장 시퀀스와 누적 길이 테이블을 빌드한다', () => {
      const polyline = getLinePolyline('2');
      expect(polyline.line).toBe('2');
      expect(polyline.stations.length).toBeGreaterThan(2);
      expect(polyline.segmentLengthsM.length).toBe(polyline.stations.length - 1);
      expect(polyline.cumulativeArcM.length).toBe(polyline.stations.length);
      expect(polyline.cumulativeArcM[0]).toBe(0);
      expect(polyline.cumulativeArcM[polyline.cumulativeArcM.length - 1]).toBeCloseTo(
        polyline.totalLengthM,
        5,
      );
    });

    it('동일 호선 두 번 요청 시 캐시된 동일 객체를 반환한다', () => {
      const first = getLinePolyline('3');
      const second = getLinePolyline('3');
      expect(first).toBe(second);
    });
  });

  describe('snapToLinePolyline — 단일 segment', () => {
    // 1호선 신도림(37.508787, 126.891144) → 구로(서쪽). 둘 사이 중간점은 polyline 위.
    it('두 정거장 사이 중간점은 progress≈0.5로 snap된다', () => {
      const stations = getStationsOnLine('1');
      const sindorim = stations.find((s) => s.id === '1-041');
      const guro = stations.find((s) => s.id === '1-042');
      if (!sindorim || !guro) throw new Error('fixture missing');
      const midLat = (sindorim.lat + guro.lat) / 2;
      const midLng = (sindorim.lng + guro.lng) / 2;

      const result = snapToLinePolyline({ lat: midLat, lng: midLng }, '1');
      expect(result.matched).toBe(true);
      if (!result.matched) return;
      expect(result.segmentStartId).toBe('1-041');
      expect(result.segmentEndId).toBe('1-042');
      expect(result.progress).toBeGreaterThan(0.4);
      expect(result.progress).toBeLessThan(0.6);
      expect(result.snapDistanceM).toBeLessThan(1);
    });

    it('정거장 좌표 정확히 일치 시 progress=0 또는 1로 snap된다', () => {
      const result = snapToLinePolyline({ lat: 37.508787, lng: 126.891144 }, '1');
      expect(result.matched).toBe(true);
      if (!result.matched) return;
      // 신도림은 1-041, 인접 segment 의 한 끝점.
      expect([result.segmentStartId, result.segmentEndId]).toContain('1-041');
      expect(result.snapDistanceM).toBeLessThan(0.1);
    });
  });

  describe('snapToLinePolyline — 50m 경계', () => {
    // 신도림(37.508787, 126.891144). 위도 1° ≒ 111320m.
    // 약 40m 북쪽 = lat + 40 / 111320 ≈ 0.000359
    it('수직거리 약 40m는 matched', () => {
      const result = snapToLinePolyline(
        { lat: 37.508787 + 40 / 111_320, lng: 126.891144 },
        '1',
      );
      expect(result.matched).toBe(true);
      if (!result.matched) return;
      expect(result.snapDistanceM).toBeGreaterThan(35);
      expect(result.snapDistanceM).toBeLessThan(45);
    });

    it('수직거리 약 60m는 unmatched (50m 상한 초과)', () => {
      // 신도림(1호선)에서 정북 60m. 1호선은 신도림 양쪽이 영등포(NE)/구로(SW)라
      // 정북 60m는 polyline 어느 segment 와도 60m 이상 떨어진다.
      const result = snapToLinePolyline(
        { lat: 37.508787 + 60 / 111_320, lng: 126.891144 },
        '1',
      );
      expect(result.matched).toBe(false);
    });

    it('MAX_SNAP_DISTANCE_M 가 노출돼 호출자가 임계값을 알 수 있다', () => {
      expect(MAX_SNAP_DISTANCE_M).toBe(50);
    });
  });

  describe('snapToLinePolyline — 환승역 disambiguate', () => {
    /**
     * 같은 이름의 환승역도 노선마다 polyline 방향이 다르다.
     * 좌표가 한 노선 polyline에 훨씬 가까우면 그 노선으로 snap이 이긴다.
     * 본 테스트는 fusion이 어떤 line으로 잠글지 호출자가 결정할 수 있는 신호를 제공함을 검증.
     */
    it.each<{ name: string; coord: { lat: number; lng: number }; winner: LineNumber; loser: LineNumber }>([
      {
        // 신도림: 1호선은 영등포(NE)→신도림→구로(SW) 가로 방향, 2호선은 신도림→문래(N) 세로 방향.
        // 신도림에서 정확히 문래 방향(약간 N+E) 좌표 → 2호선이 가까움.
        name: '신도림 1 vs 2 — 문래 방향(2호선)',
        coord: { lat: 37.5104, lng: 126.8915 },
        winner: '2',
        loser: '1',
      },
      {
        // 군자: 5호선은 장한평(NW)→군자→아차산(SE), 7호선은 어린이대공원(SW)→군자→뚝섬유원지(SE).
        // 어린이대공원(37.548014, 127.074658)~군자(37.556897, 127.079338) 사이 중간점은
        // 7호선 polyline 위, 5호선 segment 어느 쪽과도 떨어진다.
        name: '군자 5 vs 7 — 어린이대공원-군자 segment 중간점(7호선)',
        coord: { lat: 37.5525, lng: 127.077 },
        winner: '7',
        loser: '5',
      },
      {
        // 건대입구: 2호선은 건대입구→구의(E), 7호선은 어린이대공원(NW)→건대입구→뚝섬유원지(SW).
        // 건대입구(37.540373, 127.069191)~구의(37.537077, 127.085916) 사이 중간점은
        // 2호선 polyline 위, 7호선 segment 어느 쪽과도 떨어진다.
        name: '건대입구 2 vs 7 — 건대입구-구의 segment 중간점(2호선)',
        coord: { lat: 37.5387, lng: 127.0775 },
        winner: '2',
        loser: '7',
      },
    ])('$name', ({ coord, winner, loser }) => {
      const winResult = snapToLinePolyline(coord, winner);
      const loseResult = snapToLinePolyline(coord, loser);
      expect(winResult.matched).toBe(true);
      if (!winResult.matched) return;
      if (loseResult.matched) {
        expect(winResult.snapDistanceM).toBeLessThan(loseResult.snapDistanceM);
      }
      // 어느 경우든 winning line의 snap은 충분히 가까워야 함.
      expect(winResult.snapDistanceM).toBeLessThan(MAX_SNAP_DISTANCE_M);
    });
  });

  describe('snapToLinePolyline — 비매칭', () => {
    it('서울 외 좌표(부산 해운대 등)는 unmatched', () => {
      const result = snapToLinePolyline({ lat: 35.1631, lng: 129.1635 }, '2');
      expect(result.matched).toBe(false);
    });

    it('지하철 노선에서 멀리 떨어진 도시 내 좌표는 unmatched', () => {
      // 한강 한가운데 (37.520, 126.97 부근). 어떤 노선 polyline 과도 50m 안에 들지 않는 좌표.
      const result = snapToLinePolyline({ lat: 37.521, lng: 126.965 }, '2');
      expect(result.matched).toBe(false);
    });
  });

  describe('snapToLinePolyline — 전 노선 fixture', () => {
    // 데이터 주도: 어떤 노선을 추가해도 같은 동작을 보장한다.
    const lines: LineNumber[] = [
      '1', '2', '3', '4', '5', '6', '7', '8', '9',
      'airport', 'bundang', 'gyeongui', 'sinbundang',
    ];

    it.each(lines)('노선 %s — 첫 segment 중간점이 matched + 첫 두 정거장으로 snap', (line) => {
      const stations = getStationsOnLine(line);
      expect(stations.length).toBeGreaterThanOrEqual(2);
      const a = stations[0];
      const b = stations[1];
      const midLat = (a.lat + b.lat) / 2;
      const midLng = (a.lng + b.lng) / 2;
      const result = snapToLinePolyline({ lat: midLat, lng: midLng }, line);
      expect(result.matched).toBe(true);
      if (!result.matched) return;
      expect(result.line).toBe(line);
      expect(result.snapDistanceM).toBeLessThan(MAX_SNAP_DISTANCE_M);
      // 첫 segment 의 중점이 첫/두 번째 정거장 segment 로 snap되거나,
      // 인접 segment 가 더 가까운 경우 그 segment 로도 가능. 어느 쪽이든 첫 두 정거장 중 하나는 포함.
      const ids = [result.segmentStartId, result.segmentEndId];
      const hit = ids.includes(a.id) || ids.includes(b.id);
      expect(hit).toBe(true);
    });
  });

  describe('mapMatchedSpeedKmh', () => {
    it('지하철 평균 속도(30~50km/h) 범위를 정확히 환산한다', () => {
      // 1000m / 90s ≈ 11.1 m/s ≈ 40 km/h.
      const kmh = mapMatchedSpeedKmh(
        { line: '2', arcM: 1000 },
        { line: '2', arcM: 2000 },
        90,
      );
      expect(kmh).not.toBeNull();
      if (kmh === null) return;
      expect(kmh).toBeGreaterThan(35);
      expect(kmh).toBeLessThan(45);
    });

    it('역방향 진행도 동일 속도로 계산된다', () => {
      const forward = mapMatchedSpeedKmh(
        { line: '2', arcM: 1000 },
        { line: '2', arcM: 2000 },
        90,
      );
      const backward = mapMatchedSpeedKmh(
        { line: '2', arcM: 2000 },
        { line: '2', arcM: 1000 },
        90,
      );
      expect(forward).not.toBeNull();
      expect(backward).not.toBeNull();
      if (forward === null || backward === null) return;
      expect(forward).toBeCloseTo(backward, 5);
    });

    it('다른 노선이면 null', () => {
      const kmh = mapMatchedSpeedKmh(
        { line: '2', arcM: 1000 },
        { line: '7', arcM: 2000 },
        90,
      );
      expect(kmh).toBeNull();
    });

    it('Δt가 0 이하면 null', () => {
      expect(
        mapMatchedSpeedKmh({ line: '2', arcM: 1000 }, { line: '2', arcM: 2000 }, 0),
      ).toBeNull();
      expect(
        mapMatchedSpeedKmh({ line: '2', arcM: 1000 }, { line: '2', arcM: 2000 }, -10),
      ).toBeNull();
    });

    it('Δarc=0(정지)이면 null', () => {
      const kmh = mapMatchedSpeedKmh(
        { line: '2', arcM: 1500 },
        { line: '2', arcM: 1500 },
        30,
      );
      expect(kmh).toBeNull();
    });

    it('segment 경계를 거쳐도 cumulativeArcM 차로 자연스럽게 누적된다', () => {
      const polyline = getLinePolyline('2');
      // 첫 두 segment 를 60초에 걸쳐 통과.
      const startArc = 0;
      const endArc = polyline.cumulativeArcM[2];
      const kmh = mapMatchedSpeedKmh(
        { line: '2', arcM: startArc },
        { line: '2', arcM: endArc },
        60,
      );
      expect(kmh).not.toBeNull();
      if (kmh === null) return;
      expect(kmh).toBeGreaterThan(0);
    });
  });
});
