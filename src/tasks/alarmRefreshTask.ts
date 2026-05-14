import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DESTINATION_KEY, ROUTE_KEY, LAST_NOTIFIED_STATION_KEY } from '../constants/storageKeys';
import { getLastFiredAlarmStationName } from '../utils/notificationState';
import { scheduleAlarmsForRoute } from '../utils/alarmScheduler';
import { fetchArrivalInfo } from '../api/arrivalApi';
import { pickNextArrival, type NextArrivalPick } from '../utils/nextArrivalPick';
import {
  captureTripTrainCodeIfAbsent,
  clearTripTrainCode,
} from '../utils/tripTrainCode';
import stationsData from '../data/stations.json';
import type { Station } from '../types/station';
import type { Route } from '../utils/stationRoute';
import { resolveTripDirection } from '../utils/tripDirection';
import { createLogger } from '../utils/logger';

const logger = createLogger('AlarmRefreshTask');

export const ALARM_REFRESH_TASK = 'alarm-refresh-task';

/**
 * BGAppRefreshTask. OS가 ~15분 주기로 깨워 활성 트립의 사전 예약 알람을 갱신.
 *
 * Phase 1 fallback — 알림 권한은 있으나 silent push(Phase 2)를 못 받는 사용자용.
 * iOS는 사용 빈도에 따라 OS가 호출 간격을 가감하므로 보장된 주기가 아니다.
 */
const allStations = stationsData as Station[];
const stationById = new Map<string, Station>(allStations.map((s) => [s.id, s]));

async function readActiveTrip(): Promise<{ destination: Station; route: NonNullable<Route> } | null> {
  const [destJson, routeJson] = await Promise.all([
    AsyncStorage.getItem(DESTINATION_KEY),
    AsyncStorage.getItem(ROUTE_KEY),
  ]);
  if (!destJson || !routeJson) return null;
  try {
    const destination = JSON.parse(destJson) as Station;
    const route = JSON.parse(routeJson) as Route;
    if (!destination?.name || !route) return null;
    return { destination, route };
  } catch (e) {
    logger.error('활성 트립 파싱 실패:', e);
    return null;
  }
}

async function resolveCurrentStation(): Promise<Station | null> {
  // 1순위: 사전 예약 알람 발화 이름(#371) — GPS LAST_NOTIFIED는 BG 위치 업데이트 끊긴 동안 stale.
  // 동명이역은 첫 매칭 Station을 반환. 노선이 어긋나면 하류의 resolveTripDirection(#370)이
  // direction=null로 안전 폴백 → 양방향 합산 ETA로 그레이스풀 다운그레이드.
  const firedName = await getLastFiredAlarmStationName();
  if (firedName) {
    const byName = allStations.find((s) => s.name === firedName);
    if (byName) return byName;
  }
  // 2순위: GPS LAST_NOTIFIED id.
  const id = await AsyncStorage.getItem(LAST_NOTIFIED_STATION_KEY);
  if (!id) return null;
  return stationById.get(id) ?? null;
}

TaskManager.defineTask(ALARM_REFRESH_TASK, async () => {
  try {
    const active = await readActiveTrip();
    if (!active) {
      // 활성 트립이 없으면 lock-in된 trainCode도 의미 없음 — 정리.
      await clearTripTrainCode();
      logger.info('활성 트립 없음 — 스킵');
      return BackgroundTask.BackgroundTaskResult.Success;
    }

    // 진행 방향은 route + 현재역 ordinal로 판정(#370). null이면 양방향 fallback.
    const currentStation = await resolveCurrentStation();
    const direction = currentStation
      ? resolveTripDirection(active.route, active.destination.name, currentStation.id)
      : null;
    let pick: NextArrivalPick = {
      etaSeconds: null,
      direction: null,
      trainCode: null,
      matchedByTrainCode: false,
    };
    if (currentStation) {
      try {
        const arrivals = await fetchArrivalInfo(currentStation.name);
        // trainCode lock-in: 저장된 코드가 없으면 첫 valid arrival의 방향-필터 picker로 캡처.
        const trainCode = await captureTripTrainCodeIfAbsent(
          active.destination.id,
          arrivals,
          direction,
        );
        pick = pickNextArrival(arrivals, direction, { preferTrainCode: trainCode });
      } catch (e) {
        logger.warn('Arrival API 호출 실패 — static ETA fallback:', e);
      }
    }

    await scheduleAlarmsForRoute({
      route: active.route,
      destinationName: active.destination.name,
      currentStationApproachEtaSeconds: pick.etaSeconds,
      // stamp.direction은 의도(filter)를 기록 — pick.direction(추론된 list)이 아닌 route-resolved.
      stamp: { direction, usedTrainCode: pick.trainCode },
    });
    logger.info(
      `알람 사전 예약 갱신 완료 — eta=${pick.etaSeconds} matched=${pick.matchedByTrainCode}`,
    );
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    logger.error('알람 갱신 태스크 실패:', e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/**
 * 트립 시작 시 호출. iOS BGAppRefreshTask 등록.
 * minimumInterval은 OS 권고치(15분). 실제 호출은 OS 재량.
 */
export async function registerAlarmRefreshTask(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(ALARM_REFRESH_TASK);
  if (isRegistered) return;
  await BackgroundTask.registerTaskAsync(ALARM_REFRESH_TASK, { minimumInterval: 15 });
  logger.info('AlarmRefreshTask 등록');
}

/**
 * 트립 종료 시 호출.
 */
export async function unregisterAlarmRefreshTask(): Promise<void> {
  const isRegistered = await TaskManager.isTaskRegisteredAsync(ALARM_REFRESH_TASK);
  if (!isRegistered) return;
  await BackgroundTask.unregisterTaskAsync(ALARM_REFRESH_TASK);
  logger.info('AlarmRefreshTask 해제');
}
