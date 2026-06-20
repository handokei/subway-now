/**
 * Trip telemetry forward (#1579, Phase 0 epic #1576 — P0-3).
 *
 * Trip 종료 시 device가 alarmLog 200 ring + fusionLog 200 + gpsDrops + backendSsotMirror
 * snapshot + deviceMetadata를 backend `POST /telemetry/alarm-log`로 forward한다. 백엔드는
 * 페이로드를 R2 `trip-evidence/YYYY/MM/DD/{tripTokenHash}.ndjson`로 적재해 운영자가
 * 4 trip evidence를 사용자 부담 없이 수집한다.
 *
 * 정책 (signalDumpBackend.ts 패턴 답습):
 *  - graceful — URL 미설정 / token 부재 / 짧은 trip(<30s) / payload 비었음 시 throw 안 함.
 *    critical path(trip-end recall + cleanup) 보호.
 *  - retry — 실패 시 단건 outbox에 enqueue. 다음 trip 종료 시 같은 함수가 outbox flush 시도.
 *    outbox는 가장 최근 1건만 보존(R2 archive는 evidence 수집이 목적, 누적 보관 불필요).
 *  - 짧은 trip skip — 30s 미만 trip은 R2 archive 가치보다 noise 비용이 커서 forward 안 함.
 *
 * 호출자: `triggerTripEndRecall` (fire-and-forget). cleanup 전에 호출되어야 alarmLog/fusionLog
 *   ring buffer가 유효 (cleanup이 `clearAlarmLogWindows`로 일부 모듈 in-memory 윈도우 reset).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import i18n from 'i18next';
import { TELEMETRY_FORWARD_RETRY_QUEUE_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
import {
  fetchWithTelemetryTimeout,
  getAlarmBackendUrl,
} from '../../../shared/utils/telemetryHttp';

const log = createLogger('telemetryForward');

/** 30s 미만 trip은 forward skip — R2 archive 가치보다 noise 비용이 크다. */
export const MIN_TRIP_DURATION_MS = 30_000;

export interface DeviceMetadata {
  os: 'ios' | 'android' | 'unknown';
  appVersion?: string;
  locale?: string;
}

export interface TelemetryForwardPayload {
  /** APNs device token. backend가 8자 prefix로 익명화해 R2 key/customMetadata에 적재. */
  token: string;
  /** trip 시작 epoch ms. R2 key의 YYYY/MM/DD partition 산출 기준. */
  tripStartedAt: number;
  /** trip 종료 epoch ms. customMetadata + 길이 게이트(>=30s) 산출. */
  tripEndedAt: number;
  /** alarmLog 200 ring buffer snapshot. */
  alarmLog: readonly unknown[];
  /** fusionLog 200 ring buffer snapshot. */
  fusionLog: readonly unknown[];
  /** GPS drop 100 ring buffer snapshot. */
  gpsDrops: readonly unknown[];
  /** backend SSoT mirror snapshot (또는 null — mirror 미존재 trip). */
  backendSsotSnapshot: unknown;
  /** OS / appVersion / locale 메타. */
  deviceMetadata: DeviceMetadata;
}

export interface TelemetryForwardResult {
  ok: boolean;
  /** URL 미설정 / token 부재 / 짧은 trip / 빈 payload로 호출이 건너뛰어진 경우 true. */
  skipped?: boolean;
  skipReason?:
    | 'no-url'
    | 'no-token'
    | 'trip-too-short'
    | 'empty-payload'
    | 'no-tripStart';
  status?: number;
}

interface OutboxEntry {
  payload: TelemetryForwardPayload;
}

/** 디바이스 메타 수집 — Platform / expo-constants / i18next. 모두 fallback 안전. */
export function buildDeviceMetadata(): DeviceMetadata {
  const os: DeviceMetadata['os'] =
    Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'unknown';
  const meta: DeviceMetadata = { os };
  const version = Constants.expoConfig?.version;
  if (typeof version === 'string' && version.length > 0) meta.appVersion = version;
  const locale = i18n.language;
  if (typeof locale === 'string' && locale.length > 0) meta.locale = locale;
  return meta;
}

async function readOutbox(): Promise<OutboxEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(TELEMETRY_FORWARD_RETRY_QUEUE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as OutboxEntry;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.payload ||
      typeof parsed.payload !== 'object' ||
      typeof parsed.payload.token !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch (e) {
    log.warn('outbox read error', e);
    return null;
  }
}

async function writeOutbox(entry: OutboxEntry): Promise<void> {
  try {
    await AsyncStorage.setItem(
      TELEMETRY_FORWARD_RETRY_QUEUE_KEY,
      JSON.stringify(entry),
    );
  } catch (e) {
    log.warn('outbox write error', e);
  }
}

async function clearOutbox(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TELEMETRY_FORWARD_RETRY_QUEUE_KEY);
  } catch (e) {
    log.warn('outbox clear error', e);
  }
}

function payloadIsEmpty(p: TelemetryForwardPayload): boolean {
  return (
    p.alarmLog.length === 0 &&
    p.fusionLog.length === 0 &&
    p.gpsDrops.length === 0 &&
    p.backendSsotSnapshot === null
  );
}

async function performForward(
  base: string,
  payload: TelemetryForwardPayload,
): Promise<TelemetryForwardResult> {
  try {
    const res = await fetchWithTelemetryTimeout(`${base}/telemetry/alarm-log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log.warn(`telemetry forward failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('telemetry forward error', e);
    return { ok: false };
  }
}

/**
 * Trip telemetry 1건 forward + outbox retain on failure.
 *
 * 1) Outbox에 직전 trip의 retry 항목이 있으면 먼저 flush 시도(성공/실패 무관, 결과는 무시).
 * 2) 신규 payload 검증 (URL/token/duration/empty) → 검증 실패 시 graceful skip.
 * 3) POST `/telemetry/alarm-log` → 성공 시 outbox clear, 실패 시 outbox에 enqueue.
 *
 * 절대 throw 안 한다 — trip-end critical path 보호.
 */
export async function forwardTripTelemetry(
  payload: TelemetryForwardPayload,
): Promise<TelemetryForwardResult> {
  const base = getAlarmBackendUrl();
  if (!base) {
    return { ok: false, skipped: true, skipReason: 'no-url' };
  }
  // 직전 trip retry — base가 있는 경우만 시도. 결과는 신규 forward와 독립.
  await flushPendingOutbox(base);

  if (!payload.token) {
    return { ok: false, skipped: true, skipReason: 'no-token' };
  }
  if (payload.tripStartedAt <= 0) {
    return { ok: false, skipped: true, skipReason: 'no-tripStart' };
  }
  if (payload.tripEndedAt - payload.tripStartedAt < MIN_TRIP_DURATION_MS) {
    return { ok: false, skipped: true, skipReason: 'trip-too-short' };
  }
  if (payloadIsEmpty(payload)) {
    return { ok: false, skipped: true, skipReason: 'empty-payload' };
  }

  const result = await performForward(base, payload);
  if (result.ok) {
    await clearOutbox();
  } else {
    await writeOutbox({ payload });
  }
  return result;
}

async function flushPendingOutbox(base: string): Promise<void> {
  const entry = await readOutbox();
  if (entry === null) return;
  const result = await performForward(base, entry.payload);
  if (result.ok) {
    await clearOutbox();
  }
}
