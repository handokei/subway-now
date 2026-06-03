import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { processLocationUpdate } from '../utils/stationPipeline';
import { alarmKey } from '../utils/stationAlarm';
import { createLogger } from '../utils/logger';
import { DESTINATION_KEY, SLEEP_MODE_KEY, ALARM_EVENT_KEY, ROUTE_KEY, ALLOW_SPEAKER_KEY } from '../constants/storageKeys';
import { getFiredAlarms, setFiredAlarms } from '../utils/notificationState';
import { isAccuracyAcceptable, isLocationFresh, isPlausibleJump, type FixSample } from '../utils/locationGates';
import { logSuppressedGate } from '../utils/alarmLog';
import { BG_LAST_FIX_KEY, BG_LAST_STATION_KEY } from '../constants/storageKeys';
import type { Route } from '../utils/stationRoute';
import type { Station } from '../types/station';

const logger = createLogger('BackgroundLocation');

export const BACKGROUND_LOCATION_TASK = 'background-location-task';

async function readBgLastFix(): Promise<FixSample | null> {
  try {
    const raw = await AsyncStorage.getItem(BG_LAST_FIX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as FixSample).lat === 'number' &&
      typeof (parsed as FixSample).lng === 'number' &&
      typeof (parsed as FixSample).timestamp === 'number'
    ) {
      return parsed as FixSample;
    }
    return null;
  } catch {
    return null;
  }
}

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

    // #527: BG task 호출 간 직전 수용 fix를 AsyncStorage로 들고 시공간 일관성을 검증한다.
    // iOS deferred batch에서 stale 좌표가 섞여 들어오거나 OS가 부정확 fix를 보낼 때 발생하는
    // 비현실 점프(예: 25km/8s)를 drop. trip이 없을 땐 의미가 없어 destJson 통과 이후로 미룬다.
    const currFix: FixSample = { lat, lng, timestamp: latest.timestamp };
    const prevFix = await readBgLastFix();
    if (!isPlausibleJump(prevFix, currFix)) {
      logSuppressedGate('gate-jump', { lat, lng, accuracy, ageMs });
      return;
    }
    await AsyncStorage.setItem(BG_LAST_FIX_KEY, JSON.stringify(currFix));
    // destinationId scoped — 이전 trip의 stale entry는 빈 set으로 반환된다(#462).
    const firedAlarms = await getFiredAlarms(destination.id);
    const storedRoute: Route = routeJson ? JSON.parse(routeJson) : null;

    // lastNotifiedStationId는 stationPipeline 내부에서 notificationState 모듈을 통해
    // AsyncStorage에 직접 read/write 한다 (Foreground 훅과 단일 출처 공유).
    //
    // #784: arrivalAtOrigin / arrivalsAtTransfers를 BG에서 미전달 — calculateStaticETA는 DEFAULT_WAIT_MINUTES
    // fallback으로 흐른다. FG의 arrivalCache는 in-memory TtlCache(useArrivalInfo)라 BG 프로세스에서
    // 접근 불가하고, BG 전용 arrival 폴링은 OS quota 비용 대비 효익이 작다 — BG는 notification 본문
    // ETA 한 곳만 갱신. AsyncStorage 캐시 경로는 측정 결과 BG 정확도 ↑ 효과가 확인되면 후속 도입.
    const { alarmEvent, nearest } = await processLocationUpdate({
      lat,
      lng,
      destination,
      firedAlarms,
      sleepMode,
      allowSpeaker,
      storedRoute,
      speedMps,
      source: 'bg',
      // BG task는 fusion을 쓰지 않고 raw GPS만 처리 → 사용자에게 'GPS 추정'을 자백.
      // 실제 BG에서 train data를 쓰게 되면 caller에서 'position-train'으로 바꾼다.
      fusionSource: 'gps',
    });

    if (alarmEvent) {
      firedAlarms.add(alarmKey(alarmEvent));
      await Promise.all([
        setFiredAlarms(destination.id, firedAlarms),
        AsyncStorage.setItem(ALARM_EVENT_KEY, JSON.stringify(alarmEvent)),
      ]);
    }

    // #711: BG task가 평가한 nearest를 BG_LAST_STATION_KEY에 적재.
    // FG 복귀 시 useNearestStation이 fresh fix 도착 전 임시 hydrate에 사용한다.
    // null nearest(역 1km 밖)도 동일 정책으로 처리할 필요는 없다 — 메모리 상 result도 null로 보존됨이 자연스러움.
    if (nearest) {
      await AsyncStorage.setItem(
        BG_LAST_STATION_KEY,
        JSON.stringify({
          station: nearest.station,
          distanceKm: nearest.distanceKm,
          timestamp: latest.timestamp,
        }),
      );
    }

    logger.info('백그라운드 위치 업데이트 완료:', lat.toFixed(4), lng.toFixed(4));
  } catch (e) {
    logger.error('백그라운드 태스크 실패:', e);
  }
});
