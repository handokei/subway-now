import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { processLocationUpdate } from '../utils/stationPipeline';
import { alarmKey } from '../utils/stationAlarm';
import { createLogger } from '../utils/logger';
import { DESTINATION_KEY, SLEEP_MODE_KEY, ALARM_EVENT_KEY, ROUTE_KEY, ALLOW_SPEAKER_KEY } from '../constants/storageKeys';
import { getFiredAlarms, setFiredAlarms } from '../utils/notificationState';
import { isAccuracyAcceptable, isLocationFresh } from '../utils/locationGates';
import { logSuppressedGate } from '../utils/alarmLog';
import type { Route } from '../utils/stationRoute';
import type { Station } from '../types/station';

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

  // iOS deferred 위치 배치에서 stale/저정확도 좌표가 섞여 들어올 수 있음 — 차단.
  // 측정용으로 게이트 drop을 알람 로그에 fire-and-forget 적재 (B2 인프라).
  const { latitude: lat, longitude: lng, accuracy } = latest.coords;
  const ageMs = Date.now() - (latest.timestamp ?? 0);
  if (!isLocationFresh(latest.timestamp)) {
    logSuppressedGate('gate-age', { lat, lng, accuracy, ageMs });
    return;
  }
  // BG task는 알람 발화 경로이므로 알람 엄격 게이트(MAX_ACCURACY_M=200m)를 유지한다.
  // foreground watch의 표시용 완화 게이트(MAX_ACCURACY_M_DISPLAY=1500m)는 여기서 적용 금지.
  // 여기서 게이트를 풀면 지하 구간 노이즈 좌표로 알람이 잘못 발화될 수 있다.
  if (!isAccuracyAcceptable(accuracy)) {
    logSuppressedGate('gate-accuracy', { lat, lng, accuracy, ageMs });
    return;
  }

  const { speed } = latest.coords;
  const speedMps = speed != null && speed >= 0 ? speed : null;

  try {
    const [destJson, sleepJson, routeJson, allowSpeakerJson] = await Promise.all([
      AsyncStorage.getItem(DESTINATION_KEY),
      AsyncStorage.getItem(SLEEP_MODE_KEY),
      AsyncStorage.getItem(ROUTE_KEY),
      AsyncStorage.getItem(ALLOW_SPEAKER_KEY),
    ]);

    // 경로(목적지) 없으면 백그라운드에서도 실시간 현황 알림을 띄우지 않는다.
    if (!destJson) {
      return;
    }

    let destinationRaw: unknown;
    try {
      destinationRaw = JSON.parse(destJson);
    } catch {
      logger.error('목적지 JSON 파싱 실패');
      return;
    }
    // destinationId 누락 시 trip 식별 불가 → 처리 중단. 정상 trip은 항상 id를 갖는다.
    if (
      !destinationRaw ||
      typeof destinationRaw !== 'object' ||
      typeof (destinationRaw as { id?: unknown }).id !== 'string'
    ) {
      logger.error('목적지에 id가 없음');
      return;
    }
    // 런타임 검증은 id 존재만 확인. Station 나머지 필드는 production write 시점에서 보장된다.
    const destination = destinationRaw as Station;
    const sleepMode = sleepJson ? JSON.parse(sleepJson) === true : false;
    const allowSpeaker = allowSpeakerJson ? JSON.parse(allowSpeakerJson) === true : true;
    // destinationId scoped — 이전 trip의 stale entry는 빈 set으로 반환된다(#462).
    const firedAlarms = await getFiredAlarms(destination.id);
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
        setFiredAlarms(destination.id, firedAlarms),
        AsyncStorage.setItem(ALARM_EVENT_KEY, JSON.stringify(alarmEvent)),
      ]);
    }

    logger.info('백그라운드 위치 업데이트 완료:', lat.toFixed(4), lng.toFixed(4));
  } catch (e) {
    logger.error('백그라운드 태스크 실패:', e);
  }
});
