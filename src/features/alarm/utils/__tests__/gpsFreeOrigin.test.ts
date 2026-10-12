import { resolveGpsFreeOrigin } from '../gpsFreeOrigin';
import { getStationById } from '../../../../shared/utils/stationRoute';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import type { Station } from '../../../../shared/types/station';

function st(id: string): Station {
  const s = getStationById(id);
  if (!s) throw new Error(`fixture station not found: ${id}`);
  return s;
}

const routeOnLine3 = makeDirectRoute(5, '3');

describe('resolveGpsFreeOrigin (#2959)', () => {
  // R-2 — currentStation이 있으면 후보 무관하게 그 값을 그대로 반환(현행 동작 불변).
  it('currentStation이 있으면 그대로 반환 — 후보는 무시', () => {
    const current = st('2-022');
    const custom = st('3-001');
    expect(resolveGpsFreeOrigin(current, [custom], makeDirectRoute(5, '2'))).toBe(current);
  });

  it('currentStation=null, 첫 후보(customOrigin)가 있으면 그 값 채택', () => {
    const custom = st('3-001');
    const boardingLockStation = st('3-002');
    expect(resolveGpsFreeOrigin(null, [custom, boardingLockStation, null], routeOnLine3)).toBe(
      custom,
    );
  });

  it('currentStation=null, 첫 후보 null → 두 번째 후보(boardingLockStation) 채택', () => {
    const boardingLockStation = st('3-002');
    expect(
      resolveGpsFreeOrigin(null, [null, boardingLockStation, st('3-003')], routeOnLine3),
    ).toBe(boardingLockStation);
  });

  it('currentStation=null, 앞 두 후보 null → 세 번째 후보(tripOrigin) 채택', () => {
    const tripOrigin = st('3-003');
    expect(resolveGpsFreeOrigin(null, [null, undefined, tripOrigin], routeOnLine3)).toBe(
      tripOrigin,
    );
  });

  // R-1 — 후보가 전부 null(undefined 포함)이면 null 반환 — 현행 sparse 유지, 억지 추측 금지.
  it('R-1: currentStation=null + 후보 전부 null/undefined → null', () => {
    expect(resolveGpsFreeOrigin(null, [null, undefined, null], routeOnLine3)).toBeNull();
  });

  it('R-1: 후보 배열이 비어있어도 null', () => {
    expect(resolveGpsFreeOrigin(null, [], routeOnLine3)).toBeNull();
  });

  it('R-1: route가 null이면(trip 종료 등) 후보가 있어도 null', () => {
    expect(resolveGpsFreeOrigin(null, [st('3-001')], null)).toBeNull();
  });

  // R-3 — 후보가 route와 무관한 노선의 역이면 건너뛰고 다음 후보를 시도, 전부 그렇다면 null.
  it('R-3: 1순위 후보가 route와 무관한 노선 → 건너뛰고 2순위(route 상의 역) 채택', () => {
    const offRoute = st('2-022'); // 2호선 — routeOnLine3(3호선)과 무관
    const onRoute = st('3-002');
    expect(resolveGpsFreeOrigin(null, [offRoute, onRoute], routeOnLine3)).toBe(onRoute);
  });

  it('R-3: 모든 후보가 route와 무관한 노선 → null (엉뚱한 waypoint 생성 금지)', () => {
    const offRoute1 = st('2-022');
    const offRoute2 = st('5-024');
    expect(resolveGpsFreeOrigin(null, [offRoute1, offRoute2], routeOnLine3)).toBeNull();
  });
});
