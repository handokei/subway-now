/**
 * #2629 PR-3 — lock 열차 위치 따라잡기 계획(순수 함수). 구현 전 스텁.
 */
import type { PositionEntry } from './seoul';
import type { BoardingLockMeta, Trip, Waypoint } from './types';

export interface PositionCatchupInputs {
  trip: Pick<Trip, 'waypoints'>;
  lock: BoardingLockMeta;
  positions: readonly PositionEntry[];
  now: number;
}

/** 열차가 이미 지나친 선두 intermediate waypoint(오래된 순). 따라잡기 불가면 []. */
export function planPositionCatchup(_inputs: PositionCatchupInputs): Waypoint[] {
  return [];
}
