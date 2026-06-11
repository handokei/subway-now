/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 hook은 destination(route feature) + boarding lock(alarm feature) +
 * route stops(shared utils)를 묶어 OS local notification 사전 예약(tripBoundScheduler)을 트리거하는
 * orchestrator. useBoardingLockScheduler와 동일한 옵트인 패턴(file-level disable). ADR Phase 5 (#890).
 */
import { useEffect, useRef } from 'react';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { Route } from '../../../shared/utils/stationRoute';
import { routeSignature } from '../utils/boardingLockScheduler';
import {
  cancelTripBoundAlarms,
  deriveTripBoundStops,
  prescheduleStationAlerts,
} from '../utils/tripBoundScheduler';
import { getTripStartedAt } from '../utils/tripStartStorage';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('useTripBoundAlarmScheduler');

export interface UseTripBoundAlarmSchedulerInputs {
  /** 현재 trip의 boarding lock. 있으면 `boardedAt`을 startTime으로 사용. */
  lock: BoardingLock | null;
  /** 트립 route. null이면 cancel만. */
  route: Route;
  /** 목적지명. null이면 cancel만. */
  destinationName: string | null;
}

/**
 * #918 (A3 후속 wire) — `tripBoundScheduler.prescheduleStationAlerts`의 단일 호출자.
 *
 * **PR1 (lockless 일반화):**
 *   사용자가 목적지를 설정하면 (route + destinationName 존재) lock이 아직 없어도 OS local
 *   notification을 사전 예약한다. startTime 결정 규칙:
 *   - lock 있음: `lock.boardedAt`
 *   - lock 없음 + tripStart 있음: `getTripStartedAt()` 값
 *   - lock 없음 + tripStart 없음: schedule skip (cold restart pre-destination 상태)
 *
 * **Dedup identity = tripStart (또는 lock 있을 때 boardedAt fallback).**
 *   lockless로 예약된 trip에 lock이 늦게 도착해도 tripStart가 동일하면 identity 미변경 → 재예약
 *   없음(이중 발사 회귀 차단).
 *
 * - identity 변경 또는 route signature 변경 시 기존 `tba:` 알람 일괄 cancel 후 재예약.
 * - destinationName=null 또는 route=null 전환 시 모든 `tba:` 알람 cancel.
 * - 같은 identity + 같은 route signature 재렌더는 no-op.
 *
 * 호출 측은 단일 owner 원칙(useBoardingLockScheduler와 동일) — HomeScreen에서 1회 마운트.
 */
export function useTripBoundAlarmScheduler({
  lock,
  route,
  destinationName,
}: UseTripBoundAlarmSchedulerInputs): void {
  // 마지막 성공한 schedule의 identity/sig. null이면 "현재 큐에 tba 알람 없음".
  // identity = `ts:${tripStart}` — lock 도착 전후로 동일 trip이면 안정.
  const scheduledIdentityRef = useRef<string | null>(null);
  const scheduledRouteSigRef = useRef<string | null>(null);

  // async race 가드: 같은 effect의 이전 호출이 아직 진행 중일 수 있으므로 in-flight token으로
  // stale completion이 ref를 잘못 update하지 않게 차단 (self code-review #3).
  const inFlightTokenRef = useRef(0);

  useEffect(() => {
    const nextSig = routeSignature(route, destinationName);
    const hasRouteAndDest = route !== null && destinationName !== null;

    const prevIdentity = scheduledIdentityRef.current;
    const prevSig = scheduledRouteSigRef.current;
    const hasPrevSchedule = prevIdentity !== null;

    // schedule 가능 여부는 tripStart 조회 후에야 확정 — 여기서는 "확실히 skip" 케이스만 단축.
    if (!hasPrevSchedule && !hasRouteAndDest) return;

    const myToken = ++inFlightTokenRef.current;

    const run = async (): Promise<void> => {
      // startTime SSOT: lock 있으면 boardedAt, 없으면 tripStart storage(useDestinationStore가 기록).
      const tripStart = lock !== null ? lock.boardedAt : await getTripStartedAt();
      if (myToken !== inFlightTokenRef.current) return;

      const canSchedule = hasRouteAndDest && tripStart !== null;
      const nextIdentity = canSchedule ? `ts:${tripStart}` : null;

      // 이전과 동일 identity + sig → no-op (lock 늦게 도착해도 tripStart 동일하면 여기서 차단).
      if (hasPrevSchedule && nextIdentity === prevIdentity && nextSig === prevSig) return;

      // 이전 예약이 있으면 항상 먼저 cancel (identity change / route change / release 모두 대상).
      if (hasPrevSchedule) {
        await cancelTripBoundAlarms();
      }
      if (myToken !== inFlightTokenRef.current) return;
      if (!canSchedule) {
        scheduledIdentityRef.current = null;
        scheduledRouteSigRef.current = null;
        return;
      }
      const { routeStops, estimatedHopTimesMs } = deriveTripBoundStops(route, destinationName);
      await prescheduleStationAlerts({
        routeStops,
        estimatedHopTimesMs,
        startTime: tripStart,
      });
      if (myToken !== inFlightTokenRef.current) return;
      scheduledIdentityRef.current = nextIdentity;
      scheduledRouteSigRef.current = nextSig;
    };

    run().catch((e: unknown) => {
      logger.error('tripBoundScheduler 전환 실패:', e);
    });
  }, [lock, route, destinationName]);
}
