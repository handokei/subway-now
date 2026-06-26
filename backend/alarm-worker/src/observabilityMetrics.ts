/**
 * Observability Metrics Aggregator (#1752, #1503 Sub 2).
 *
 * 배경
 * ====
 * DebugModal(Sub 1)이 표시할 4가지 KPI를 1h 주기 cron이 집계해 KV에 적재한다.
 * endpoint `GET /v1/observability/metrics?window=24h`가 최신 집계 결과를 반환.
 *
 * 4 Metric
 * ========
 * 1. accuracyRatio     — alarmLog fired / (fired + suppressed) 비율 (last 24h R2 scan)
 * 2. silentPushDeliveryRatio — PENDING_PUSHES KV received / (received + pending) 근사치
 * 3. locklessMissRatio — alarmLog 중 lockless-forward-only-block reason 비율
 * 4. boardableMissRatio — placeholder (실효성 모호, 향후 데이터 소스 확보 후 실구현)
 *
 * 데이터 소스
 * ===========
 * - R2 (TELEMETRY_R2): `trip-evidence/` 아래 24h 윈도우 ndjson archive (alarmLog kind)
 * - KV (PENDING_PUSHES): `received:` / `pending:` prefix scan (1h TTL 근사치)
 *
 * KV 적재
 * =======
 * 키: `obs-metrics:24h:{hourBucket}` — hourBucket = floor(now / 1h). 1h TTL로 rolling window.
 * 1h cron 1건 × 24h = 하루 24 puts. KV puts/day 부담 최소.
 *
 * 한계
 * ====
 * - silentPushDeliveryRatio: PENDING_PUSHES KV TTL이 60s(pending)/1h(received)라
 *   정확한 24h 집계가 불가. 현재 창(1h) 기준 근사치.
 * - boardableMissRatio: device가 boardable train 가시성을 명시 forward하지 않아
 *   placeholder(0, total:0)으로 두고 0으로 반환.
 */

import { computeAlarmLogStats } from './alarmLogStats';
import { computePushAckStats } from './pushAckStats';
import { sumLaPushCounters } from './laPushCounters';

/** 집계 KV 키 prefix. */
const METRICS_KEY_PREFIX = 'obs-metrics:24h:';

/** 1h TTL — rolling window 다음 집계 전까지 캐시. */
const METRICS_KV_TTL_SEC = 60 * 60;

/**
 * #1889 RC-19 — KV day-limit 도달 시 fallback용 long-TTL "last-success" 캐시 키.
 *
 * 1h bucket 캐시(`obs-metrics:24h:{bucket}`)는 매 시간 키가 바뀌어 fallback으로 사용 불가.
 * 별도 고정 키에 24h TTL로 마지막 성공 응답을 보관 → KV write 실패/compute throw 시 endpoint가
 * stale 데이터로 fail-open할 수 있다.
 *
 * 키 1개 + 24h TTL 이므로 day-limit 부담은 hourly bucket과 동일(1h마다 1 put). 추가 list 호출 X.
 */
const METRICS_LAST_SUCCESS_KEY = 'obs-metrics:last-success';

/** 마지막 성공 캐시 TTL — 24h. day-limit 초과로 1h 연속 실패해도 fail-open 보장. */
const METRICS_LAST_SUCCESS_TTL_SEC = 24 * 60 * 60;

/** accel pattern 4종 분포 bucket. */
export interface AccelPatternBucket {
  automotive: { count: number; ratio: number };
  walking: { count: number; ratio: number };
  stationary: { count: number; ratio: number };
  unknown: { count: number; ratio: number };
}

/** /v1/observability/metrics 응답 shape. */
export interface ObservabilityMetricsResponse {
  accuracyRatio: { value: number; total: number; ratio: number };
  silentPushDeliveryRatio: { value: number; total: number; ratio: number };
  locklessMissRatio: { value: number; total: number; ratio: number };
  boardableMissRatio: { value: number; total: number; ratio: number };
  /** #1769 — accelerometer pattern 4종 분포 (24h rolling window). */
  accelPatternHitRatio: AccelPatternBucket;
  /**
   * #1772 — silent push latency 분포 (1h 윈도우 근사치 — PENDING_PUSHES KV TTL 제약).
   * latencyMs stamp 있는 샘플만 집계. 샘플 0건이면 null.
   */
  silentPushLatency: { p50: number; p95: number; totalSamples: number } | null;
  /** #1779 — LA push 도달률 (sent / (sent + failed), 24h rolling window). */
  laPushDeliveryRatio: { sent: number; failed: number; ratio: number };
  window: '24h';
  timestamp: number;
}

