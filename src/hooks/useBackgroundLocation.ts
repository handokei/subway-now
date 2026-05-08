import { useEffect } from 'react';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
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
        distanceInterval: 20,
        deferredUpdatesInterval: 3_000,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: '지하철 위치 감지 중',
          notificationBody: '백그라운드에서 현재 역을 추적하고 있습니다',
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
