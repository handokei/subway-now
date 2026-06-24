/**
 * Observability metrics polling client (#1753, #1503 Sub 3).
 *
 * DebugModal 진입 시 1회 `/v1/observability/metrics?window=24h`를 호출하고,
 * 사용자 refresh 버튼 트리거 시 재요청한다. 지속 polling 없음 (배터리 절약).
 *
 * ADMIN_TOKEN / ALARM_BACKEND_URL 미설정 시 null 반환 — 호출자가 안내 메시지 표시.
 */

import { fetchWithTelemetryTimeout, getAlarmBackendUrl } from '../../../shared/utils/telemetryHttp';

/** /v1/observability/metrics 응답 shape (Sub 2 `ObservabilityMetricsResponse`와 동일). */
export interface ObservabilityMetricsBucket {
  value: number;
  total: number;
  ratio: number;
}

/** #1769 — accelerometer pattern 4종 분포 (count + ratio). */
export interface AccelPatternBucket {
  automotive: { count: number; ratio: number };
  walking: { count: number; ratio: number };
  stationary: { count: number; ratio: number };
  unknown: { count: number; ratio: number };
}

export interface ObservabilityMetrics {
  accuracyRatio: ObservabilityMetricsBucket;
  silentPushDeliveryRatio: ObservabilityMetricsBucket;
  locklessMissRatio: ObservabilityMetricsBucket;
  boardableMissRatio: ObservabilityMetricsBucket;
  /** #1769 — accelerometer pattern 4종 분포 (24h rolling window). */
  accelPatternHitRatio: AccelPatternBucket;
  window: '24h';
  timestamp: number;
}

export type FetchMetricsResult =
  | { kind: 'ok'; metrics: ObservabilityMetrics }
  | { kind: 'error'; message: string }
  | { kind: 'unconfigured' };

/** ADMIN_TOKEN 환경변수 조회. 미설정 시 null. */
function getAdminToken(): string | null {
  const token = process.env.EXPO_PUBLIC_ADMIN_TOKEN;
  if (!token) return null;
  return token;
}

/**
 * `/v1/observability/metrics?window=24h` 단건 fetch.
 *
 * - ADMIN_TOKEN 미설정 → `{ kind: 'unconfigured' }`
 * - ALARM_BACKEND_URL 미설정 → `{ kind: 'unconfigured' }`
 * - HTTP 오류 / network 실패 → `{ kind: 'error', message }`
 * - 성공 → `{ kind: 'ok', metrics }`
 */
export async function fetchObservabilityMetrics(): Promise<FetchMetricsResult> {
  const token = getAdminToken();
  if (!token) return { kind: 'unconfigured' };

  const base = getAlarmBackendUrl();
  if (!base) return { kind: 'unconfigured' };

  try {
    const res = await fetchWithTelemetryTimeout(
      `${base}/v1/observability/metrics?window=24h`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (!res.ok) {
      return { kind: 'error', message: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as ObservabilityMetrics;
    return { kind: 'ok', metrics: body };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { kind: 'error', message };
  }
}

// Internal exports for tests — DO NOT use from app code.
export const __test__ = {
  getAdminToken,
};
