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

/** #1779 — LA push 도달률 응답 bucket. */
export interface LaPushDeliveryBucket {
  sent: number;
  failed: number;
  ratio: number;
}

/**
 * #1958 — silent push 5min 윈도우 corrId(pushId) join 도달률 응답 bucket.
 *  - `sent` / `received` / `joined`: backend `silentPushReachMetric.ts` 참고.
 *  - `silentPushDeliveryRatio` (1h, received/(received+pending))와 별도 metric.
 *  - 미설정 backend는 `silentPushReachRatio` 필드 자체가 누락 — UI는 optional 로 가드.
 */
export interface SilentPushReachBucket {
  sent: number;
  received: number;
  joined: number;
  ratio: number;
}

/**
 * #1957 (#1503 잔여 1/3) — 알고리즘 정확성 응답 bucket.
 * value = yes(정답) 건수, total = yes+no, ratio = value/total (분모 0이면 0).
 * answeredTotal = yes+no+pending — 응답률 신호 (1주 30%+ acceptance).
 */
export interface AlgorithmAccuracyBucket {
  value: number;
  total: number;
  ratio: number;
  answeredTotal: number;
}

/**
 * #1972 (#1503 잔여 3/3) — lockless trip 종료 fire 0건 분기 응답 bucket.
 * miss = userIntent ON + fire 0건 (진짜 miss).
 * fired = fire ≥ 1건 (정상).
 * paradigmIntent = userIntent OFF + fire 0건 (paradigm intent, 분모/분자 제외).
 * ratio = miss / (miss + fired) — 분모 0이면 0.
 */
export interface LocklessTripMissBucket {
  miss: number;
  fired: number;
  paradigmIntent: number;
  ratio: number;
}

export interface ObservabilityMetrics {
  accuracyRatio: ObservabilityMetricsBucket;
  silentPushDeliveryRatio: ObservabilityMetricsBucket;
  locklessMissRatio: ObservabilityMetricsBucket;
  boardableMissRatio: ObservabilityMetricsBucket;
  /** #1769 — accelerometer pattern 4종 분포 (24h rolling window). */
  accelPatternHitRatio: AccelPatternBucket;
  /**
   * #1772 — silent push latency 분포 (1h 윈도우 근사치).
   * latencyMs stamp 있는 샘플만 집계. 샘플 0건이면 null.
   */
  silentPushLatency?: { p50: number; p95: number; totalSamples: number } | null;
  /** #1779 — LA push 도달률 (sent / (sent + failed), 24h rolling window). */
  laPushDeliveryRatio: LaPushDeliveryBucket;
  /**
   * #1958 — silent push 5min 윈도우 corrId(pushId) join 도달률.
   * 구 backend(필드 미응답) 호환 위해 optional — UI는 누락 시 placeholder 표시.
   */
  silentPushReachRatio?: SilentPushReachBucket;
  /**
   * #1957 (#1503 잔여 1/3) — 알고리즘 정확성. M2 정답지 응답 yes/(yes+no).
   * 신규 필드 — 구버전 backend는 미수신할 수 있으므로 optional.
   */
  algorithmAccuracyRatio?: AlgorithmAccuracyBucket;
  /**
   * #1972 (#1503 잔여 3/3) — lockless trip 종료 fire 0건 분기 비율.
   * source='lockless-trip-end' outcome 분기 누적. userIntent 분기로 진짜 miss vs paradigm 구분.
   * 신규 필드 — 구버전 backend는 미수신할 수 있으므로 optional.
   */
  locklessTripMissRatio?: LocklessTripMissBucket;
  window: '24h';
  timestamp: number;
}

export type FetchMetricsResult =
  | { kind: 'ok'; metrics: ObservabilityMetrics }
  | { kind: 'error'; message: string }
  | { kind: 'unconfigured' };

/**
 * 마지막 `fetchObservabilityMetrics()` 호출 결과 + 조회 시각 snapshot.
 * DebugModal share dump(#N)가 async poll 결과를 dump 시점에 sync로 읽기 위한 캐시 —
 * `OperationDashboardSection`이 마운트 시 이미 이 함수를 호출하므로 별도 polling 없이
 * side-effect로 채워진다.
 */
interface MetricsSnapshot {
  result: FetchMetricsResult;
  fetchedAtMs: number;
}

let lastMetricsSnapshot: MetricsSnapshot | null = null;

/**
 * 마지막 `fetchObservabilityMetrics()` 결과를 sync로 읽는다.
 * 한 번도 fetch가 완료되지 않았으면 null.
 */
export function getLastObservabilityMetricsSnapshot(): MetricsSnapshot | null {
  return lastMetricsSnapshot;
}

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
  const result = await fetchObservabilityMetricsUncached();
  lastMetricsSnapshot = { result, fetchedAtMs: Date.now() };
  return result;
}

async function fetchObservabilityMetricsUncached(): Promise<FetchMetricsResult> {
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
  /** 테스트 간 module-level snapshot 오염 방지용 리셋. */
  resetLastMetricsSnapshot(): void {
    lastMetricsSnapshot = null;
  },
};
