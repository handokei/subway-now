import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { Route } from '../utils/stationRoute';
import type { Station } from '../types/station';
import type { StationArrival } from '../api/arrivalApi';
import {
  cancelScheduledAlarms,
  scheduleAlarmsForRoute,
} from '../utils/alarmScheduler';
import { resolveTripDirection, type TripDirection } from '../utils/tripDirection';
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
 * 진행 방향 열차의 "현재역 도착까지 남은 ETA"(초)를 추출한다.
 * direction이 null이면 양방향을 합산한 best-effort fallback을 반환한다(반대방향 오인 위험 있음).
 * 데이터가 없거나 mock이면 null을 반환해 alarmScheduler의 static fallback으로 위임한다.
 */
function pickCurrentStationApproachEtaSeconds(
  arrival: StationArrival | null,
  direction: TripDirection | null,
): number | null {
  if (!arrival || arrival.isMock) return null;
  const trains =
    direction === 'up'
      ? arrival.up
      : direction === 'down'
        ? arrival.down
        : [...arrival.up, ...arrival.down];
  const candidates = trains.map((info) => info.arrivalSeconds).filter((sec) => sec > 0);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
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

  routeRef.current = route;
  destinationRef.current = destination;
  currentStationRef.current = currentStation;
  arrivalRef.current = arrival;

  const reschedule = async (): Promise<void> => {
    await cancelScheduledAlarms();
    const currentRoute = routeRef.current;
    const currentDestination = destinationRef.current;
    if (!currentRoute || !currentDestination) return;
    if (appStateRef.current === 'active') return;
    const here = currentStationRef.current;
    const direction = here
      ? resolveTripDirection(currentRoute, currentDestination.name, here.id)
      : null;
    const approachEtaSeconds = pickCurrentStationApproachEtaSeconds(arrivalRef.current, direction);
    await scheduleAlarmsForRoute({
      route: currentRoute,
      destinationName: currentDestination.name,
      currentStationApproachEtaSeconds: approachEtaSeconds,
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
