import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { processLocationUpdate } from '../utils/stationPipeline';
import { alarmKey } from '../utils/stationAlarm';
import { createLogger } from '../utils/logger';
import { DESTINATION_KEY, SLEEP_MODE_KEY, FIRED_ALARMS_KEY, ALARM_EVENT_KEY, ROUTE_KEY, ALLOW_SPEAKER_KEY } from '../constants/storageKeys';
import { isAccuracyAcceptable, isLocationFresh } from '../utils/locationGates';
import { logSuppressedGate } from '../utils/alarmLog';
import type { Route } from '../utils/stationRoute';

const logger = createLogger('BackgroundLocation');

export const BACKGROUND_LOCATION_TASK = 'background-location-task';

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    logger.error('백그라운드 위치 오류:', error.message);
    return;
  }
  if (!data) return;

  const { locations } = data as { locations: Location.LocationObject[] };
  const latest = locations[locations.length - 1];
  if (!latest) return;

  // #275 진단: TaskManager가 백그라운드에서 실제로 깨어나 유효 데이터를 받았는지 확인.
  // 이 로그가 안 찍히면 JS runtime이 깨어나지 못하는 가설 A.
  logger.info('TASK FIRED', new Date().toISOString(), 'locations:', locations.length);

  // iOS deferred 위치 배치에서 stale/저정확도 좌표가 섞여 들어올 수 있음 — 차단.
  // 측정용으로 게이트 drop을 알람 로그에 fire-and-forget 적재 (B2 인프라).
  const { latitude: lat, longitude: lng, accuracy } = latest.coords;
  const ageMs = Date.now() - (latest.timestamp ?? 0);
  if (!isLocationFresh(latest.timestamp)) {
    logSuppressedGate('gate-age', { lat, lng, accuracy, ageMs });
    return;
  }
  if (!isAccuracyAcceptable(accuracy)) {
    logSuppressedGate('gate-accuracy', { lat, lng, accuracy, ageMs });
    return;
  }

  // #275 진단: 게이트 통과 직후 마커. 이후 destJson 없음 등의 조기 리턴은 별도로 식별.
  logger.info('PIPELINE ENTER', lat.toFixed(4), lng.toFixed(4), 'acc:', accuracy);

  const { speed } = latest.coords;
  const speedMps = speed != null && speed >= 0 ? speed : null;

  try {
    const [destJson, sleepJson, firedJson, routeJson, allowSpeakerJson] = await Promise.all([
      AsyncStorage.getItem(DESTINATION_KEY),
      AsyncStorage.getItem(SLEEP_MODE_KEY),
      AsyncStorage.getItem(FIRED_ALARMS_KEY),
      AsyncStorage.getItem(ROUTE_KEY),
      AsyncStorage.getItem(ALLOW_SPEAKER_KEY),
    ]);

    // 경로(목적지) 없으면 백그라운드에서도 실시간 현황 알림을 띄우지 않는다.
    if (!destJson) {
      logger.info('PIPELINE EXIT no-destination');
      return;
    }

    let destination;
    try {
      destination = JSON.parse(destJson);
    } catch {
      logger.error('목적지 JSON 파싱 실패');
      return;
    }
    const sleepMode = sleepJson ? JSON.parse(sleepJson) === true : false;
    const allowSpeaker = allowSpeakerJson ? JSON.parse(allowSpeakerJson) === true : true;
    const firedAlarms = new Set<string>(firedJson ? JSON.parse(firedJson) : []);
    const storedRoute: Route = routeJson ? JSON.parse(routeJson) : null;

    // lastNotifiedStationId는 stationPipeline 내부에서 notificationState 모듈을 통해
    // AsyncStorage에 직접 read/write 한다 (Foreground 훅과 단일 출처 공유).
    const { alarmEvent } = await processLocationUpdate({
      lat,
      lng,
      destination,
      firedAlarms,
      sleepMode,
      allowSpeaker,
      storedRoute,
      speedMps,
      source: 'bg',
    });

    if (alarmEvent) {
      firedAlarms.add(alarmKey(alarmEvent));
      await Promise.all([
        AsyncStorage.setItem(FIRED_ALARMS_KEY, JSON.stringify([...firedAlarms])),
        AsyncStorage.setItem(ALARM_EVENT_KEY, JSON.stringify(alarmEvent)),
      ]);
    }

    logger.info('백그라운드 위치 업데이트 완료:', lat.toFixed(4), lng.toFixed(4));
  } catch (e) {
    logger.error('백그라운드 태스크 실패:', e);
  }
});
