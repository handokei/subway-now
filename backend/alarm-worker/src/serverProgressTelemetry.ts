/**
 * BFF `/progress` 폴링 수신율 텔레메트리 (#1173, Epic #1008 C 단기 B5 측정 인프라).
 *
 * Client(`SeoulBffProgressProvider` 등)가 폴링 윈도우(예: 1분/5분 단위 또는 trip 종료 시점)에서
 * 시도/수신 카운트를 집계해 본 엔드포인트로 업로드한다. backend는 단순 적재:
 *
 *   serverProgressReceived : RateMetric (hit=received, total=attempts)
 *                            → MIN_SERVER_PROGRESS_RECEIVED_RATIO(0.95) 미달 시 backend down/
 *                              네트워크 회귀 운영 신호. 95% 충족이 B5 optional→required 승격 게이트.
 *
 * Privacy: 좌표/URL/원문 미적재. token 8자 prefix만 anonymous aggregate(recallTelemetry 동형).
 * Phase 4 결정 게이트와 분리된 운영 KPI — `decidePhaseFour`에 포함하지 않는다.
 *
 * 본 모듈은 `SeoulBffProgressProvider`(#1172 진행 중)와 파일 분리 — emit wiring은 후속 PR에서
 * 본 모듈의 `recordServerProgressUpload`만 호출하면 된다(provider 본체 미수정).
 */

import { METRIC_KIND, writeMetricDataPoints, type RateMetric } from './metrics';
import type { AnalyticsEngineWriter } from './types';

/** client → backend upload payload. */
export interface ServerProgressUpload {
  /** APNs device token (hex). 8자 prefix만 anonymous aggregate. */
  token: string;
  /** 폴링 윈도우 시작 epoch ms. */
  windowStart: number;
  /** 폴링 윈도우 종료 epoch ms. windowStart <= windowEnd 강제. */
  windowEnd: number;
  /** `/progress` 호출 시도 총 횟수 (분모). */
  attempts: number;
  /** 2xx 응답 수신 횟수 (분자). attempts 이하 강제. */
  received: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegativeInt(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
}

/**
 * payload 검증. 한 필드라도 깨졌으면 null — 호출자는 400 반환.
 *
 * 규칙 (recallTelemetry validateRecallUpload와 동형):
 *   - token 비어있으면 reject
 *   - windowStart/windowEnd는 유한수 + windowStart <= windowEnd
 *   - attempts/received는 자연수
 *   - received <= attempts
 */
export function validateServerProgressUpload(input: unknown): ServerProgressUpload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (!isFiniteNumber(obj.windowStart)) return null;
  if (!isFiniteNumber(obj.windowEnd)) return null;
  if (obj.windowEnd < obj.windowStart) return null;
  if (!isNonNegativeInt(obj.attempts)) return null;
  if (!isNonNegativeInt(obj.received)) return null;
  if (obj.received > obj.attempts) return null;

  return {
    token: obj.token,
    windowStart: obj.windowStart,
    windowEnd: obj.windowEnd,
    attempts: obj.attempts,
    received: obj.received,
  };
}

/**
 * upload 1건을 AE에 적재. `writeMetricDataPoints`가 0값은 skip하므로 attempts=0 윈도우는
 * 자동으로 noise free(rate hit/total 두 포인트 모두 0이면 적재 안 됨).
 */
export function recordServerProgressUpload(
  writer: AnalyticsEngineWriter,
  payload: ServerProgressUpload,
): void {
  const rate: RateMetric = {
    kind: METRIC_KIND.SERVER_PROGRESS_RECEIVED,
    hit: payload.received,
    total: payload.attempts,
  };
  writeMetricDataPoints(writer, payload.token, rate);
}
