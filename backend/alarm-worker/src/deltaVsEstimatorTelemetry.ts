/**
 * Shadow Stage 1-3 vs server progress delta 텔레메트리 (#1174, Epic #1008 C 단기 B5 측정 인프라).
 *
 * Client(`useFusedNearestStation` 또는 estimator 호출자)가 같은 trip tick에서 server
 * `BffProgressResponse.waypointIndex`와 local `stationProgressEstimator`(Stage 1-3) 결과가
 * 모두 살아있을 때 `delta = |serverIdx - estimatorIdx|`(arc-index hop 단위)를 누적해
 * 폴링 윈도우 단위(또는 trip 종료 시점)로 본 엔드포인트로 업로드한다. backend는 단순 적재:
 *
 *   deltaVsEstimatorIndex : HistogramMetric (samples = arc-index hop 단위 abs delta)
 *                           → 1주 baseline P50/P95 산출. P95가 B5(server progress)
 *                             optional→required 승격 시 임계 결정 근거.
 *
 * Privacy: 좌표/station id/원문 미적재. 정수 hop delta만 적재. token 8자 prefix만
 * anonymous aggregate(serverProgressTelemetry / recallTelemetry / prescheduledTelemetry 동형).
 * Phase 4 결정 게이트와 분리된 운영 KPI — `decidePhaseFour`에 포함하지 않는다.
 *
 * 본 모듈은 client 측 shadow 비교 wiring과 파일 분리 — emit wiring은 후속 PR에서 본 모듈의
 * `recordDeltaVsEstimatorUpload`만 호출하면 된다(estimator/provider 본체 미수정,
 * #1173 PR 슬라이싱 패턴과 동일).
 */

import {
  METRIC_KIND,
  writeMetricDataPoints,
  type HistogramMetric,
} from './metrics';
import type { AnalyticsEngineWriter } from './types';

/** client → backend upload payload. */
export interface DeltaVsEstimatorUpload {
  /** APNs device token (hex). 8자 prefix만 anonymous aggregate. */
  token: string;
  /** 폴링 윈도우 시작 epoch ms. */
  windowStart: number;
  /** 폴링 윈도우 종료 epoch ms. windowStart <= windowEnd 강제. */
  windowEnd: number;
  /**
   * shadow tick별 `|serverWaypointIndex - estimatorIndex|`(arc-index hop 단위, 정수, ≥0) sample.
   * 두 신호가 모두 살아있던 tick 만큼 길이. 비유한/음수/비정수는 reject(전체 payload 거부).
   */
  deltaSamples: readonly number[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegativeInt(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
}

/**
 * delta sample 배열 검증 — 비음수 정수만 보존. 한 entry라도 비정상이면 전체 reject
 * (조용히 drop하지 않음 — 비정상 sample이 P50/P95를 오염시키지 않게).
 * `prescheduledTelemetry.parseDeltaSamples`와 동형이나 본 메트릭은 abs hop이라 음수도 reject.
 */
function parseDeltaSamples(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (!isNonNegativeInt(v)) return null;
    out.push(v);
  }
  return out;
}

/**
 * payload 검증. 한 필드라도 깨졌으면 null — 호출자는 400 반환.
 *
 * 규칙 (serverProgressTelemetry validateServerProgressUpload와 동형):
 *   - token 비어있으면 reject
 *   - windowStart/windowEnd는 유한수 + windowStart <= windowEnd
 *   - deltaSamples는 비음수 정수 배열 (한 entry라도 비정상이면 전체 reject)
 *   - 빈 배열 허용 (idle window — 호출자가 업로드 여부 결정)
 */
export function validateDeltaVsEstimatorUpload(input: unknown): DeltaVsEstimatorUpload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (!isFiniteNumber(obj.windowStart)) return null;
  if (!isFiniteNumber(obj.windowEnd)) return null;
  if (obj.windowEnd < obj.windowStart) return null;
  const samples = parseDeltaSamples(obj.deltaSamples);
  if (samples === null) return null;

  return {
    token: obj.token,
    windowStart: obj.windowStart,
    windowEnd: obj.windowEnd,
    deltaSamples: samples,
  };
}

/**
 * upload 1건을 AE에 적재. `writeMetricDataPoints`가 0값은 skip하므로 빈 배열은
 * 자동으로 noise free(count/mean/p95 모두 0이면 적재 안 됨).
 */
export function recordDeltaVsEstimatorUpload(
  writer: AnalyticsEngineWriter,
  payload: DeltaVsEstimatorUpload,
): void {
  const histogram: HistogramMetric = {
    kind: METRIC_KIND.DELTA_VS_ESTIMATOR_INDEX,
    samples: payload.deltaSamples,
  };
  writeMetricDataPoints(writer, payload.token, histogram);
}