/**
 * 현재 시각의 1h bucket key 산출.
 * floor(now / 1h) — 같은 1h 윈도우 안에서는 동일 키.
 */
export function hourBucketKey(now: number): string {
  const bucket = Math.floor(now / (60 * 60 * 1000));
  return `${METRICS_KEY_PREFIX}${bucket}`;
}

/**
 * R2 alarmLog scan으로 metric 계산.
 *
 * @param r2 TELEMETRY_R2 bucket
 * @param pendingPushesKv PENDING_PUSHES KV namespace (optional)
 * @param now 현재 epoch ms
 * @param tripsKv TRIPS KV namespace — laPushDeliveryRatio 산출용 (optional, 미설정 시 placeholder)
 */
export async function computeObservabilityMetrics(
  r2: R2Bucket,
  pendingPushesKv: KVNamespace | undefined,
  now: number,
  tripsKv?: KVNamespace,
): Promise<ObservabilityMetricsResponse> {
  // 1. R2 alarmLog 24h scan — accuracyRatio + locklessMissRatio 원천
  const alarmStats = await computeAlarmLogStats(r2, now, 24, 500);

  const alarmTotal = alarmStats.fired + alarmStats.suppressed;
  const accuracyRatio = buildMetricBucket(alarmStats.fired, alarmTotal);

  const locklessMissCount = alarmStats.reasons['lockless-forward-only-block'] ?? 0;
  const locklessMissRatio = buildMetricBucket(locklessMissCount, alarmTotal);

  // 2. PENDING_PUSHES KV 1h 근사치 — silentPushDeliveryRatio + silentPushLatency 원천
  let silentPushDeliveryRatio: ObservabilityMetricsResponse['silentPushDeliveryRatio'];
  let silentPushLatency: ObservabilityMetricsResponse['silentPushLatency'] = null;
  if (pendingPushesKv !== undefined) {
    const pushStats = await computePushAckStats(pendingPushesKv, now, 500);
    const pushTotal = pushStats.received + pushStats.pending;
    silentPushDeliveryRatio = buildMetricBucket(pushStats.received, pushTotal);
    silentPushLatency = pushStats.silentPushLatency;
  } else {
    // binding 미설정 — graceful placeholder
    silentPushDeliveryRatio = buildMetricBucket(0, 0);
  }

  // 3. boardableMissRatio — placeholder (향후 데이터 소스 확보 후 실구현)
  const boardableMissRatio = buildMetricBucket(0, 0);

  // 4. accelPatternHitRatio — #1769. alarmLog source='accel-pattern-observed' 엔트리의
  // stationName 슬롯에 인코딩된 pattern(automotive/walking/stationary/unknown) 분포 산출.
  const accelPatternHitRatio = buildAccelPatternBucket(alarmStats.accelPatternCounts);

  // 5. #1779 — laPushDeliveryRatio. TRIPS KV la-push-counters:{bucket} 24h 합산.
  let laPushDeliveryRatio: ObservabilityMetricsResponse['laPushDeliveryRatio'];
  if (tripsKv !== undefined) {
    const laCounts = await sumLaPushCounters(tripsKv, now);
    const laTotal = laCounts.sent + laCounts.failed;
    laPushDeliveryRatio = {
      sent: laCounts.sent,
      failed: laCounts.failed,
      ratio: laTotal === 0 ? 0 : laCounts.sent / laTotal,
    };
  } else {
    laPushDeliveryRatio = { sent: 0, failed: 0, ratio: 0 };
  }

  return {
    accuracyRatio,
    silentPushDeliveryRatio,
    locklessMissRatio,
    boardableMissRatio,
    accelPatternHitRatio,
    silentPushLatency,
    laPushDeliveryRatio,
    window: '24h',
    timestamp: now,
  };
}

/**
 * 집계 결과를 TRIPS KV에 적재.
 * 키: `obs-metrics:24h:{hourBucket}`, TTL 1h.
 *
 * @param tripsKv TRIPS KV namespace
 * @param metrics 집계 결과
 * @param now 현재 epoch ms
 */
export async function storeObservabilityMetrics(
  tripsKv: KVNamespace,
  metrics: ObservabilityMetricsResponse,
  now: number,
): Promise<void> {
  const key = hourBucketKey(now);
  await tripsKv.put(key, JSON.stringify(metrics), { expirationTtl: METRICS_KV_TTL_SEC });
}

