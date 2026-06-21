/**
 * #1604 (#1610) — backend Dijkstra waypoint adapter unit tests.
 *
 * 검증 시나리오 (이슈 #1604 acceptance 1:1 매핑):
 *  - graph 빌드 (shared 모듈 로드)
 *  - findStationIdByNameAndLine — 정상/미매치
 *  - inferredRouteToWaypoints — 직선/환승1/환승2+
 *  - inferWaypointsFromOriginAndDestination — end-to-end 정상/origin 미해소/destination 미해소/동일역
 *  - graph stats 노출
 *
 * shared 모듈은 별 unit test 보유 — 본 파일은 backend adapter 책임만 검증.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  findStationIdByNameAndLine,
  getRouteGraphStats,
  inferredRouteToWaypoints,
  inferWaypointsFromOriginAndDestination,
} from '../dijkstraWaypointAdapter';
import {
  __resetRouteGraphCache,
} from '../../../../src/shared/utils/buildRouteGraph';
import { findRouteByType } from '../../../../src/shared/utils/dijkstraRoute';

describe('#1604 backend Dijkstra waypoint adapter', () => {
  beforeEach(() => {
    __resetRouteGraphCache();
  });

  describe('graph build', () => {
    it('500+ station 노드 로드 (shared 그래프)', () => {
      const stats = getRouteGraphStats();
      // stations.json 변경에 깨지지 않도록 하한만 검증.
      expect(stats.nodeCount).toBeGreaterThanOrEqual(500);
      expect(stats.lineEdgeCount).toBeGreaterThan(0);
      expect(stats.transferEdgeCount).toBeGreaterThan(0);
    });

    it('두 번째 호출은 캐시된 그래프 반환 (stats 동일)', () => {
      const s1 = getRouteGraphStats();
      const s2 = getRouteGraphStats();
      expect(s1).toEqual(s2);
    });
  });

  describe('findStationIdByNameAndLine', () => {
    it('정상 매치 — 성수/2호선', () => {
      expect(findStationIdByNameAndLine('성수', '2')).toBe('2-011');
    });

    it('정상 매치 — 용마산/7호선', () => {
      expect(findStationIdByNameAndLine('용마산', '7')).toBe('7-015');
    });

    it('미매치 (존재 안 함 역) — null', () => {
      expect(findStationIdByNameAndLine('존재하지않는역', '2')).toBeNull();
    });

    it('미매치 (존재 안 함 line) — null', () => {
      // backend LineNumber=string이라 unknown 값도 graceful — node 순회 시 미매치.
      expect(findStationIdByNameAndLine('성수', '99')).toBeNull();
    });
  });

  describe('inferredRouteToWaypoints — 직선 trip', () => {
    it('중간역은 intermediate, 마지막은 destination (7-015 → 7-018)', () => {
      const route = findRouteByType('7-015', '7-018', 'min-time');
      expect(route).not.toBeNull();
      const waypoints = inferredRouteToWaypoints(route!, '어린이대공원(세종대)');
      // 7-015 → 7-016 → 7-017 → 7-018: 출발역 제외 3개 waypoint (intermediate × 2 + destination).
      expect(waypoints.length).toBeGreaterThanOrEqual(2);
      const last = waypoints[waypoints.length - 1];
      expect(last.kind).toBe('destination');
      expect(last.stationName).toBe('어린이대공원(세종대)');
      expect(last.line).toBe('7');
      // intermediate들은 모두 line 7
      for (let i = 0; i < waypoints.length - 1; i += 1) {
        expect(waypoints[i].kind).toBe('intermediate');
        expect(waypoints[i].line).toBe('7');
      }
    });
  });

  describe('inferredRouteToWaypoints — 환승 1회', () => {
    it('transfer kind 1개, destination 1개 (7→2호선)', () => {
      const route = findRouteByType('7-015', '2-011', 'min-time');
      expect(route).not.toBeNull();
      const waypoints = inferredRouteToWaypoints(route!, '성수');
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
  });

  describe('inferredRouteToWaypoints — 환승 2회+', () => {
    it('transfer kind ≥ 1, destination 1개 (1호선 → 7호선)', () => {
      const route = findRouteByType('1-041', '7-018', 'min-time');
      expect(route).not.toBeNull();
      const waypoints = inferredRouteToWaypoints(route!, '어린이대공원(세종대)');
      const transferCount = waypoints.filter((w) => w.kind === 'transfer').length;
      const destinationCount = waypoints.filter((w) => w.kind === 'destination').length;
      expect(transferCount).toBeGreaterThanOrEqual(1);
      expect(destinationCount).toBe(1);
      expect(waypoints[waypoints.length - 1].stationName).toBe('어린이대공원(세종대)');
    });
  });

  describe('inferredRouteToWaypoints — 동일역 (degenerate route)', () => {
    it('legs/transfers 둘 다 빈 배열 → waypoints 빈 배열', () => {
      const route = findRouteByType('2-011', '2-011', 'min-time');
      expect(route).not.toBeNull();
      const waypoints = inferredRouteToWaypoints(route!, '성수');
      expect(waypoints.length).toBe(0);
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

    it('환승 2회+ — multi-transfer (신도림 → 어린이대공원)', () => {
      const waypoints = inferWaypointsFromOriginAndDestination({
        originName: '신도림',
        originLine: '1',
        destinationId: '7-018',
        destinationName: '어린이대공원(세종대)',
      });
      expect(waypoints).not.toBeNull();
      expect(waypoints![waypoints!.length - 1].stationName).toBe('어린이대공원(세종대)');
    });

    it('역방향 — 어린이대공원 → 용마산 (같은 노선 양방향)', () => {
      const waypoints = inferWaypointsFromOriginAndDestination({
        originName: '어린이대공원(세종대)',
        originLine: '7',
        destinationId: '7-015',
        destinationName: '용마산',
      });
      expect(waypoints).not.toBeNull();
      expect(waypoints![waypoints!.length - 1].stationName).toBe('용마산');
      expect(waypoints![waypoints!.length - 1].line).toBe('7');
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
});
