/**
 * Silent push 파이프라인 각 단계 상태를 한 곳에 모은 진단 hook (#506).
 *
 * DebugModal에서 7탭으로 열어 즉시 확인 — Xcode 콘솔이나 wrangler tail 없이
 * release 빌드에서도 어디서 끊겼는지 좁힐 수 있다.
 *
 * 끊긴 위치 추정:
 *   - permissionStatus='denied'/'undetermined' → iOS 알림 권한 차단 (silent push도 차단)
 *   - apnsToken=null            → getDevicePushTokenAsync 실패 (entitlement/프로비저닝 등)
 *   - activeTripToken=null      → backend register 실패 또는 미시도
 *   - taskRegistration='failed' → registerTaskAsync 실패 (OS가 BG 콜백 안 함)
 *   - lastReceivedAt=null       → 토큰/등록 OK인데 클라가 push를 한 번도 못 받음
 *   - lastReceived>0, lastFired=0, lastSkipped>0 → 도달은 OK, 위치 게이트만 fail
 *
 * AppState active 전환 시 자동 refresh.
 */

import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import {
  APNS_TOKEN_KEY,
  ACTIVE_TRIP_KEY,
  ROUTE_KEY,
  DESTINATION_KEY,
  LAST_NOTIFIED_STATION_KEY,
} from '../../../shared/constants/storageKeys';
import { resolveApnsEnv, type ApnsEnv } from '../../../shared/utils/apnsEnv';
import { getAlarmLog, type AlarmLogSource } from '../utils/alarmLog';
import {
  getSilentPushRegistrationStatus,
  type SilentPushRegistrationState,
} from '../tasks/silentPushTask';

export interface SilentPushDiagnostics {
  apnsToken: string | null;
  activeTripToken: string | null;
  apnsEnv: ApnsEnv;
  /** iOS 알림 권한 상태 — 'undetermined'는 권한 요청 자체가 안 됐다는 신호. */
  permissionStatus: Notifications.PermissionStatus | null;
  taskRegistrationState: SilentPushRegistrationState;
  taskRegistrationError: string | null;
  lastReceivedAt: number | null;
  lastFiredAt: number | null;
  lastSkippedAt: number | null;
  /**
   * useApnsTripRegistration의 register effect 입력 진단용 (#506).
   * register는 route + destination 둘 다 있을 때만 호출되므로 어느 쪽이 null인지로
   * "register 미호출" 원인을 좁힐 수 있다.
   */
  hasRoute: boolean;
  destinationId: string | null;
  lastNotifiedStationId: string | null;
}

const EMPTY: SilentPushDiagnostics = {
  apnsToken: null,
  activeTripToken: null,
  apnsEnv: 'sandbox',
  permissionStatus: null,
  taskRegistrationState: 'unknown',
  taskRegistrationError: null,
  lastReceivedAt: null,
  lastFiredAt: null,
  lastSkippedAt: null,
  hasRoute: false,
  destinationId: null,
  lastNotifiedStationId: null,
};

// silent-push-* source → SilentPushDiagnostics 필드 매핑. 새 source 추가 시 여기 한 줄만.
type LastTsField = 'lastReceivedAt' | 'lastFiredAt' | 'lastSkippedAt';
const SOURCE_TO_FIELD: Partial<Record<AlarmLogSource, LastTsField>> = {
  'silent-push-received': 'lastReceivedAt',
  'silent-push-fired': 'lastFiredAt',
  'silent-push-skipped': 'lastSkippedAt',
};

export function useSilentPushDiagnostics(): SilentPushDiagnostics {
  const [diag, setDiag] = useState<SilentPushDiagnostics>(EMPTY);

  const refresh = useCallback(async () => {
    const [
      apnsToken,
      activeTripToken,
      logs,
      permission,
      routeJson,
      destinationJson,
      lastNotifiedStationId,
    ] = await Promise.all([
      AsyncStorage.getItem(APNS_TOKEN_KEY),
      AsyncStorage.getItem(ACTIVE_TRIP_KEY),
      getAlarmLog(),
      Notifications.getPermissionsAsync().catch(() => null),
      AsyncStorage.getItem(ROUTE_KEY),
      AsyncStorage.getItem(DESTINATION_KEY),
      AsyncStorage.getItem(LAST_NOTIFIED_STATION_KEY),
    ]);
    const reg = getSilentPushRegistrationStatus();
    // alarmLog는 최신순이 보장되지 않으므로 source별 최신 ts를 데이터 주도로 골라낸다.
    const latest: Record<LastTsField, number | null> = {
      lastReceivedAt: null,
      lastFiredAt: null,
      lastSkippedAt: null,
    };
    for (const entry of logs) {
      const field = SOURCE_TO_FIELD[entry.source];
      if (!field) continue;
      if (latest[field] == null || entry.ts > latest[field]!) latest[field] = entry.ts;
    }
    // destination은 JSON.stringify(Station). id 추출 실패 시 null로 graceful degrade.
    let destinationId: string | null = null;
    if (destinationJson) {
      try {
        const parsed = JSON.parse(destinationJson) as { id?: unknown };
        if (typeof parsed?.id === 'string') destinationId = parsed.id;
      } catch {
        // 깨진 entry는 무시 — 진단 표시만 빈 값.
      }
    }
    // #1011: lastNotifiedStationId는 { destinationId, stationId } JSON. stationId만 표시.
    // 이전 포맷(plain string) 또는 파싱 실패 시 raw 값으로 graceful degrade.
    let parsedLastNotifiedStationId: string | null = null;
    if (lastNotifiedStationId) {
      try {
        const parsed = JSON.parse(lastNotifiedStationId) as { stationId?: unknown };
        parsedLastNotifiedStationId =
          typeof parsed?.stationId === 'string' ? parsed.stationId : lastNotifiedStationId;
      } catch {
        parsedLastNotifiedStationId = lastNotifiedStationId;
      }
    }
    setDiag({
      apnsToken,
      activeTripToken,
      apnsEnv: resolveApnsEnv(),
      permissionStatus: permission?.status ?? null,
      taskRegistrationState: reg.state,
      taskRegistrationError: reg.error,
      ...latest,
      hasRoute: routeJson != null && routeJson.length > 0,
      destinationId,
      lastNotifiedStationId: parsedLastNotifiedStationId,
    });
  }, []);

  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  return diag;
}
