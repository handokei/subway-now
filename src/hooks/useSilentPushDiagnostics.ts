/**
 * Silent push 파이프라인 각 단계 상태를 한 곳에 모은 진단 hook (#506).
 *
 * DebugModal에서 7탭으로 열어 즉시 확인 — Xcode 콘솔이나 wrangler tail 없이
 * release 빌드에서도 어디서 끊겼는지 좁힐 수 있다.
 *
 * 끊긴 위치 추정:
 *   - apnsToken=null            → getDevicePushTokenAsync 실패 (권한 미동의 등)
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
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../constants/storageKeys';
import { resolveApnsEnv, type ApnsEnv } from '../utils/apnsEnv';
import { getAlarmLog } from '../utils/alarmLog';
import {
  getSilentPushRegistrationStatus,
  type SilentPushRegistrationState,
} from '../tasks/silentPushTask';

export interface SilentPushDiagnostics {
  apnsToken: string | null;
  activeTripToken: string | null;
  apnsEnv: ApnsEnv;
  taskRegistrationState: SilentPushRegistrationState;
  taskRegistrationError: string | null;
  lastReceivedAt: number | null;
  lastFiredAt: number | null;
  lastSkippedAt: number | null;
}

const EMPTY: SilentPushDiagnostics = {
  apnsToken: null,
  activeTripToken: null,
  apnsEnv: 'sandbox',
  taskRegistrationState: 'unknown',
  taskRegistrationError: null,
  lastReceivedAt: null,
  lastFiredAt: null,
  lastSkippedAt: null,
};

export function useSilentPushDiagnostics(): SilentPushDiagnostics {
  const [diag, setDiag] = useState<SilentPushDiagnostics>(EMPTY);

  const refresh = useCallback(async () => {
    const [apnsToken, activeTripToken, logs] = await Promise.all([
      AsyncStorage.getItem(APNS_TOKEN_KEY),
      AsyncStorage.getItem(ACTIVE_TRIP_KEY),
      getAlarmLog(),
    ]);
    const reg = getSilentPushRegistrationStatus();
    // alarmLog는 최신순이 보장되지 않으므로 source별 최신 ts를 따로 골라낸다.
    let lastReceivedAt: number | null = null;
    let lastFiredAt: number | null = null;
    let lastSkippedAt: number | null = null;
    for (const entry of logs) {
      if (entry.source === 'silent-push-received' && (lastReceivedAt == null || entry.ts > lastReceivedAt)) {
        lastReceivedAt = entry.ts;
      } else if (entry.source === 'silent-push-fired' && (lastFiredAt == null || entry.ts > lastFiredAt)) {
        lastFiredAt = entry.ts;
      } else if (entry.source === 'silent-push-skipped' && (lastSkippedAt == null || entry.ts > lastSkippedAt)) {
        lastSkippedAt = entry.ts;
      }
    }
    setDiag({
      apnsToken,
      activeTripToken,
      apnsEnv: resolveApnsEnv(),
      taskRegistrationState: reg.state,
      taskRegistrationError: reg.error,
      lastReceivedAt,
      lastFiredAt,
      lastSkippedAt,
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
