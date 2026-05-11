import { useEffect } from 'react';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import i18next from 'i18next';
import type { Station } from '../types/station';
import { BACKGROUND_LOCATION_TASK } from '../tasks/backgroundLocationTask';
import { createLogger } from '../utils/logger';

const logger = createLogger('BackgroundLocation');

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

export function useBackgroundLocation(destination: Station | null): void {
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
        return;
      }

      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
      if (isRegistered || cancelled) return;

      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
        accuracy: Location.Accuracy.High,
        // 매 역 통과 시점 알림을 위해 iOS가 GPS 업데이트를 가장 공격적으로 유지하도록 차량 내비 프로필을 사용한다.
        activityType: Location.LocationActivityType.AutomotiveNavigation,
        // 지하 정차/터널에서 GPS가 약해질 때 iOS가 stationary로 오판해 업데이트를 멈추면 알림이 누락되므로 명시적으로 끈다.
        pausesUpdatesAutomatically: false,
        distanceInterval: 20,
        showsBackgroundLocationIndicator: true,
        // foregroundService 텍스트는 서비스 시작 시점에 OS에 고정됨.
        // 런타임 언어 변경 반영은 Phase 5(알림 채널/포그라운드 서비스 마이그레이션)에서 처리.
        foregroundService: {
          notificationTitle: i18next.t('background.title'),
          notificationBody: i18next.t('background.body'),
        },
      });
      logger.info('백그라운드 위치 추적 시작');
    })();

    return () => {
      cancelled = true;
      Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(noop);
    };
  }, [destination?.id]);
}
