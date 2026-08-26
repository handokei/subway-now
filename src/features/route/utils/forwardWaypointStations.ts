import type { Station } from '../../../shared/types/station';

/**
 * #2383 — lock route arc에서 anchor station 다음 N개 전방 waypoint station을 반환한다.
 *
 * `bgPositionTrainFire.ts`가 arrival API(`getArrival(stationName)`)를 폴링할 대상을 정하는 데
 * 사용한다. arrival API는 그 역으로 접근 중인 열차만 반환하므로, 이미 지난 역이 아니라
 * 전방 역을 폴링해야 lock.trainCode 열차가 응답에 잡힌다.
 *
 * anchor(BG_LAST_STATION 또는 lock.boardingStationId)가 arcStations에서 발견되지 않으면
 * 빈 배열(폴링 skip — 호출자가 quota 보호).
 */
export function forwardWaypointStations(
  arcStations: readonly Station[],
  anchorStationId: string,
  count: number,
): Station[] {
  const anchorIdx = arcStations.findIndex((s) => s.id === anchorStationId);
  if (anchorIdx === -1) return [];
  return arcStations.slice(anchorIdx + 1, anchorIdx + 1 + Math.max(0, count));
}
