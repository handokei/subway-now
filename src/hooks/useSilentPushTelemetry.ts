/**
 * silent push 게이트 outcome 텔레메트리 flush 훅 (#498).
 *
 * 알람 로그(silent-push-*)를 30분 주기 + 마운트 + AppState 'active' 진입 시
 * 백엔드 /telemetry/silent-push로 누적 upload한다.
 *
 * 동작 변경 없음 — 순수 측정 인프라.
 * APNs token이 없으면(권한 거부) silently skip → 데이터 0건.
 * Upload 실패 시 since(`TELEMETRY_LAST_FLUSH_KEY`)는 유지 → 다음 flush에서 재시도.
 *   재집계 시 알람 로그에 새 entries는 무한 누적되지 않고 ring buffer(200)로 trim되므로
 *   중복 위험은 한정적이다. 정확도보다 운영 단순성을 우선.
 */

import { useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { APNS_TOKEN_KEY, TELEMETRY_LAST_FLUSH_KEY } from '../constants/storageKeys';
import { getAlarmLog } from '../utils/alarmLog';
import {
  aggregateSilentPushEntries,
  isEmptyTelemetry,
} from '../utils/telemetryAggregation';
import { uploadSilentPushTelemetry } from '../api/telemetryBackend';
import { usePolling } from './usePolling';
import { createLogger } from '../utils/logger';

const log = createLogger('useSilentPushTelemetry');

export const TELEMETRY_FLUSH_INTERVAL_MS = 30 * 60 * 1000;

// 모듈 스코프 in-flight guard.
// flush는 since 읽기 → upload → since 쓰기로 비원자 R-M-W이다. mount/interval/AppState
// 'active' 트리거가 가까이 겹치면 동일 since를 두 호출이 읽어 같은 윈도우를 중복 upload할
// 위험이 있다 — 측정 인프라에서 중복 카운트는 데이터 해석을 왜곡한다.
// 진행 중이면 같은 promise를 재사용해 결과적으로 한 사이클 내 flush가 1회만 일어나게 한다.
let inFlight: Promise<void> | null = null;

/**
 * Visible-for-testing flush 1회 실행.
 * 호출자가 직접 부르지 않아도 훅이 mount/interval/resume 시점에 호출한다.
 * 동시 호출은 in-flight guard로 직렬화된다.
 */
export function flushSilentPushTelemetry(now: number = Date.now()): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = doFlush(now).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doFlush(now: number): Promise<void> {
  const token = await AsyncStorage.getItem(APNS_TOKEN_KEY);
  if (!token) {
    log.info('no APNs token — skip telemetry flush');
    return;
  }

  const sinceRaw = await AsyncStorage.getItem(TELEMETRY_LAST_FLUSH_KEY);
  const since = sinceRaw ? Number(sinceRaw) : 0;
  const safeSince = Number.isFinite(since) && since >= 0 ? since : 0;

  const entries = await getAlarmLog();
  const payload = aggregateSilentPushEntries(entries, safeSince, now);
  if (isEmptyTelemetry(payload)) {
    // 보낼 카운트가 없으면 since 갱신만 — 다음 flush 부담 감소.
    await AsyncStorage.setItem(TELEMETRY_LAST_FLUSH_KEY, String(now));
    return;
  }

  const result = await uploadSilentPushTelemetry(token, payload);
  if (result.ok) {
    await AsyncStorage.setItem(TELEMETRY_LAST_FLUSH_KEY, String(now));
  }
  // 실패 시 since 유지 — 다음 flush에서 재시도.
}

export function useSilentPushTelemetry(): void {
  const flush = useCallback(() => {
    void flushSilentPushTelemetry().catch((e) => log.warn('flush error', e));
  }, []);

  useEffect(() => {
    flush();
  }, [flush]);

  // onResume은 의도적으로 생략. usePolling은 AppState 'active' 전환 시 callback을
  // 자동 호출하므로, onResume까지 같은 flush로 두면 한 번의 resume에 2회 동시 호출되어
  // in-flight guard가 두 번째를 첫 번째 promise로 재사용하긴 하지만 호출 자체가 낭비.
  usePolling(flush, TELEMETRY_FLUSH_INTERVAL_MS);
}
