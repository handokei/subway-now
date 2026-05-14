import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { Route } from '../utils/stationRoute';
import type { Station } from '../types/station';
import type { StationArrival } from '../api/arrivalApi';
import {
  cancelScheduledAlarms,
  scheduleAlarmsForRoute,
} from '../utils/alarmScheduler';
import { pickNextArrival } from '../utils/nextArrivalPick';
import { resolveTripDirection } from '../utils/tripDirection';
import {
  captureTripTrainCodeIfAbsent,
  clearTripTrainCode,
} from '../utils/tripTrainCode';
import { createLogger } from '../utils/logger';

const logger = createLogger('useScheduledAlarms');

export interface UseScheduledAlarmsInputs {
  route: Route;
  destination: Station | null;
  /** 사용자의 현재 위치 station — 진행 방향 산출에 필요. null이면 양방향 fallback. */
  currentStation: Station | null;
  arrival: StationArrival | null;
}

/**
 * BG/포그라운드 전환과 ETA 변동에 맞춰 사전 예약 알람을 재예약한다.
 *
 * 정책:
 * - 포그라운드(`active`): 예약 모두 취소. FG는 useStationAlarm이 GPS 기반 발화를 담당.
 * - 백그라운드(`background`): 마지막 route/destination/arrival 기준으로 재예약.
 * - 백그라운드 중 입력 변동: 즉시 cancel → reschedule.
 * - route/destination이 null이면 항상 cancel만 수행 (route 종료).
 * - 언마운트: 모두 취소.
 *
 * trainCode lock-in(#373 PoC): 트립 시작 후 첫 valid arrival에서 사용자 방향
 * 첫 trainCode를 저장. 이후 reschedule마다 같은 trainCode의 ETA를 우선 채택.
 * 매칭 실패 시 방향별 min ETA fallback. destination 변경/제거 시 lock 클리어.
 */
export function useScheduledAlarms({
  route,
  destination,
  currentStation,
  arrival,
}: UseScheduledAlarmsInputs): void {
  const routeRef = useRef<Route>(route);
  const destinationRef = useRef<Station | null>(destination);
  const currentStationRef = useRef<Station | null>(currentStation);
  const arrivalRef = useRef<StationArrival | null>(arrival);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const prevDestinationIdRef = useRef<string | null>(destination?.id ?? null);

  routeRef.current = route;
  destinationRef.current = destination;
  currentStationRef.current = currentStation;
  arrivalRef.current = arrival;

  const reschedule = async (): Promise<void> => {
    // destination 변경(또는 null화) 감지 → trainCode lock 클리어 후 진행.
    // reschedule 내부에서 처리해 별도 effect와의 race 조건을 차단한다.
    const currentDestination = destinationRef.current;
    const currDestId = currentDestination?.id ?? null;
    if (prevDestinationIdRef.current !== currDestId) {
      prevDestinationIdRef.current = currDestId;
      await clearTripTrainCode();
    }

    await cancelScheduledAlarms();
    const currentRoute = routeRef.current;
    if (!currentRoute || !currentDestination) return;

    // 진행 방향은 route + 현재역 ordinal로 결정한다 (#370). null이면 알 수 없음.
    // pickNextArrival에 filter로 전달해 반대방향 열차 ETA 오인을 차단.
    const here = currentStationRef.current;
    const direction = here
      ? resolveTripDirection(currentRoute, currentDestination.name, here.id)
      : null;

    // trainCode lock-in 캡처는 active/background와 무관하게 실행한다 — FG 첫 valid arrival에서도
    // lock이 걸려야 BG 갱신이 결정론적 ETA를 사용한다.
    const trainCode = await captureTripTrainCodeIfAbsent(
      currentDestination.id,
      arrivalRef.current,
      direction,
    );

    if (appStateRef.current === 'active') return;

    const pick = pickNextArrival(arrivalRef.current, direction, {
      preferTrainCode: trainCode,
    });
    logger.debug(
      `reschedule eta=${pick.etaSeconds} trainCode=${trainCode ?? 'none'} matched=${pick.matchedByTrainCode}`,
    );

    await scheduleAlarmsForRoute({
      route: currentRoute,
      destinationName: currentDestination.name,
      currentStationApproachEtaSeconds: pick.etaSeconds,
      // stamp.direction은 filter intent(=null이면 "방향 미판정")를 그대로 기록한다.
      // pick.direction(추론된 list)과 다를 수 있으나, 진단 시 의도와 fallback을 구분하기 위함.
      stamp: { direction, usedTrainCode: pick.trainCode },
    });
  };

  // AppState 전환 listener — 자체 등록 (중복 방지를 위해 다른 listener와 통합하지 않음).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const prev = appStateRef.current;
      appStateRef.current = state;
      if (state === prev) return;
      if (state === 'active') {
        cancelScheduledAlarms().catch((e) => logger.error('active 전환 취소 실패:', e));
        return;
      }
      if (state === 'background') {
        reschedule().catch((e) => logger.error('background 전환 재예약 실패:', e));
      }
    });
    return () => {
      subscription.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 입력 변동 시 재예약 — BG 상태에서만 의미가 있다. active면 reschedule이 내부에서 no-op.
  // route/destination이 null이면 cancel만 발생.
  useEffect(() => {
    reschedule().catch((e) => logger.error('입력 변동 재예약 실패:', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, destination?.id, currentStation?.id, arrival]);

  // 언마운트 — 모두 취소.
  useEffect(() => {
    return () => {
      cancelScheduledAlarms().catch((e) => logger.error('언마운트 취소 실패:', e));
    };
  }, []);
}
