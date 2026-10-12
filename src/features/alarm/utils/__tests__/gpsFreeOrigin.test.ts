import { resolveGpsFreeOrigin } from '../gpsFreeOrigin';
import { getStationById } from '../../../../shared/utils/stationRoute';
import type { Station } from '../../../../shared/types/station';

function st(id: string): Station {
  const s = getStationById(id);
  if (!s) throw new Error(`fixture station not found: ${id}`);
  return s;
}

describe('resolveGpsFreeOrigin (#2959)', () => {
  // R-2 — currentStation이 있으면 후보 무관하게 그 값을 그대로 반환(현행 동작 불변).
  it('currentStation이 있으면 그대로 반환 — 후보는 무시', () => {
    const current = st('2-022');
    const custom = st('3-001');
    expect(resolveGpsFreeOrigin(current, [custom])).toBe(current);
  });

  it('currentStation=null, 첫 후보(customOrigin)가 있으면 그 값 채택', () => {
    const custom = st('3-001');
    const boardingLockStation = st('3-002');
    expect(resolveGpsFreeOrigin(null, [custom, boardingLockStation, null])).toBe(custom);
  });

  it('currentStation=null, 첫 후보 null → 두 번째 후보(boardingLockStation) 채택', () => {
    const boardingLockStation = st('3-002');
    expect(resolveGpsFreeOrigin(null, [null, boardingLockStation, st('3-003')])).toBe(
      boardingLockStation,
    );
  });

  it('currentStation=null, 앞 두 후보 null → 세 번째 후보(tripOrigin) 채택', () => {
    const tripOrigin = st('3-003');
    expect(resolveGpsFreeOrigin(null, [null, undefined, tripOrigin])).toBe(tripOrigin);
  });

  // R-1 — 후보가 전부 null(undefined 포함)이면 null 반환 — 현행 sparse 유지, 억지 추측 금지.
  it('R-1: currentStation=null + 후보 전부 null/undefined → null', () => {
    expect(resolveGpsFreeOrigin(null, [null, undefined, null])).toBeNull();
  });

  it('R-1: 후보 배열이 비어있어도 null', () => {
    expect(resolveGpsFreeOrigin(null, [])).toBeNull();
  });
});
