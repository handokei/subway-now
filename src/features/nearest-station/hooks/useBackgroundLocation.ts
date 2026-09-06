// 본 hook은 cross-feature orchestrator — useNavigationStore(`route` slice) +
// LOCATION_TRACKING_OPTIONS / locationTracking constants(`shared`)를 같이 소비한다.
// eslint-disable-next-line import/no-restricted-paths
import { useEffect } from 'react';
import { Alert, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { useTranslation } from 'react-i18next';
import type { Station } from '../../../shared/types/station';
import { BACKGROUND_LOCATION_TASK } from '../tasks/backgroundLocationTask';
import { LOCATION_TRACKING_OPTIONS } from '../../../shared/constants/locationTracking';
import { BG_PERMISSION_DENIED_DISMISSED_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
// #2344 (V8a) — BG task 콜백이 profile 전환(stop→start) 시 재사용할 foregroundService 텍스트 캐시.
import { saveForegroundServiceNotification, resetBgLocationProfile } from '../utils/bgLocationProfile';
// eslint-disable-next-line import/no-restricted-paths
import { useNavigationStore } from '../../route/store/useNavigationStore';

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

/**
 * #1973 — 안내 시작 버튼 명시 trigger 패러다임 (네이버 지도 패턴).
 *
 * destination이 설정돼도 자동으로 BG GPS를 시작하지 않는다. 사용자가 명시적으로
 * "안내 시작"을 탭해야 (`useNavigationStore.navigationActive=true`) BG 추적을 시작.
 *
 * 권한 단계화 (`requestForegroundPermissionsAsync` → `requestBackgroundPermissionsAsync`):
 *  1. Foreground (WhileInUse) — 거부 시 영구 dismiss 안내 + BG 추적 skip.
 *  2. Background (Always) — 선택 — 거부해도 진행. WhileInUse만 있어도 iOS는
 *     `allowsBackgroundLocationUpdates=true` + `showsBackgroundLocationIndicator=true`로
 *     명시 trigger 후 BG GPS 지속 + 파란 알약 표시를 허용한다.
 *  3. `startLocationUpdatesAsync` — 권한 하나라도 granted + navigationActive면 시작.
 */
export function useBackgroundLocation(destination: Station | null): void {
  const { t } = useTranslation();
  const navigationActive = useNavigationStore((s) => s.navigationActive);

  useEffect(() => {
    // 자동 trigger 차단: destination만 있고 navigationActive=false면 BG GPS 미시작 (paradigm).
    if (!destination || !navigationActive) {
      Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(noop);
      return;
    }

    let cancelled = false;

    (async () => {
      // Phase 1: Foreground (WhileInUse) — 최소 보장. 거부 시 BG 추적 자체 불가.
      const fg = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (fg.status !== 'granted') {
        logger.info('Foreground 위치 권한 거부됨 — BG 추적 skip');
        const dismissed = await isDeniedAlertDismissed();
        if (cancelled || dismissed) return;
        await markDeniedAlertDismissed();
        if (cancelled) return;
        Alert.alert(
          t('permissions.backgroundDeniedTitle'),
          t('permissions.backgroundDeniedBody'),
          [
            { text: t('common.close'), style: 'cancel' },
            { text: t('permissions.openSettings'), onPress: () => Linking.openSettings() },
          ],
        );
        return;
      }

      // Phase 2: Background (Always) — 선택. 거부해도 진행 (WhileInUse만 있어도 OK).
      // iOS `allowsBackgroundLocationUpdates=true`로 명시 trigger 후 BG GPS 지속 가능.
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (cancelled) return;
      if (bg.status !== 'granted') {
        logger.info('Background(Always) 권한 거부 — WhileInUse로 진행 (네이버 패턴)');
      }

      // Phase 3: startLocationUpdatesAsync — WhileInUse granted 시 시작.
      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
      if (isRegistered || cancelled) return;

      // foregroundService 알림 텍스트는 task 시작 시점 언어로 고정. 사용자가 추적 중 언어를
      // 바꿔도 GPS 추적 공백을 만들지 않기 위해 i18n.language를 deps에 두지 않는다.
      // 다음 destination 변경 시점에 자연스럽게 새 언어로 반영된다.
      const foregroundService = {
        notificationTitle: t('background.title'),
        notificationBody: t('background.body'),
      };
      // #2344 — BG task가 profile 전환(stop→start) 시 동일 텍스트로 재시작할 수 있도록 캐시.
      await saveForegroundServiceNotification(foregroundService);
      // 이 hook은 항상 surface 옵션으로 시작하므로 이전 trip의 stale 'stationary' 기록을 초기화한다.
      await resetBgLocationProfile();
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
        ...LOCATION_TRACKING_OPTIONS,
        foregroundService,
      });
      logger.info('백그라운드 위치 추적 시작 (navigationActive)');
    })();

    return () => {
      cancelled = true;
      Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(noop);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination?.id, navigationActive]);
}
