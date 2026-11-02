/**
 * #2308 — lock 시작 재고정.
 *
 * lock은 붙는 순간의 `trip.waypoints`로 `segmentStations`를 만든다. lock 전에 waypoints가 이미 탑승역보다 앞서 잘려 있으면
 * (lockless cron 전진 / register 점프) 탑승역과 head 사이 역이 segment에서도 waypoints에서도 사라져 lock 트립인데도 영구 무발사다
 * (11/02 어린이대공원·군자). lock epoch 시작(이 lock의 trainCode로 쓰인 progress가 아직 없음)에서, 세션 노선 원본
 * (`trip.routeWaypoints`)으로 탑승역 다음부터 다시 깐다. 앞으로 잘린 경우에만, 노선이 일치할 때만 — 아니면 null(현행 유지, fail-closed).
 * 순수 함수(입력 불변).
 */
import { normalizeStationName } from '../../../src/shared/utils/normalizeStationName';
import { buildLegSegmentStations } from './lockSwap';
import type { TripProgress } from './progress';
import { waypointSignatureKey } from './trips';
import type { Trip, Waypoint } from './types';

export interface LockReanchorDecision {
  waypoints: Waypoint[];
  segmentStations: string[];
  /** 재고정 전 head 키 / 재고정 후 head 키 (D1 `lock-reanchor` 마커). */
  fromKey: string;
  toKey: string;
}

export function planLockReanchor(trip: Trip, progress: TripProgress | null): LockReanchorDecision | null {
  const { boardingLock: lock, routeWaypoints: route, waypoints } = trip;
  if (lock === undefined || route === undefined || waypoints.length === 0) return null;
  if (progress !== null && progress.trainCode === lock.trainCode) return null; // 진행 중인 lock — epoch 시작 아님
  const [boardingStation] = lock.segmentStations;
  if (boardingStation === undefined) return null;
  const boardingName = normalizeStationName(boardingStation);
  const boardingIndex = route.map((w) => normalizeStationName(w.stationName)).lastIndexOf(boardingName);
  const start = boardingIndex + 1; // 탑승역이 노선에 없으면(leg-1 출발역) 0
  const first = route[start];
  if (first === undefined || first.line !== lock.line) return null;
  const headKey = waypointSignatureKey(waypoints[0]);
  const headPosition = route.findIndex((w) => waypointSignatureKey(w) === headKey);
  if (headPosition <= start) return null; // 못 찾음(-1) / 이미 start / trip이 뒤 — 앞서 있을 때만
  const reanchored = route.slice(start);
  return {
    waypoints: reanchored,
    segmentStations: [boardingStation, ...buildLegSegmentStations(reanchored, lock.line)],
    fromKey: headKey,
    toKey: waypointSignatureKey(first),
  };
}
