/**
 * 세션 신원 판정 + 재등록 시 boardingLock carry — POST /trips(index.ts)와 lockOps.registerSession이
 * 같은 식을 쓰도록 index.ts에서 순수 함수로 추출했다(#3300 옵션 D PR-1, 동작 무변경).
 */
import type { BoardingLockMeta, Trip } from './types';

/** evaluateSameSession이 읽는 최소 필드 — Trip과 LockCell 시야 둘 다 만족시키기 위한 좁은 타입. */
export type SessionIdentity = Pick<Trip, 'boardingLock' | 'createdAt'>;

/**
 * #704: 동일 세션 판별 — strict createdAt 동일성에서 trainCode 기반 + drift 허용으로 완화.
 *
 * 같은 세션 조건 (OR):
 *   1) 양쪽 boardingLock.trainCode가 일치 — cold restart로 createdAt이 바뀌어도 같은 열차면 진행 유지
 *   2) trainCode 미사용 단계라면 createdAt drift가 SESSION_DRIFT_WINDOW_MS 이내
 *
 * trainCode가 다르면 명백히 다른 열차로 새 세션 → false. lock이 한쪽만 있어도(이행 단계)
 * createdAt drift만으로 판정.
 */
export const SESSION_DRIFT_WINDOW_MS = 5_000;

export function evaluateSameSession(existing: SessionIdentity, incoming: SessionIdentity): boolean {
  const existingCode = existing.boardingLock?.trainCode;
  const incomingCode = incoming.boardingLock?.trainCode;
  if (existingCode && incomingCode) {
    return existingCode === incomingCode;
  }
  return Math.abs(existing.createdAt - incoming.createdAt) <= SESSION_DRIFT_WINDOW_MS;
}

/**
 * #1366 Layer 3 — boardingLock cross-validation (POST /trips merge 시점).
 *
 * Frontend가 환승 hop 진입 시 store 업데이트 race로 새 line의 trainCode를 직전 leg의
 * segmentStations와 결합해 stale metadata로 전송하는 케이스가 관측됐다
 * (item 4 8:33 환승역 즉시 재탑승 trip — lock.line='7' + waypoints는 전부 2호선).
 *
 * 게이트: lock.line이 incoming.waypoints의 어느 waypoint.line과도 일치하지 않으면
 * lock metadata는 거짓 — backend가 채택하지 않고 lock 필드만 drop한다 (trip 본체는 살림).
 *
 * 좁은 (stationName + line) 매칭 대신 line-level 매칭만 보는 이유:
 *  - Lock의 segmentStations[0]은 사용자가 탑승한 출발역. waypoints는 transfer/destination
 *    anchor만 포함하므로 출발역이 waypoint에 직접 등장하지 않을 수 있다.
 *  - 사용자가 실제 탑승한 line은 반드시 trip route의 어딘가에 등장해야 한다 — 등장하지
 *    않는다면 stale metadata로 단정한다.
 *
 * waypoints가 비어 있으면 (validateTrip이 미리 차단) false로 평가된다.
 */
export function isBoardingLockConsistentWithWaypoints(
  lock: BoardingLockMeta,
  waypoints: ReadonlyArray<{ line: string }>,
): boolean {
  return waypoints.some((wp) => wp.line === lock.line);
}

/**
 * #2554 (ADR-038 Phase 0) — same-session 재등록 시 보존할 boardingLock 산출(auto/manual 무관).
 * incoming이 있으면 그대로 채택(swap/재송신). 없으면 existing lock을 현재 waypoints와 정합할
 * 때만 보존한다 — 환승 후 stale leg-1 lock이 leg-2 waypoints에 살아남는 회귀를 차단(정합 실패
 * 시 drop → lockMissing → leg-2 프롬프트 정상). new-session 분기는 호출자가 incoming을 그대로 쓴다.
 */
export function carryBoardingLock(args: {
  incomingLock: BoardingLockMeta | undefined;
  isSameSession: boolean;
  existingLock: BoardingLockMeta | undefined;
  existingWaypoints: ReadonlyArray<{ line: string }>;
}): BoardingLockMeta | undefined {
  const { incomingLock, isSameSession, existingLock, existingWaypoints } = args;
  return (
    incomingLock ??
    (isSameSession &&
    existingLock !== undefined &&
    isBoardingLockConsistentWithWaypoints(existingLock, existingWaypoints)
      ? existingLock
      : undefined)
  );
}
