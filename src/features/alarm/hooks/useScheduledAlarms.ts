/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import type { StationArrival } from '../../../shared/types/arrival';
import {
  cancelScheduledAlarms,
  scheduleAlarmsForRoute,
} from '../utils/alarmScheduler';
import { pickNextArrival } from '../../arrival/utils/nextArrivalPick';
import { resolveTripDirection } from '../../route/utils/tripDirection';
import {
  captureTripTrainCodeIfAbsent,
  clearTripTrainCode,
} from '../../route/utils/tripTrainCode';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('useScheduledAlarms');

export interface UseScheduledAlarmsInputs {
  route: Route;
  destination: Station | null;
  /** 사용자의 현재 위치 station — 진행 방향 산출에 필요. null이면 양방향 fallback. */
  currentStation: Station | null;
  arrival: StationArrival | null;
}

/**
 * 입력 변동(ETA/경로/현재역) 또는 AppState 전환 시 사전 예약 알람을 재예약한다.
 *
 * 정책 (#383 — AppState와 무관하게 항상 예약):
 * - route + destination이 유효하면 AppState와 관계없이 즉시 예약.
 *   FG에서 OS가 알람을 발사해도 scheduledAlarmReceiver의 FIRED_ALARMS dedup으로
 *   useStationAlarm GPS 기반 발화와 충돌하지 않는다.
 * - 'background' 전환 시: 사용자가 FG에서 빠르게 잠금화면으로 갈 때 input-change
 *   effect가 미처 완료되지 못한 race를 차단하기 위한 idempotent safety net으로
 *   reschedule 한 번 더 호출.
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
    if (!currentRoute || !currentDestination) {
      logger.info(
        `skip reschedule appState=${appStateRef.current} reason=${!currentRoute ? 'no-route' : 'no-destination'}`,
      );
      return;
    }

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

    const pick = pickNextArrival(arrivalRef.current, direction, {
      preferTrainCode: trainCode,
    });
    logger.info(
      `reschedule appState=${appStateRef.current} eta=${pick.etaSeconds} trainCode=${trainCode ?? 'none'} matched=${pick.matchedByTrainCode}`,
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

  // AppState 전환 listener — 'background' 진입 시 idempotent re-sync.
  // FG에서 input-change effect가 비동기 reschedule을 채 완료하기 전에 OS가
  // suspend되는 race를 차단하는 safety net 역할.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const prev = appStateRef.current;
      appStateRef.current = state;
      if (state === prev) return;
      if (state === 'background') {
        reschedule().catch((e) => logger.error('background 전환 재예약 실패:', e));
      }
    });
    return () => {
      subscription.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 입력 변동 시 재예약 — AppState와 무관하게 항상 schedule.
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
