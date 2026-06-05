/**
 * alarm-worker /telemetry/silent-push 클라이언트 (#498).
 *
 * 클라가 30분 주기로 alarmLog 카운터를 누적 upload — 실패 시 graceful skip.
 * 동작 변경 없음 — 순수 측정 인프라.
 */

import type { SilentPushTelemetryPayload } from '../utils/telemetryAggregation';
import type { TripRecallResult } from '../utils/recallMetrics';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('telemetryBackend');

export interface TelemetryUploadResult {
  ok: boolean;
  /** URL 미설정 등으로 호출이 건너뛰어진 경우 true. */
  skipped?: boolean;
  status?: number;
}

/** fetch 타임아웃 — 텔레메트리는 후속 알람 흐름에 영향 주지 않게 짧게 끊는다. */
const REQUEST_TIMEOUT_MS = 5000;

function getBackendUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadSilentPushTelemetry(
  token: string,
  payload: SilentPushTelemetryPayload,
): Promise<TelemetryUploadResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip telemetry upload');
    return { ok: false, skipped: true };
  }
  if (!token) {
    return { ok: false, skipped: true };
  }

  const body = {
    token,
    since: payload.since,
    until: payload.until,
    received: payload.received,
    fired: payload.fired,
    skipped: payload.skipped,
    skipReasons: payload.skipReasons,
  };

  try {
    const res = await fetchWithTimeout(`${base}/telemetry/silent-push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn(`telemetry upload failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('telemetry upload error', e);
    return { ok: false };
  }
}

/**
 * 매역 알림 recall KPI 1건을 backend `/telemetry/recall` 로 upload 한다 (#919, Epic #912 A4).
 *
 * silent push telemetry 와 같은 graceful 정책:
 *   - URL 미설정 / token 빈 → skipped=true (no-op)
 *   - 실패 시 호출자에 ok=false 반환, throw 안 함.
 *
 * backend endpoint 자체 구현은 별도 PR (이번 PR 은 client 만).
 */
export async function uploadRecallTelemetry(
  token: string,
  recall: TripRecallResult,
): Promise<TelemetryUploadResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip recall upload');
    return { ok: false, skipped: true };
  }
  if (!token) {
    return { ok: false, skipped: true };
  }

  const body = {
    token,
    tripStart: recall.tripStart,
    tripEnd: recall.tripEnd,
    expectedStops: recall.expectedStops,
    firedStops: recall.firedStops,
    recallPct: recall.recallPct,
    gateSuppressionCounts: recall.gateSuppressionCounts,
  };

  try {
    const res = await fetchWithTimeout(`${base}/telemetry/recall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn(`recall upload failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('recall upload error', e);
    return { ok: false };
  }
}
