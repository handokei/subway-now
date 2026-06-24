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

/** 집계 KV 키 prefix. */
const METRICS_KEY_PREFIX = 'obs-metrics:24h:';

/** 1h TTL — rolling window 다음 집계 전까지 캐시. */
const METRICS_KV_TTL_SEC = 60 * 60;

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
 * R2 alarmLog scan으로 4 metric 계산.
 *
 * @param r2 TELEMETRY_R2 bucket
 * @param pendingPushesKv PENDING_PUSHES KV namespace (optional)
 * @param now 현재 epoch ms
 */
export async function computeObservabilityMetrics(
  r2: R2Bucket,
  pendingPushesKv: KVNamespace | undefined,
  now: number,
): Promise<ObservabilityMetricsResponse> {
  // 1. R2 alarmLog 24h scan — accuracyRatio + locklessMissRatio 원천
  const alarmStats = await computeAlarmLogStats(r2, now, 24, 500);

  const alarmTotal = alarmStats.fired + alarmStats.suppressed;
  const accuracyRatio = buildMetricBucket(alarmStats.fired, alarmTotal);

  const locklessMissCount = alarmStats.reasons['lockless-forward-only-block'] ?? 0;
  const locklessMissRatio = buildMetricBucket(locklessMissCount, alarmTotal);

  // 2. PENDING_PUSHES KV 1h 근사치 — silentPushDeliveryRatio 원천
  let silentPushDeliveryRatio: ObservabilityMetricsResponse['silentPushDeliveryRatio'];
  if (pendingPushesKv !== undefined) {
    const pushStats = await computePushAckStats(pendingPushesKv, now, 500);
    const pushTotal = pushStats.received + pushStats.pending;
    silentPushDeliveryRatio = buildMetricBucket(pushStats.received, pushTotal);
  } else {
    // binding 미설정 — graceful placeholder
    silentPushDeliveryRatio = buildMetricBucket(0, 0);
  }

  // 3. boardableMissRatio — placeholder (향후 데이터 소스 확보 후 실구현)
  const boardableMissRatio = buildMetricBucket(0, 0);

  // 4. accelPatternHitRatio — #1769. alarmLog source='accel-pattern-observed' 엔트리의
  // stationName 슬롯에 인코딩된 pattern(automotive/walking/stationary/unknown) 분포 산출.
  const accelPatternHitRatio = buildAccelPatternBucket(alarmStats.accelPatternCounts);

  return {
    accuracyRatio,
    silentPushDeliveryRatio,
    locklessMissRatio,
    boardableMissRatio,
    accelPatternHitRatio,
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
