/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 hook은 destination(route feature) + boarding lock(alarm feature) +
 * route stops(shared utils)를 묶어 OS local notification 사전 예약(tripBoundScheduler)을 트리거하는
 * orchestrator. useBoardingLockScheduler와 동일한 옵트인 패턴(file-level disable). ADR Phase 5 (#890).
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { Route } from '../../../shared/utils/stationRoute';
import { isSameStationName } from '../../../shared/utils/stationRoute';
import { routeSignature } from '../utils/boardingLockScheduler';
import {
  TRIPBOUND_WINDOW_SIZE,
  cancelTripBoundAlarms,
  deriveTripBoundStops,
  prescheduleStationAlerts,
  setRegisteredTripRouteSig,
  topUpTripBoundWindow,
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
  /**
   * #918 A3 PR3 — Fusion 현재역 이름. 통과 시 rolling window top-up trigger.
   * null이면 top-up 평가 skip(초기 마운트 + pre-fusion 케이스).
   */
  currentStationName?: string | null;
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
  currentStationName = null,
}: UseTripBoundAlarmSchedulerInputs): void {
  // 마지막 성공한 schedule의 identity/sig. null이면 "현재 큐에 tba 알람 없음".
  // identity = `ts:${tripStart}` — lock 도착 전후로 동일 trip이면 안정.
  const scheduledIdentityRef = useRef<string | null>(null);
  const scheduledRouteSigRef = useRef<string | null>(null);

  // async race 가드: 같은 effect의 이전 호출이 아직 진행 중일 수 있으므로 in-flight token으로
  // stale completion이 ref를 잘못 update하지 않게 차단 (self code-review #3).
  const inFlightTokenRef = useRef(0);

  // #918 A3 PR3 — top-up 호출 시 같은 데이터를 재사용하기 위한 ref. 초기 preschedule 성공 시 set.
  const scheduledStopsRef = useRef<{
    routeStops: ReturnType<typeof deriveTripBoundStops>['routeStops'];
    estimatedHopTimesMs: number[];
    startTime: number;
  } | null>(null);

  // station-pass 중복 호출 방지 — 마지막 top-up한 stationName. trip identity 변경 시 리셋.
  const lastToppedUpRef = useRef<string | null>(null);

  // top-up effect가 schedule 완료 시점을 인지하도록 epoch state로 trigger. ref만 사용하면 async run
  // 완료 후 effect re-run이 없어 currentStationName이 schedule 전에 들어와도 top-up이 시작 안 됨.
  const [scheduleEpoch, setScheduleEpoch] = useState(0);

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
        scheduledStopsRef.current = null;
        lastToppedUpRef.current = null;
        return;
      }
      const { routeStops, estimatedHopTimesMs } = deriveTripBoundStops(route, destinationName);
      await prescheduleStationAlerts({
        routeStops,
        estimatedHopTimesMs,
        startTime: tripStart,
        windowSize: TRIPBOUND_WINDOW_SIZE,
      });
      // #918 A3 PR2 (#729 흡수): fire-time 재검증을 위해 route signature 영속화.
      // canSchedule=true 경로는 hasRouteAndDest=true → routeSignature는 항상 string 반환 → nextSig non-null.
      // sig persist는 preschedule과 같은 awaited 동기 묶음 — 사이에 추가 token guard 없이도 한 번의 stale 차단
      // (이미 line 91/79)으로 충분. 새 effect가 fire하면 cancelTripBoundAlarms가 sig를 즉시 cleanup하므로
      // race 시 stale sig 잔존 위험은 새 effect가 흡수.
      if (myToken !== inFlightTokenRef.current) return;
      await setRegisteredTripRouteSig(nextSig as string);
      scheduledIdentityRef.current = nextIdentity;
      scheduledRouteSigRef.current = nextSig;
      scheduledStopsRef.current = { routeStops, estimatedHopTimesMs, startTime: tripStart };
      // identity 변경마다 top-up 중복 가드 리셋 — 새 trip의 첫 station-pass가 막히지 않게.
      lastToppedUpRef.current = null;
      // schedule 완료 신호 — top-up effect를 깨운다 (currentStationName이 schedule보다 먼저 들어온 경우 흡수).
      setScheduleEpoch((n) => n + 1);
    };

    run().catch((e: unknown) => {
      logger.error('tripBoundScheduler 전환 실패:', e);
    });
  }, [lock, route, destinationName]);

  // #918 A3 PR3 — rolling window top-up. Fusion 현재역이 routeStops의 stop과 매칭되면
  // 그 stop의 알람을 cancel하고 다음 N개를 채워 64 cap을 회피한다.
  useEffect(() => {
    if (currentStationName === null) return;
    const stopsCtx = scheduledStopsRef.current;
    if (stopsCtx === null) return;
    // canonical name 매칭 — boardingLockAdvancer와 동일 패턴(노선별 부제 흡수).
    const matched = stopsCtx.routeStops.find((s) =>
      isSameStationName(s.stationName, currentStationName),
    );
    if (!matched) return;
    // effect deps([currentStationName, scheduleEpoch])가 동일 stationName 재호출을 이미 차단하므로
    // 추가 dup guard는 두지 않는다. lastToppedUpRef는 FG resume의 "직전 통과 stop" 기준으로만 쓰인다.
    lastToppedUpRef.current = matched.stationName;
    topUpTripBoundWindow({
      routeStops: stopsCtx.routeStops,
      estimatedHopTimesMs: stopsCtx.estimatedHopTimesMs,
      startTime: stopsCtx.startTime,
      passedStationName: matched.stationName,
      windowSize: TRIPBOUND_WINDOW_SIZE,
    }).catch((e: unknown) => {
      logger.error('topUpTripBoundWindow 실패:', e);
    });
  }, [currentStationName, scheduleEpoch]);

  // #918 A3 PR3 — FG resume 시 top-up 재실행. BG에서 OS가 일부 알람을 발사/삭제했을 수 있어
  // 가장 최근 통과 stop 기준으로 윈도우를 다시 채운다 (idempotent).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state !== 'active') return;
      const stopsCtx = scheduledStopsRef.current;
      const passed = lastToppedUpRef.current;
      if (stopsCtx === null || passed === null) return;
      topUpTripBoundWindow({
        routeStops: stopsCtx.routeStops,
        estimatedHopTimesMs: stopsCtx.estimatedHopTimesMs,
        startTime: stopsCtx.startTime,
        passedStationName: passed,
        windowSize: TRIPBOUND_WINDOW_SIZE,
      }).catch((e: unknown) => {
        logger.error('FG resume top-up 실패:', e);
      });
    });
    return () => {
      subscription.remove();
    };
  }, []);
}
