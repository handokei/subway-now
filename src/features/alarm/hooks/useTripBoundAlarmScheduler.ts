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
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('useTripBoundAlarmScheduler');

export interface UseTripBoundAlarmSchedulerInputs {
  /** 현재 trip의 boarding lock. `boardedAt`을 startTime의 SSOT로 사용. null이면 cancel만. */
  lock: BoardingLock | null;
  /** 트립 route. null이면 cancel만. */
  route: Route;
  /** 목적지명. null이면 cancel만. */
  destinationName: string | null;
}

/**
 * #918 (A3 후속 wire) — `tripBoundScheduler.prescheduleStationAlerts`의 단일 호출자.
 *
 * - lock + route + destinationName이 모두 갖춰진 첫 시점에 1회 사전 예약.
 * - lock.trainCode 변경 또는 route signature 변경 시 기존 `tba:` 알람 일괄 cancel 후 재예약.
 * - lock=null 전환(release / trip 종료) 시 모든 `tba:` 알람 cancel.
 * - 같은 trainCode + 같은 route signature 재렌더는 no-op (ref 비교).
 *
 * useBoardingLockScheduler와 prefix만 다르고 동일 lifecycle 패턴 — `bl:` 사전 예약은 lock 사용자 명시
 * 시작 시점에만 동작하지만 `tba:`는 destination+route+lock 활성 시점부터 OS 큐에 사전 예약된 일반화
 * fallback이다 (네트워크 0 환경 silent push 누락 보완).
 *
 * 호출 측은 단일 owner 원칙(useBoardingLockScheduler와 동일) — HomeScreen에서 1회 마운트.
 */
export function useTripBoundAlarmScheduler({
  lock,
  route,
  destinationName,
}: UseTripBoundAlarmSchedulerInputs): void {
  // 마지막 성공한 schedule의 trainCode/sig. null이면 "현재 큐에 tba 알람 없음".
  const scheduledTrainCodeRef = useRef<string | null>(null);
  const scheduledRouteSigRef = useRef<string | null>(null);

  // async race 가드: 같은 effect의 이전 호출이 아직 진행 중일 수 있으므로 in-flight token으로
  // stale completion이 ref를 잘못 update하지 않게 차단 (self code-review #3).
  const inFlightTokenRef = useRef(0);

  useEffect(() => {
    const nextTrain = lock?.trainCode ?? null;
    const nextSig = routeSignature(route, destinationName);
    const canSchedule = lock !== null && route !== null && destinationName !== null;

    const prevTrain = scheduledTrainCodeRef.current;
    const prevSig = scheduledRouteSigRef.current;
    const hasPrevSchedule = prevTrain !== null;

    // 이전 예약이 없고 이번에도 schedule 못 함 → 호출 자체 skip (lock=null인 상태에서 route만 바뀜 등).
    if (!hasPrevSchedule && !canSchedule) return;
    // 이전과 동일 (trainCode + sig 일치) → no-op.
    if (hasPrevSchedule && prevTrain === nextTrain && prevSig === nextSig) return;

    const myToken = ++inFlightTokenRef.current;

    const run = async (): Promise<void> => {
      // 이전 예약이 있으면 항상 먼저 cancel (trainCode change / route change / release 모두 대상).
      if (hasPrevSchedule) {
        await cancelTripBoundAlarms();
      }
      // stale completion: token이 현재 in-flight와 다르면 이번 run 결과로 ref 업데이트하지 않는다.
      if (myToken !== inFlightTokenRef.current) return;
      if (!canSchedule) {
        scheduledTrainCodeRef.current = null;
        scheduledRouteSigRef.current = null;
        return;
      }
      const { routeStops, estimatedHopTimesMs } = deriveTripBoundStops(route, destinationName);
      await prescheduleStationAlerts({
        routeStops,
        estimatedHopTimesMs,
        startTime: lock.boardedAt,
      });
      if (myToken !== inFlightTokenRef.current) return;
      scheduledTrainCodeRef.current = nextTrain;
      scheduledRouteSigRef.current = nextSig;
    };

    run().catch((e: unknown) => {
      logger.error('tripBoundScheduler 전환 실패:', e);
    });
  }, [lock, route, destinationName]);
}
