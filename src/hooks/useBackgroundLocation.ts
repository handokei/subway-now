import { useEffect } from 'react';
import { Alert, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { useTranslation } from 'react-i18next';
import type { Station } from '../types/station';
import { BACKGROUND_LOCATION_TASK } from '../tasks/backgroundLocationTask';
import { LOCATION_TRACKING_OPTIONS } from '../shared/constants/locationTracking';
import { BG_PERMISSION_DENIED_DISMISSED_KEY } from '../shared/constants/storageKeys';
import { createLogger } from '../utils/logger';

const logger = createLogger('BackgroundLocation');

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

/**
 * BG 권한 거부 안내 Alert 노출 이력을 AsyncStorage에서 조회한다 (#791).
 * 키 부재/오류는 "안내 안 함"으로 간주 — 안내를 한 번 더 보는 비용 < 영구 스팸 비용.
 */
async function isDeniedAlertDismissed(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(BG_PERMISSION_DENIED_DISMISSED_KEY);
    return raw === 'true';
  } catch {
    return false;
  }
}

async function markDeniedAlertDismissed(): Promise<void> {
  try {
    await AsyncStorage.setItem(BG_PERMISSION_DENIED_DISMISSED_KEY, 'true');
  } catch (e) {
    logger.warn('BG 권한 안내 dismiss flag 저장 실패', e);
  }
}

export function useBackgroundLocation(destination: Station | null): void {
  const { t } = useTranslation();

  useEffect(() => {
    if (!destination) {
      Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(noop);
      return;
    }

    let cancelled = false;

    (async () => {
      const { status } = await Location.requestBackgroundPermissionsAsync();
      if (status !== 'granted' || cancelled) {
        logger.info('백그라운드 위치 권한 거부 또는 취소됨');
        if (status !== 'granted' && !cancelled) {
          // #791: 영구 dismiss 플래그를 AsyncStorage에서 확인. 한 번 안내를 받은 사용자에게
          // 매 destination 변경/앱 재시작마다 같은 Alert를 띄우는 것은 스팸 + WhileInUse 1차
          // 시나리오 정책 위반. dismiss 이력이 있으면 silent.
          const dismissed = await isDeniedAlertDismissed();
          if (cancelled || dismissed) return;
          await markDeniedAlertDismissed();
          // setItem await 동안 cleanup이 실행됐을 수 있음. dismissed 플래그는 storage에 들어가도
          // Alert 발사는 차단(정책: 누락 1회 허용 > 스팸).
          if (cancelled) return;
          Alert.alert(
            t('permissions.backgroundDeniedTitle'),
            t('permissions.backgroundDeniedBody'),
            [
              { text: t('common.close'), style: 'cancel' },
              { text: t('permissions.openSettings'), onPress: () => Linking.openSettings() },
            ],
          );
        }
        return;
      }

      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
      if (isRegistered || cancelled) return;

      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
        ...LOCATION_TRACKING_OPTIONS,
        // foregroundService 알림 텍스트는 task 시작 시점 언어로 고정. 사용자가 추적 중 언어를
        // 바꿔도 GPS 추적 공백을 만들지 않기 위해 i18n.language를 deps에 두지 않는다.
        // 다음 destination 변경 시점에 자연스럽게 새 언어로 반영된다.
        foregroundService: {
          notificationTitle: t('background.title'),
          notificationBody: t('background.body'),
        },
      });
      logger.info('백그라운드 위치 추적 시작');
    })();

    return () => {
      cancelled = true;
      Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(noop);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination?.id]);
}
