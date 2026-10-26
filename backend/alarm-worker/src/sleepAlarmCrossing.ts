/**
 * #3100 — 취침 알람 칸 판정의 backend 어댑터. 순수 함수(`sleepAlarmCells.ts`)에 trip/waypoints를 먹인다.
 *
 * 남은 정거장은 "타깃이 속한 leg 안에서만" 센다. `trip.waypoints`에는 leg의 출발역이 없고(`scheduled.ts`
 * `evaluateSleepAlarmTrigger` 주석), 앞 leg의 환승역은 이미 소비돼 사라지므로 cron 전진은 항상 leg 첫 원소 기준이다.
 * sync가 환승을 넘어 여러 개를 한 번에 소비하는 경우(PR-2)에도 non-intermediate에서 끊어 leg를 가른다.
 */
import { LEG_START_INDEX, ONE_STATION_STEP } from '../../../src/shared/constants/sleepAlarm';
import {
  expandSleepAlarmStops,
  selectedCellsDue,
  selectSleepAlarmFire,
  type SleepAlarmCrossing,
} from '../../../src/shared/utils/sleepAlarmCells';
import type { Trip, Waypoint } from './types';

/** `index` 뒤 첫 non-intermediate(환승/하차) 인덱스. 없으면 undefined. */
function firstTargetAfter(waypoints: readonly Waypoint[], index: number): number | undefined {
  for (let i = index + ONE_STATION_STEP; i < waypoints.length; i += ONE_STATION_STEP) {
    if (waypoints[i].kind !== 'intermediate') return i;
  }
  return undefined;
}

/** `index` 앞 마지막 non-intermediate 인덱스. 없으면 leg 출발 위치(`LEG_START_INDEX`). */
function lastTargetBefore(waypoints: readonly Waypoint[], index: number): number {
  for (let i = index - ONE_STATION_STEP; i > LEG_START_INDEX; i -= ONE_STATION_STEP) {
    if (waypoints[i].kind !== 'intermediate') return i;
  }
  return LEG_START_INDEX;
}

/**
 * 앞에서부터 `appliedCount`개가 소비/전진된 뒤의 칸 범위. 마지막으로 소비된 waypoint(`waypoints[appliedCount - 1]`)
 * 가 intermediate이고 그 뒤에 타깃이 있을 때만 값이 있다.
 *
 *  - `waypoints[마지막 소비]`가 환승/하차면 이미 도착한 쌍이라 없음.
 *  - **`requestedCount`**: 소비하려고 요청한 개수(중단 경로에서 `applied < requested`). 타깃 인덱스가
 *    요청 구간 안(`< requestedCount`)이면 사용자가 이미 그 타깃에 도착한 것이라 없음 — 중단 경로가
 *    "곧 도착" 오알람을 만들지 않는다. 생략하면 `appliedCount`.
 *  - cron 1칸 전진(`appliedCount = ONE_STATION_STEP`)은 `{ from: to + 1, to }` — 정확히 `to`에 해당하는 칸만 걸린다.
 */
export function crossingForConsumed(
  waypoints: readonly Waypoint[],
  appliedCount: number,
  requestedCount: number = appliedCount,
): { target: Waypoint; crossing: SleepAlarmCrossing } | undefined {
  const lastConsumed = appliedCount - ONE_STATION_STEP;
  if (lastConsumed <= LEG_START_INDEX) return undefined;
  if (waypoints[lastConsumed]?.kind !== 'intermediate') return undefined;
  const targetIndex = firstTargetAfter(waypoints, lastConsumed);
  if (targetIndex === undefined || targetIndex < requestedCount) return undefined;
  const legStartIndex = lastTargetBefore(waypoints, lastConsumed);
  return {
    target: waypoints[targetIndex],
    crossing: { fromRemaining: targetIndex - legStartIndex, toRemaining: targetIndex - lastConsumed },
  };
}

/**
 * 이 trip이 발사할 취침 알람 칸. 설정은 **취침 모드 ON일 때만** 읽는다 — OFF거나 설정이 없으면 기본 `[MIN]`.
 * 발사 경로(cron·sync·승격 FF)가 모두 이 헬퍼 하나로 판단한다(단일 출처).
 */
export function readSleepAlarmStops(trip: Pick<Trip, 'sleepModeEnabled' | 'sleepAlarm'>): number[] {
  return expandSleepAlarmStops(trip.sleepModeEnabled === true ? trip.sleepAlarm : undefined);
}

/** 한 평가의 발사 후보: 걸린 칸들과 문구에 쓸 실제 남은 수. */
export interface SleepAlarmCandidates {
  /** 이번 평가에서 "걸린" 칸(내림차순). 이미 울린 칸 제외는 발사 쪽 칸 dedup이 한다. 매 역/기본은 [remaining] 하나. */
  cells: number[];
  remaining: number;
}

/**
 * 이 trip·crossing에서 발사할 후보. 선택 모드(`mode === 'selected'`, 취침 ON)만 "남은 수 <= N 인 모든 칸"
 * (`selectedCellsDue`)이고, 기본값·매 역은 기존 `to <= N < from` 경로 그대로(칸 = 실제 남은 수 하나).
 * cron(`evaluateSleepAlarmTrigger`)과 sync(`selectConsumedPrecedingAlarmPairs`)가 같은 함수로 판단한다.
 */
export function sleepAlarmCandidates(
  trip: Pick<Trip, 'sleepModeEnabled' | 'sleepAlarm'>,
  crossing: SleepAlarmCrossing,
): SleepAlarmCandidates | undefined {
  const { toRemaining: remaining } = crossing;
  const config = trip.sleepModeEnabled === true ? trip.sleepAlarm : undefined;
  if (config?.mode === 'selected') {
    const cells = selectedCellsDue(config.stops, crossing);
    return cells.length === 0 ? undefined : { cells, remaining };
  }
  const fired = selectSleepAlarmFire(readSleepAlarmStops(trip), crossing);
  return fired === undefined ? undefined : { cells: [fired], remaining: fired };
}
