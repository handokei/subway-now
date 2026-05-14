import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DESTINATION_KEY, ROUTE_KEY, LAST_NOTIFIED_STATION_KEY } from '../constants/storageKeys';
import { scheduleAlarmsForRoute } from '../utils/alarmScheduler';
import { fetchArrivalInfo, type ArrivalInfo, type StationArrival } from '../api/arrivalApi';
import stationsData from '../data/stations.json';
import type { Station } from '../types/station';
import type { Route } from '../utils/stationRoute';
import { resolveTripDirection, type TripDirection } from '../utils/tripDirection';
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

function pickCurrentStationApproachEtaSeconds(
  arrivals: { up: ArrivalInfo[]; down: ArrivalInfo[] },
  direction: TripDirection | null,
): number | null {
  // 진행 방향이 정해지면 한쪽 list만 사용한다. 정해지지 않은 경계 케이스(환상선/노선 이탈)는
  // 안전을 위해 양방향 합산 best-effort로 폴백한다.
  const trains: ArrivalInfo[] =
    direction === 'up'
      ? arrivals.up
      : direction === 'down'
        ? arrivals.down
        : [...arrivals.up, ...arrivals.down];
  let min: number | null = null;
  for (const info of trains) {
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

async function resolveCurrentStation(): Promise<Station | null> {
  const id = await AsyncStorage.getItem(LAST_NOTIFIED_STATION_KEY);
  if (!id) return null;
  return stationById.get(id) ?? null;
}

TaskManager.defineTask(ALARM_REFRESH_TASK, async () => {
  try {
    const active = await readActiveTrip();
    if (!active) {
      logger.info('활성 트립 없음 — 스킵');
      return BackgroundTask.BackgroundTaskResult.Success;
    }

    const currentStation = await resolveCurrentStation();
    const direction = currentStation
      ? resolveTripDirection(active.route, active.destination.name, currentStation.id)
      : null;
    let currentStationApproachEtaSeconds: number | null = null;
    if (currentStation) {
      try {
        const arrivals: StationArrival = await fetchArrivalInfo(currentStation.name);
        currentStationApproachEtaSeconds = pickCurrentStationApproachEtaSeconds(
          arrivals,
          direction,
        );
      } catch (e) {
        logger.warn('Arrival API 호출 실패 — static ETA fallback:', e);
      }
    }

    await scheduleAlarmsForRoute({
      route: active.route,
      destinationName: active.destination.name,
      currentStationApproachEtaSeconds,
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
