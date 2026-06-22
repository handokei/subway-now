/**
 * #1604 — Backend Dijkstra adapter unit tests.
 *
 * 알고리즘 본체(graph build / dijkstra / route reconstruction)는 shared 모듈
 * (`src/shared/utils/dijkstraRoute.ts`, `src/shared/utils/buildRouteGraph.ts`)에서 검증.
 * 본 파일은 backend adapter (`findStationIdByNameAndLine` + `inferWaypointsFromOriginAndDestination`)
 * 만 검증한다.
 *
 * 검증 시나리오 (이슈 본문 acceptance 1:1 매핑):
 *  - 직선 trip (환승 X)               : 같은 노선 양방향 (용마산→어린이대공원)
 *  - 환승 1회                          : 7호선 용마산 → 2호선 성수
 *  - 환승 2회+                         : 1호선 신도림 → 7호선 어린이대공원
 *  - 동일역(degenerate)                : null 반환
 *  - origin/destination 미해소         : null 반환
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  findStationIdByNameAndLine,
  inferWaypointsFromOriginAndDestination,
  __resetStationNameCache,
} from '../dijkstraRoute';

describe('#1604 backend Dijkstra adapter', () => {
  beforeEach(() => {
    __resetStationNameCache();
  });

  describe('findStationIdByNameAndLine', () => {
    it('정상 매치 — 7호선 용마산', () => {
      expect(findStationIdByNameAndLine('용마산', '7')).toBe('7-015');
    });

    it('정상 매치 — 2호선 성수', () => {
      expect(findStationIdByNameAndLine('성수', '2')).toBe('2-011');
    });

    it('미존재 역명 → null', () => {
      expect(findStationIdByNameAndLine('존재하지않는역', '2')).toBeNull();
    });

    it('잘못된 line → null', () => {
      // 성수는 2호선만 있음. 99호선은 graph에 없음.
      expect(findStationIdByNameAndLine('성수', '99')).toBeNull();
    });
  });

  describe('inferWaypointsFromOriginAndDestination — 직선 trip', () => {
    it('7호선 용마산 → 어린이대공원(세종대): 중간역 intermediate + 끝 destination', () => {
      const waypoints = inferWaypointsFromOriginAndDestination({
        originName: '용마산',
        originLine: '7',
        destinationId: '7-018',
        destinationName: '어린이대공원(세종대)',
      });
      expect(waypoints).not.toBeNull();
      // 7-015 → 7-016 → 7-017 → 7-018: 출발역 제외 3개 waypoint (intermediate × 2 + destination).
      expect(waypoints!.length).toBeGreaterThanOrEqual(2);
      const last = waypoints!.at(-1)!;
      expect(last.kind).toBe('destination');
      expect(last.stationName).toBe('어린이대공원(세종대)');
      expect(last.line).toBe('7');
      // 모든 intermediate은 7호선
      for (let i = 0; i < waypoints!.length - 1; i += 1) {
        expect(waypoints![i].kind).toBe('intermediate');
        expect(waypoints![i].line).toBe('7');
      }
    });

    it('역방향(어린이대공원 → 용마산) — 같은 leg 길이', () => {
      const forward = inferWaypointsFromOriginAndDestination({
        originName: '용마산',
        originLine: '7',
        destinationId: '7-018',
        destinationName: '어린이대공원(세종대)',
      });
      const backward = inferWaypointsFromOriginAndDestination({
        originName: '어린이대공원(세종대)',
        originLine: '7',
        destinationId: '7-015',
        destinationName: '용마산',
      });
      expect(forward).not.toBeNull();
      expect(backward).not.toBeNull();
      expect(forward!.length).toBe(backward!.length);
      expect(backward!.at(-1)!.stationName).toBe('용마산');
    });
  });

  describe('inferWaypointsFromOriginAndDestination — 환승 1회', () => {
    it('7호선 용마산 → 2호선 성수: transfer 1개 + destination 1개', () => {
      const waypoints = inferWaypointsFromOriginAndDestination({
        originName: '용마산',
        originLine: '7',
        destinationId: '2-011',
        destinationName: '성수',
      });
      expect(waypoints).not.toBeNull();
      const transferCount = waypoints!.filter((w) => w.kind === 'transfer').length;
      const destinationCount = waypoints!.filter((w) => w.kind === 'destination').length;
      expect(transferCount).toBe(1);
      expect(destinationCount).toBe(1);
      // 마지막은 destination, line=2
      const last = waypoints!.at(-1)!;
      expect(last.kind).toBe('destination');
      expect(last.stationName).toBe('성수');
      expect(last.line).toBe('2');
      // 환승 waypoint의 line은 fromLine (7)
      const transferWp = waypoints!.find((w) => w.kind === 'transfer');
      expect(transferWp).toBeDefined();
      expect(transferWp!.line).toBe('7');
    });
  });

  describe('inferWaypointsFromOriginAndDestination — 환승 2회+', () => {
    it('1호선 신도림 → 7호선 어린이대공원: transfer ≥ 1, destination 1', () => {
      const waypoints = inferWaypointsFromOriginAndDestination({
        originName: '신도림',
        originLine: '1',
        destinationId: '7-018',
        destinationName: '어린이대공원(세종대)',
      });
      expect(waypoints).not.toBeNull();
      const transferCount = waypoints!.filter((w) => w.kind === 'transfer').length;
      const destinationCount = waypoints!.filter((w) => w.kind === 'destination').length;
      expect(transferCount).toBeGreaterThanOrEqual(1);
      expect(destinationCount).toBe(1);
      expect(waypoints!.at(-1)!.stationName).toBe('어린이대공원(세종대)');
    });
  });

  describe('inferWaypointsFromOriginAndDestination — degenerate / invalid', () => {
    it('origin 미해소 → null', () => {
      expect(
        inferWaypointsFromOriginAndDestination({
          originName: '존재안함',
          originLine: '7',
          destinationId: '2-011',
          destinationName: '성수',
        }),
      ).toBeNull();
    });

    it('destination station id 미해소 → null', () => {
      expect(
        inferWaypointsFromOriginAndDestination({
          originName: '용마산',
          originLine: '7',
          destinationId: 'not-a-station',
          destinationName: '성수',
        }),
      ).toBeNull();
    });

    it('동일역 (degenerate) → null', () => {
      expect(
        inferWaypointsFromOriginAndDestination({
          originName: '성수',
          originLine: '2',
          destinationId: '2-011',
          destinationName: '성수',
        }),
      ).toBeNull();
    });
  });

  describe('stationName cache', () => {
    it('두 번째 호출은 캐시된 lookup 반환 (동일 결과)', () => {
      const first = inferWaypointsFromOriginAndDestination({
        originName: '용마산',
        originLine: '7',
        destinationId: '7-018',
        destinationName: '어린이대공원(세종대)',
      });
      const second = inferWaypointsFromOriginAndDestination({
        originName: '용마산',
        originLine: '7',
        destinationId: '7-018',
        destinationName: '어린이대공원(세종대)',
      });
      expect(first).toEqual(second);
    });
  });
});