/**
 * #1889 RC-19 — KV write rate-limit gate + Sentry forward.
 *
 * 매분 cron / endpoint polling이 동시에 KV put을 호출하면 day-limit 초과 시 endpoint가 500
 * 응답 → dashboard "no data". 본 helper는 두 단계로 보호한다.
 *
 * 1. 1h bucket 키 + last-success 키 둘 다 put 시도. Cloudflare KV가 day-limit으로 reject 시
 *    swallow + breadcrumb. cron / endpoint 자체는 throw 없이 진행.
 * 2. last-success 키는 1h bucket과 별도 24h TTL을 유지 → 후속 read fallback의 SSoT.
 *
 * silent drop 금지 — KV write 실패 시 `onError(err)` 콜백으로 Sentry forward를 caller가 수행한다.
 * (sentry.ts는 backend-only이고 본 모듈을 unit test로 격리하려면 import 회피가 필요해 콜백 패턴.)
 *
 * @returns 두 키 모두 성공이면 `{ stored: true }`. 한 쪽이라도 실패면 `{ stored: false, error }`.
 */
export async function tryStoreObservabilityMetrics(
  tripsKv: KVNamespace,
  metrics: ObservabilityMetricsResponse,
  now: number,
  options?: { onError?: (err: unknown, key: string) => void },
): Promise<{ stored: boolean; error?: unknown }> {
  const onError = options?.onError;
  let firstError: unknown;
  // hourly bucket — 1h read cache.
  try {
    await storeObservabilityMetrics(tripsKv, metrics, now);
  } catch (err) {
    firstError = err;
    if (onError) onError(err, hourBucketKey(now));
  }
  // last-success — 24h fallback. 한 쪽 실패해도 다른 쪽은 시도.
  try {
    await tripsKv.put(METRICS_LAST_SUCCESS_KEY, JSON.stringify(metrics), {
      expirationTtl: METRICS_LAST_SUCCESS_TTL_SEC,
    });
  } catch (err) {
    if (firstError === undefined) firstError = err;
    if (onError) onError(err, METRICS_LAST_SUCCESS_KEY);
  }
  return firstError === undefined ? { stored: true } : { stored: false, error: firstError };
}

/**
 * #1889 RC-19 — 마지막 성공 응답 fallback.
 *
 * 1h bucket cache miss + compute throw (KV list day-limit / R2 outage) 시 endpoint가
 * dashboard "no data" 대신 stale 데이터를 응답할 수 있게 한다. KV read 자체가 throw 시 null
 * 반환 (caller가 503 응답).
 *
 * @returns 마지막 성공 응답 또는 null.
 */
export async function readLastSuccessfulMetrics(
  tripsKv: KVNamespace,
): Promise<ObservabilityMetricsResponse | null> {
  let raw: string | null;
  try {
    raw = await tripsKv.get(METRICS_LAST_SUCCESS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ObservabilityMetricsResponse;
  } catch {
    return null;
  }
}

/**
 * KV에서 최신 집계 결과를 읽는다.
 * 현재 1h bucket → 없으면 null.
 *
 * @param tripsKv TRIPS KV namespace
 * @param now 현재 epoch ms
 */
export async function readObservabilityMetrics(
  tripsKv: KVNamespace,
  now: number,
): Promise<ObservabilityMetricsResponse | null> {
  const key = hourBucketKey(now);
  const raw = await tripsKv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ObservabilityMetricsResponse;
  } catch {
    return null;
  }
}

/** value / total 기반 ratio bucket 산출 helper. total=0이면 ratio=0 (division-by-zero 방어). */
function buildMetricBucket(
  value: number,
  total: number,
): { value: number; total: number; ratio: number } {
  return {
    value,
    total,
    ratio: total === 0 ? 0 : value / total,
  };
}

/**
 * #1769 — accel pattern 4종 분포 bucket 산출.
 * 입력: alarmLogStats.accelPatternCounts (source='accel-pattern-observed' 기반).
 * total = 4종 합계. ratio = 각 pattern / total (total=0이면 0).
 */
function buildAccelPatternBucket(
  counts: { automotive: number; walking: number; stationary: number; unknown: number },
): AccelPatternBucket {
  const total = counts.automotive + counts.walking + counts.stationary + counts.unknown;
  const ratio = (n: number): number => (total === 0 ? 0 : n / total);
  return {
    automotive: { count: counts.automotive, ratio: ratio(counts.automotive) },
    walking: { count: counts.walking, ratio: ratio(counts.walking) },
    stationary: { count: counts.stationary, ratio: ratio(counts.stationary) },
    unknown: { count: counts.unknown, ratio: ratio(counts.unknown) },
  };
}
