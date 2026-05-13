import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DESTINATION_KEY, ROUTE_KEY, LAST_NOTIFIED_STATION_KEY } from '../constants/storageKeys';
import { scheduleAlarmsForRoute } from '../utils/alarmScheduler';
import { fetchArrivalInfo, type ArrivalInfo } from '../api/arrivalApi';
import stationsData from '../data/stations.json';
import type { Station } from '../types/station';
import type { Route } from '../utils/stationRoute';
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

function pickNextStationEtaSeconds(arrivals: { up: ArrivalInfo[]; down: ArrivalInfo[] }): number | null {
  // 방향 정보 없이 BG에서 가장 신뢰할 수 있는 신호는 "임박한 도착". up/down 합산해
  // 양수 중 최소값을 다음 도착 ETA로 사용한다. 정확도는 reschedule(#335)이 보정.
  let min: number | null = null;
  for (const info of [...arrivals.up, ...arrivals.down]) {
    if (info.arrivalSeconds > 0 && (min === null || info.arrivalSeconds < min)) {
      min = info.arrivalSeconds;
    }
  }
  return min;
}

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

async function resolveCurrentStationName(): Promise<string | null> {
  const id = await AsyncStorage.getItem(LAST_NOTIFIED_STATION_KEY);
  if (!id) return null;
  return stationById.get(id)?.name ?? null;
}

TaskManager.defineTask(ALARM_REFRESH_TASK, async () => {
  try {
    const active = await readActiveTrip();
    if (!active) {
      logger.info('활성 트립 없음 — 스킵');
      return BackgroundTask.BackgroundTaskResult.Success;
    }

    const currentStationName = await resolveCurrentStationName();
    let nextStationEtaSeconds: number | null = null;
    if (currentStationName) {
      try {
        const arrivals = await fetchArrivalInfo(currentStationName);
        nextStationEtaSeconds = pickNextStationEtaSeconds(arrivals);
      } catch (e) {
        logger.warn('Arrival API 호출 실패 — static ETA fallback:', e);
      }
    }

    await scheduleAlarmsForRoute({
      route: active.route,
      destinationName: active.destination.name,
      nextStationEtaSeconds,
    });
    logger.info('알람 사전 예약 갱신 완료');
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
