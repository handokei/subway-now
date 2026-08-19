/**
 * #2344 (V8a) — BG location 추적 프로파일 전환 인프라.
 *
 * expo-location은 옵션 라이브 변경이 불가하다 — 프로파일(surface↔stationary)을 바꾸려면
 * stopLocationUpdatesAsync → startLocationUpdatesAsync 재시작뿐이다. BG task는 React tree
 * 밖에서 도는 TaskManager 콜백이라, 이 재시작을 콜백 내부에서 자기호출로 수행한다
 * (코드베이스 선례 없음 — 실기기 검증 필요).
 *
 * 전환 지점을 이 모듈 하나로 일반화해 ②(accuracy 강등, #2345)가 동일 mechanism을 재사용한다.
 */
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createLogger } from '../../../shared/utils/logger';
import {
  locationTrackingOptionsForProfile,
  type BgLocationProfile,
} from '../../../shared/constants/locationTracking';
import {
  BG_LOCATION_PROFILE_KEY,
  BG_LOCATION_PROFILE_FLIP_COUNT_KEY,
  BG_FOREGROUND_SERVICE_TEXT_KEY,
} from '../../../shared/constants/storageKeys';

const logger = createLogger('BgLocationProfile');

// i18n `t()`에 접근할 수 없는 콜백 컨텍스트를 위한 폴백. 정상 흐름에서는 useBackgroundLocation이
// 항상 BG_FOREGROUND_SERVICE_TEXT_KEY를 먼저 적재하므로 이 값은 방어용으로만 쓰인다.
const FALLBACK_FOREGROUND_SERVICE_NOTIFICATION = {
  notificationTitle: 'Subway Now',
  notificationBody: 'Tracking your location',
} as const;

interface ForegroundServiceNotification {
  notificationTitle: string;
  notificationBody: string;
}

/**
 * useBackgroundLocation이 startLocationUpdatesAsync(surface 옵션)를 직접 호출해 task를 시작할
 * 때, 이전 trip에서 남은 stale 'stationary' 기록을 지운다. 이 초기화가 없으면 새 trip의 실제
 * 실행 옵션(surface)과 저장된 프로파일('stationary')이 어긋나 applyBgLocationProfile이 첫 tick에
 * 재시작을 건너뛰는(no-op 오판) 회귀가 생긴다.
 */
export async function resetBgLocationProfile(): Promise<void> {
  try {
    await AsyncStorage.setItem(BG_LOCATION_PROFILE_KEY, 'surface');
  } catch (e) {
    logger.warn('BG location profile 초기화 실패', e);
  }
}

/** useBackgroundLocation이 startLocationUpdatesAsync 호출 시 사용한 알림 텍스트를 저장한다. */
export async function saveForegroundServiceNotification(
  notification: ForegroundServiceNotification,
): Promise<void> {
  try {
    await AsyncStorage.setItem(BG_FOREGROUND_SERVICE_TEXT_KEY, JSON.stringify(notification));
  } catch (e) {
    logger.warn('foregroundService 텍스트 저장 실패', e);
  }
}

async function readForegroundServiceNotification(): Promise<ForegroundServiceNotification> {
  try {
    const raw = await AsyncStorage.getItem(BG_FOREGROUND_SERVICE_TEXT_KEY);
    if (!raw) return FALLBACK_FOREGROUND_SERVICE_NOTIFICATION;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as ForegroundServiceNotification).notificationTitle === 'string' &&
      typeof (parsed as ForegroundServiceNotification).notificationBody === 'string'
    ) {
      return parsed as ForegroundServiceNotification;
    }
    return FALLBACK_FOREGROUND_SERVICE_NOTIFICATION;
  } catch {
    return FALLBACK_FOREGROUND_SERVICE_NOTIFICATION;
  }
}

async function readCurrentProfile(): Promise<BgLocationProfile> {
  try {
    const raw = await AsyncStorage.getItem(BG_LOCATION_PROFILE_KEY);
    return raw === 'stationary' ? 'stationary' : 'surface';
  } catch {
    return 'surface';
  }
}

async function bumpFlipCount(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(BG_LOCATION_PROFILE_FLIP_COUNT_KEY);
    const parsed = Number(raw);
    const next = (Number.isFinite(parsed) ? parsed : 0) + 1;
    await AsyncStorage.setItem(BG_LOCATION_PROFILE_FLIP_COUNT_KEY, String(next));
    return next;
  } catch {
    return 0;
  }
}

/**
 * motion 신호로 결정된 desiredProfile을 현재 영속 프로파일과 비교해 다르면 stop→start로
 * 재시작한다. 같으면 no-op(매 tick 불필요한 재시작 방지 — 재시작 자체가 짧은 GPS 공백을 만든다).
 *
 * hysteresis: "정지 확정"은 motionStationary(CMMotionActivity) 신호가 이미 확정치를 제공하므로
 * 별도 debounce를 추가하지 않는다. "이동 재개 시 즉시 surface 복귀"도 동일 신호를 그대로
 * 반영하는 것으로 자연히 만족된다(비대칭 debounce가 필요 없음).
 */
export async function applyBgLocationProfile(
  taskName: string,
  desiredProfile: BgLocationProfile,
): Promise<void> {
  const currentProfile = await readCurrentProfile();
  if (currentProfile === desiredProfile) return;

  try {
    await Location.stopLocationUpdatesAsync(taskName);
    const foregroundService = await readForegroundServiceNotification();
    await Location.startLocationUpdatesAsync(taskName, {
      ...locationTrackingOptionsForProfile(desiredProfile),
      foregroundService,
    });
    await AsyncStorage.setItem(BG_LOCATION_PROFILE_KEY, desiredProfile);
    const flipCount = await bumpFlipCount();
    logger.info(
      `BG location profile 전환: ${currentProfile} → ${desiredProfile} (flip #${flipCount})`,
    );
  } catch (e) {
    logger.error('BG location profile 전환 실패', e);
  }
}
