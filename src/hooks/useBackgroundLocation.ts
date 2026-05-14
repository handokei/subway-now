import { useEffect, useRef } from 'react';
import { Alert, Linking } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { useTranslation } from 'react-i18next';
import type { Station } from '../types/station';
import { BACKGROUND_LOCATION_TASK } from '../tasks/backgroundLocationTask';
import { LOCATION_TRACKING_OPTIONS } from '../constants/locationTracking';
import { createLogger } from '../utils/logger';

const logger = createLogger('BackgroundLocation');

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

export function useBackgroundLocation(destination: Station | null): void {
  const { t } = useTranslation();
  // 같은 hook 라이프타임에서 destination이 여러 번 바뀌어도 권한 안내 모달은 한 번만 노출한다.
  // 매번 띄우면 스팸성이 강하고, 사용자는 이미 첫 알림으로 결정한 상태다.
  const deniedAlertShownRef = useRef(false);

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
        if (status !== 'granted' && !cancelled && !deniedAlertShownRef.current) {
          deniedAlertShownRef.current = true;
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
