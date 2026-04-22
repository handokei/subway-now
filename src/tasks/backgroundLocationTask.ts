import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { processLocationUpdate } from '../utils/stationPipeline';
import { alarmKey } from '../utils/stationAlarm';
import { updateStationNotification } from '../utils/stationNotification';
import { findNearestStation } from '../utils/findNearestStation';
import { createLogger } from '../utils/logger';

const logger = createLogger('BackgroundLocation');

export const BACKGROUND_LOCATION_TASK = 'background-location-task';

const DESTINATION_KEY = 'subway-now:destination';
const SLEEP_MODE_KEY = 'subway-now:sleep-mode';
const FIRED_ALARMS_KEY = 'subway-now:fired-alarms';

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    logger.error('백그라운드 위치 오류:', error.message);
    return;
  }
  if (!data) return;

  const { locations } = data as { locations: Location.LocationObject[] };
  const latest = locations[locations.length - 1];
  if (!latest) return;

  const { latitude, longitude } = latest.coords;

  try {
    const [destJson, sleepJson, firedJson] = await Promise.all([
      AsyncStorage.getItem(DESTINATION_KEY),
      AsyncStorage.getItem(SLEEP_MODE_KEY),
      AsyncStorage.getItem(FIRED_ALARMS_KEY),
    ]);

    // 목적지 미설정 시 현재 역 알림만 업데이트
    if (!destJson) {
      const nearest = findNearestStation(latitude, longitude);
      if (nearest) {
        await updateStationNotification(
          nearest.station,
          Math.round(nearest.distanceKm * 1000),
        );
      }
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
    const firedAlarms = new Set<string>(firedJson ? JSON.parse(firedJson) : []);

    const { alarmEvent } = await processLocationUpdate(
      latitude,
      longitude,
      destination,
      firedAlarms,
      sleepMode,
    );

    if (alarmEvent) {
      firedAlarms.add(alarmKey(alarmEvent));
      await AsyncStorage.setItem(FIRED_ALARMS_KEY, JSON.stringify([...firedAlarms]));
    }

    logger.info('백그라운드 위치 업데이트 완료:', latitude.toFixed(4), longitude.toFixed(4));
  } catch (e) {
    logger.error('백그라운드 태스크 실패:', e);
  }
});
