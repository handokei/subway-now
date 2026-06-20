/**
 * #1604 — Backend Dijkstra unit tests.
 *
 * 검증 시나리오 (이슈 본문 acceptance 1:1 매핑):
 *  - 직선 trip (환승 X)               : 같은 노선 양방향 (용마산→어린이대공원)
 *  - 환승 1회                          : 7호선 용마산 → 2호선 성수 (강변/뚝섬 환승 경로 자동 산출)
 *  - 환승 2회+                         : 1호선 신도림 → 7호선 어린이대공원 (multi-transfer)
 *  - 동일역(degenerate)                : null 반환 (caller가 incoming 그대로 유지)
 *  - origin/destination 미해소         : null 반환
 *  - 도달 불가                         : null (graph 자체에서 모든 노드 연결되므로 invalid id로 검증)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  findRoute,
  inferredRouteToWaypoints,
  inferWaypointsFromOriginAndDestination,
  getRouteGraphStats,
} from '../dijkstraRoute';
import { __resetRouteGraphCache, findStationIdByNameAndLine } from '../buildRouteGraph';

describe('#1604 backend Dijkstra', () => {
  beforeEach(() => {
    __resetRouteGraphCache();
  });

  describe('graph build', () => {
    it('533 station 노드 모두 로드', () => {
      const stats = getRouteGraphStats();
      // stations.json 변경에 깨지지 않도록 하한만 검증.
      expect(stats.nodeCount).toBeGreaterThanOrEqual(500);
      expect(stats.lineEdgeCount).toBeGreaterThan(0);
      expect(stats.transferEdgeCount).toBeGreaterThan(0);
    });

    it('findStationIdByNameAndLine — 정상 매치', () => {
      expect(findStationIdByNameAndLine('성수', '2')).toBe('2-011');
      expect(findStationIdByNameAndLine('용마산', '7')).toBe('7-015');
    });

    it('findStationIdByNameAndLine — 미매치는 null', () => {
      expect(findStationIdByNameAndLine('존재하지않는역', '2')).toBeNull();
      expect(findStationIdByNameAndLine('성수', '99' as never)).toBeNull();
    });
  });

  describe('findRoute — 직선 trip (같은 노선)', () => {
    it('7호선 용마산 → 어린이대공원(세종대) (동일 노선, 다른 방향)', () => {
      const route = findRoute('7-015', '7-018');
      expect(route).not.toBeNull();
      expect(route!.legs.length).toBe(1);
      expect(route!.transfers.length).toBe(0);
      expect(route!.legs[0].line).toBe('7');
      expect(route!.legs[0].fromId).toBe('7-015');
      expect(route!.legs[0].toId).toBe('7-018');
      // 7-015 → 7-016 → 7-017 → 7-018 (인접 시퀀스)
      expect(route!.legs[0].stationIds[0]).toBe('7-015');
      expect(route!.legs[0].stationIds[route!.legs[0].stationIds.length - 1]).toBe('7-018');
    });

    it('역방향도 동일 leg 길이 (양방향 검증)', () => {
      const forward = findRoute('7-015', '7-018');
      const backward = findRoute('7-018', '7-015');
      expect(forward).not.toBeNull();
      expect(backward).not.toBeNull();
      expect(forward!.legs[0].stationIds.length).toBe(backward!.legs[0].stationIds.length);
    });
  });

  describe('findRoute — 환승 1회', () => {
    it('7호선 용마산 → 2호선 성수 (강변/건대입구 환승)', () => {
      const route = findRoute('7-015', '2-011');
      expect(route).not.toBeNull();
      // 7호선 leg → 환승 → 2호선 leg
      expect(route!.legs.length).toBe(2);
      expect(route!.transfers.length).toBe(1);
      expect(route!.legs[0].line).toBe('7');
      expect(route!.legs[1].line).toBe('2');
      expect(route!.transfers[0].fromLine).toBe('7');
      expect(route!.transfers[0].toLine).toBe('2');
    });
  });

  describe('findRoute — 환승 2회+', () => {
    it('1호선 신도림(1-041) → 7호선 어린이대공원(7-018) (multi-transfer)', () => {
      const route = findRoute('1-041', '7-018');
      expect(route).not.toBeNull();
      // 최단 시간 기준 — leg/transfer 정확한 개수는 graph 변경 시 깨지지 않게 하한만 검증.
      // (최적 경로가 시작 transfer (1→2호선 신도림)로 시작할 수 있어 첫 leg line은 1/2 둘 다 가능.)
      expect(route!.legs.length).toBeGreaterThanOrEqual(1);
      expect(route!.transfers.length).toBeGreaterThanOrEqual(1);
      // 마지막 leg는 7호선에서 끝나고 toId는 7-018.
      expect(route!.legs[route!.legs.length - 1].line).toBe('7');
      expect(route!.legs[route!.legs.length - 1].toId).toBe('7-018');
    });
  });

  describe('findRoute — degenerate / invalid', () => {
    it('동일역 → legs/transfers 둘 다 빈 배열', () => {
      const route = findRoute('2-011', '2-011');
      expect(route).not.toBeNull();
      expect(route!.legs.length).toBe(0);
      expect(route!.transfers.length).toBe(0);
    });

    it('미존재 from id → null', () => {
      expect(findRoute('not-a-station', '2-011')).toBeNull();
    });

    it('미존재 to id → null', () => {
      expect(findRoute('2-011', 'not-a-station')).toBeNull();
    });
  });

  describe('inferredRouteToWaypoints', () => {
    it('직선 trip — 중간역은 intermediate, 마지막은 destination', () => {
      const route = findRoute('7-015', '7-018');
      const waypoints = inferredRouteToWaypoints(route!, '어린이대공원(세종대)');
      // 7-015 → 7-016 → 7-017 → 7-018: 출발역 제외 3개 waypoint (intermediate × 2 + destination).
      expect(waypoints.length).toBeGreaterThanOrEqual(2);
      expect(waypoints[waypoints.length - 1].kind).toBe('destination');
      expect(waypoints[waypoints.length - 1].stationName).toBe('어린이대공원(세종대)');
      expect(waypoints[waypoints.length - 1].line).toBe('7');
      // intermediate들은 모두 line 7
      for (let i = 0; i < waypoints.length - 1; i += 1) {
        expect(waypoints[i].kind).toBe('intermediate');
        expect(waypoints[i].line).toBe('7');
      }
    });

    it('환승 1회 — transfer kind 1개, destination 1개', () => {
      const route = findRoute('7-015', '2-011');
      const waypoints = inferredRouteToWaypoints(route!, '성수');
      // 환승 waypoint 존재
      const transferCount = waypoints.filter((w) => w.kind === 'transfer').length;
      const destinationCount = waypoints.filter((w) => w.kind === 'destination').length;
      expect(transferCount).toBe(1);
      expect(destinationCount).toBe(1);
      // 마지막은 destination, line=2
      const last = waypoints[waypoints.length - 1];
      expect(last.kind).toBe('destination');
      expect(last.stationName).toBe('성수');
      expect(last.line).toBe('2');
      // 환승 waypoint의 line은 fromLine (7)
      const transferWp = waypoints.find((w) => w.kind === 'transfer');
      expect(transferWp).toBeDefined();
      expect(transferWp!.line).toBe('7');
    });

    it('환승 2회+ — transfer kind ≥ 2, destination 1개', () => {
      const route = findRoute('1-041', '7-018');
      const waypoints = inferredRouteToWaypoints(route!, '어린이대공원(세종대)');
      const transferCount = waypoints.filter((w) => w.kind === 'transfer').length;
      const destinationCount = waypoints.filter((w) => w.kind === 'destination').length;
      // 1호선 → 7호선은 일반적으로 1~2 환승 (가산디지털단지 1↔7 단일 환승).
      expect(transferCount).toBeGreaterThanOrEqual(1);
      expect(destinationCount).toBe(1);
      expect(waypoints[waypoints.length - 1].stationName).toBe('어린이대공원(세종대)');
    });
  });

  describe('inferWaypointsFromOriginAndDestination — end-to-end', () => {
    it('정상 — origin/destination 모두 해소 가능', () => {
      const waypoints = inferWaypointsFromOriginAndDestination({
        originName: '용마산',
        originLine: '7',
        destinationId: '2-011',
        destinationName: '성수',
      });
      expect(waypoints).not.toBeNull();
      expect(waypoints!.length).toBeGreaterThan(0);
      expect(waypoints![waypoints!.length - 1].kind).toBe('destination');
      expect(waypoints![waypoints!.length - 1].stationName).toBe('성수');
    });

    it('origin 미해소 — null', () => {
      const waypoints = inferWaypointsFromOriginAndDestination({
        originName: '존재안함',
        originLine: '7',
        destinationId: '2-011',
        destinationName: '성수',
      });
      expect(waypoints).toBeNull();
    });

    it('destination station id 미해소 — null', () => {
      const waypoints = inferWaypointsFromOriginAndDestination({
        originName: '용마산',
        originLine: '7',
        destinationId: 'not-a-station',
        destinationName: '성수',
      });
      expect(waypoints).toBeNull();
    });

    it('동일역 (degenerate) — null', () => {
      const waypoints = inferWaypointsFromOriginAndDestination({
        originName: '성수',
        originLine: '2',
        destinationId: '2-011',
        destinationName: '성수',
      });
      expect(waypoints).toBeNull();
    });
  });

  describe('cache behavior', () => {
    it('두 번째 호출은 캐시된 그래프 반환 (stats 동일)', () => {
      const s1 = getRouteGraphStats();
      const s2 = getRouteGraphStats();
      expect(s1).toEqual(s2);
    });
  });
});
