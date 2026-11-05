/**
 * boarding-prompt 사용자 응답 telemetry (#827 / Part of #819).
 *
 * 9단 게이트 통과 후 발사된 "탑승했냐?" push에 사용자가 응답한 결과(boarded/dismissed)를
 * 백엔드가 카운트해 false positive율을 측정한다. dismiss는 silencedUntil 갱신용
 * `/boarding-prompt/dismiss` endpoint에서 trip 상태 변경을 따로 처리하므로, 본 endpoint는
 * 측정 목적 only.
 *
 * 카운트는 `metrics.ts`의 RateMetric (BOARDING_FALSE_POSITIVE)에 그대로 누적된다 —
 * total 분모는 '게이트 통과 발사', hit 분자는 '미탑승 dismiss'.
 */

import { METRIC_KIND, writeMetricDataPoints, type RateMetric } from './metrics';
import type { AnalyticsEngineWriter } from './types';

export type BoardingPromptOutcome = 'boarded' | 'dismissed';

export interface BoardingPromptOutcomePayload {
  /** APNs device token (hex). prefix(8자)만 anonymous aggregate에 사용. */
  token: string;
  outcome: BoardingPromptOutcome;
}

/**
 * payload 검증. token 빈 문자열/outcome 잘못된 값 reject.
 */
export function validateBoardingPromptOutcome(
  input: unknown,
): BoardingPromptOutcomePayload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (obj.outcome !== 'boarded' && obj.outcome !== 'dismissed') return null;
  return { token: obj.token, outcome: obj.outcome };
}

/**
 * outcome 한 건을 BOARDING_FALSE_POSITIVE rate metric으로 변환해 AE에 적재.
 *
 *   boarded   → total +1
 *   dismissed → total +1, hit +1 (false positive 분자)
 */
export function recordBoardingPromptOutcome(
  writer: AnalyticsEngineWriter,
  payload: BoardingPromptOutcomePayload,
): void {
  const hit = payload.outcome === 'dismissed' ? 1 : 0;
  const entry: RateMetric = {
    kind: METRIC_KIND.BOARDING_FALSE_POSITIVE,
    hit,
    total: 1,
  };
  writeMetricDataPoints(writer, payload.token, entry);
}
