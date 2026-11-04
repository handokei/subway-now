/**
 * K5 #2926 PR-B — lock 없는 trip 시한 종료 판정(순수 함수, KV/D1 접근 없음).
 *
 * 10/21 사용자 결정: "lockless trip 시한 종료 = 예상 소요 x1.5 + 15분, 종료 안내 1회".
 * lock이 없으면 backend는 위치 추적·역 전진·알림을 하지 않으므로(decision_lock_only_alerts) trip이 9h 만료까지
 * 좀비로 남는다 — 이 판정이 그 상한이다. 종료 실행(cleanup + 안내 1회)은 scheduled.ts cron 루프가 맡는다.
 */
import { getTransferSeconds } from '../../../src/shared/utils/transferTimes';
import { FALLBACK_HOP_SEC } from './cronConstants';
import type { Trip, Waypoint } from './types';

/** 예상 소요 배수. */
export const LOCKLESS_TIMEOUT_MULTIPLIER = 1.5;
/** 배수 적용 후 더하는 여유(ms). */
export const LOCKLESS_TIMEOUT_EXTRA_MS = 15 * 60_000;

function transferSecondsAt(waypoints: readonly Waypoint[], index: number): number {
  const waypoint = waypoints[index];
  const next = waypoints[index + 1];
  if (waypoint.kind !== 'transfer' || next === undefined) return 0;
  type Line = Parameters<typeof getTransferSeconds>[0];
  return getTransferSeconds(waypoint.line as Line, next.line as Line, waypoint.stationName);
}

/**
 * trip 예상 소요(초). 세션 원본 `routeWaypoints` 첫 waypoint의 `remainingSecToDest`(유한 비음수)가 있으면 우선,
 * 없으면 hop 수 x `FALLBACK_HOP_SEC` + 환승 waypoint별 도보 시간 합.
 *
 * `routeWaypoints`가 없으면 `undefined`(추정 불가 -> 종료 안 함). `waypoints`로 대신하지 않는 이유: cron·sync가 앞으로
 * 잘라 쓰는 진행분이라 전진할수록 추정이 줄어 정상 trip을 도중에 끊는다(실측 2026-09-18 replay에서 재현). `routeWaypoints`는
 * #2308 이후 등록 trip에 항상 채워지므로 이 제외는 구 레코드(9h 강제 종료가 상한)에만 해당한다.
 */
export function estimateTripDurationSec(trip: Trip): number | undefined {
  const { routeWaypoints: route } = trip;
  if (route === undefined) return undefined;
  const [first] = route;
  if (first === undefined) return 0;
  const { remainingSecToDest } = first;
  if (typeof remainingSecToDest === 'number' && Number.isFinite(remainingSecToDest) && remainingSecToDest >= 0) {
    return remainingSecToDest;
  }
  const hopSec = (route.length - 1) * FALLBACK_HOP_SEC;
  return route.reduce((sum, _wp, index) => sum + transferSecondsAt(route, index), hopSec);
}

/**
 * 시한 기준 시각 = max(createdAt, lock 해제 시각, boardingResponse.at). 해제 시각은 `locklessSince`, 또는 만료됐지만
 * 남아 있는 lock의 `expiresAt`. lock 이력이 있는데 해제 시각을 알 수 없으면(필드 도입 전 구 레코드) `undefined`.
 */
function locklessStartMs(trip: Trip): number | undefined {
  const { createdAt, boardingLock, lockEverAttached, locklessSince, boardingResponse } = trip;
  const releasedAt = locklessSince ?? boardingLock?.expiresAt;
  if (lockEverAttached === true && releasedAt === undefined) return undefined;
  return Math.max(createdAt, releasedAt ?? 0, boardingResponse?.at ?? 0);
}

/** 종료 기한(epoch ms). 판정 불가(기준 시각 미상 또는 `routeWaypoints` 부재)면 `undefined`. */
export function locklessTimeoutDeadline(trip: Trip): number | undefined {
  const start = locklessStartMs(trip);
  if (start === undefined) return undefined;
  const durationSec = estimateTripDurationSec(trip);
  if (durationSec === undefined) return undefined;
  return start + durationSec * 1000 * LOCKLESS_TIMEOUT_MULTIPLIER + LOCKLESS_TIMEOUT_EXTRA_MS;
}

/** lock이 활성이면 항상 `'none'`. lockless이고 기한을 넘겼을 때만 `'end'`. */
export function evaluateLocklessTimeout(trip: Trip, now: number): 'none' | 'end' {
  const { boardingLock } = trip;
  if (boardingLock !== undefined && boardingLock.expiresAt > now) return 'none';
  const deadline = locklessTimeoutDeadline(trip);
  return deadline !== undefined && now > deadline ? 'end' : 'none';
}
