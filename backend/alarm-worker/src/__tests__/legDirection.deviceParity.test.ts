/**
 * #3191 PR-2D — device fused 방향 필터와 backend lockless leg 방향 필터의 방향 일치(parity).
 *
 * device fused 역은 sync 관측역 입력이 되므로(HomeScreen → #3222) 같은 leg에서 둘 다 방향을 냈다면
 * 같은 방향이어야 한다. 한쪽만 null인 경우는 각자의 fail-closed가 자기 점수에만 작용하므로 위반이 아니다.
 *
 * 각 쪽의 production 함수로 상태를 구성한다:
 *   - device  = computeRouteArc + legDirectionByLine
 *   - backend = routeToWaypoints + Trip{originStationName, currentLegAnchor} + restrictArrivalsByLegDirection
 * 입력 route: trip 179 용마산(7)→건대입구→뚝섬(2), trip 180 성수(2)→건대입구→용마산(7) (D1 trip_metrics / RCA §0).
 */
import { describe, expect, it, vi } from 'vitest';
import { restrictArrivalsByLegDirection } from '../scheduled';
import type { Trip, Waypoint } from '../types';
import type { ArrivalEntry } from '../seoul';
import { computeRouteArc } from '../../../../src/features/route/utils/routeProgress';
import { legDirectionByLine } from '../../../../src/features/route/utils/tripDirection';
import { routeToWaypoints } from '../../../../src/features/route/utils/routeWaypoints';
import { findRoutes, findStationByNameAndLine } from '../../../../src/shared/utils/stationRoute';
import type { Station } from '../../../../src/shared/types/station';

// device logger는 Sentry breadcrumb(@sentry/react-native, flow 타입 소스)를 import해 node 환경에서 파싱이
// 안 된다. 방향 로직과 무관하므로 no-op logger로 대체한다(backend가 이미 쓰는 shared 모듈은 영향 없음).
vi.mock('../../../../src/shared/utils/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const UP = { trainCode: 'U', isUp: true } as unknown as ArrivalEntry;
const DOWN = { trainCode: 'D', isUp: false } as unknown as ArrivalEntry;

/** backend가 낸 방향. [] = null(fail-closed). */
function backendDirection(trip: Partial<Trip>, line: string, stationName: string): 'up' | 'down' | null {
  const out = restrictArrivalsByLegDirection(
    trip as Trip,
    { stationName, line, kind: 'intermediate' } as Waypoint,
    [UP, DOWN],
  );
  if (out.length === 0) return null;
  return out[0].isUp ? 'up' : 'down';
}

interface Case {
  name: string;
  origin: [string, Station['line']];
  dest: [string, Station['line']];
}
const CASES: Case[] = [
  { name: 'trip 179 용마산(7)→건대입구→뚝섬(2)', origin: ['용마산', '7'], dest: ['뚝섬', '2'] },
  { name: 'trip 180 성수(2)→건대입구→용마산(7)', origin: ['성수', '2'], dest: ['용마산', '7'] },
];

function build({ origin: [oName, oLine], dest: [dName, dLine] }: Case) {
  const origin = findStationByNameAndLine(oName, oLine)!;
  const destination = findStationByNameAndLine(dName, dLine)!;
  const [candidate] = findRoutes(origin.id, destination.id);
  const arc = computeRouteArc(candidate.route, origin, destination)!;
  const device = legDirectionByLine(arc.stations);
  const waypoints = routeToWaypoints(candidate.route, destination.name, origin);
  return { origin, destination, route: candidate.route, device, waypoints };
}

describe('device legDirectionByLine ↔ backend restrictArrivalsByLegDirection parity (#3191 PR-2D)', () => {
  for (const c of CASES) {
    it(`${c.name}: leg 1(앵커 전) / leg 2(환승 앵커 후) 모든 waypoint에서 둘 다 non-null이면 같은 방향`, () => {
      const { origin, route, device, waypoints } = build(c);
      expect(route.type).toBe('transfer');
      const transferName = (route as { transferName: string }).transferName;
      let compared = 0;
      for (const wp of waypoints) {
        const anchored = wp.line !== origin.line;
        const trip: Partial<Trip> = {
          originStationName: origin.name,
          ...(anchored ? { currentLegAnchor: { boardingStation: transferName, line: wp.line } } : {}),
        };
        const be = backendDirection(trip, wp.line, wp.stationName);
        const dev = device.get(wp.line as Station['line']);
        expect(dev).not.toBeUndefined();
        if (be !== null && dev !== null) {
          expect(be, `${wp.line} ${wp.stationName}`).toBe(dev);
          compared += 1;
        }
      }
      expect(compared).toBeGreaterThan(0);
    });
  }

  it('허용 비대칭 (a): leg 2에서 앵커가 찍히기 전 backend는 origin(용마산)이 2호선에 없어 null — device는 방향을 낸다', () => {
    const { origin, device, waypoints } = build(CASES[0]);
    const leg2 = waypoints.find((wp) => wp.line === '2')!;
    expect(backendDirection({ originStationName: origin.name }, leg2.line, leg2.stationName)).toBeNull();
    expect(device.get('2')).toBe('down');
  });
});
