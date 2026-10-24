/**
 * 매역 알림 recall KPI telemetry (#919, Epic #912 A4).
 *
 * Trip 1건 종료 시 클라(`src/features/alarm/utils/recallMetrics.ts`)가 산출한 recall 결과를
 * Cloudflare Analytics Engine에 적재한다.
 *
 *   perStationAlarmRecall            : RateMetric (hit=firedStops, total=expectedStops)
 *                                       — 분자/분모 누적 → 일별/주별 recall % aggregate.
 *   gateSuppressionDistribution      : reason별 count 분해 (recall<100% trip 원인 자동 분류)
 *                                       — blob 라벨 `phase3:gateSuppressionDistribution:reason:<reason>`
 *
 * 운영 KPI: `MIN_RECALL_RATIO_THRESHOLD`(0.95) 미달 trip 비율이 대시보드에서 가시화된다.
 * Phase 4 결정 게이트와 분리 — 본 메트릭은 운영 회귀 감시용이라 `decidePhaseFour`에 포함하지 않는다.
 *
 * Privacy: 좌표/시각/원문 미적재. 카운트만. token은 8자 prefix만 익명 aggregate에 사용.
 *
 * Reason vocabulary는 client `recallMetrics.ts:GATE_SUPPRESSION_REASONS`의 양방향 SSOT —
 * client/backend 어느 쪽이 새 reason을 추가해도 반대편이 graceful drop(알 수 없는 reason은
 * dashboard에 노출 안 됨)한다. 정합은 PR review 시점에 갱신 책임.
 */

import { METRIC_KIND, writeMetricDataPoints, type RateMetric } from './metrics';
import { tokenPrefix } from './telemetry';
import type { AnalyticsEngineWriter } from './types';

/**
 * client `recallMetrics.ts:GATE_SUPPRESSION_REASONS`와 양방향 SSOT.
 * 본 배열에 없는 reason은 validate 단계에서 silently drop — 구버전 client / 신버전 client 호환.
 *
 * 새 reason 추가 절차:
 *   1) client `alarmLog.ts:AlarmLogReason`에 union 추가
 *   2) client `recallMetrics.ts:GATE_SUPPRESSION_REASONS`에 등록
 *   3) backend 본 배열에 등록 (이 PR에서 동시에 처리하는 게 안전)
 */
export const KNOWN_GATE_REASONS = [
  'gate-age',
  'gate-accuracy',
  'gate-jump',
  'gate-unknown-station',
  'gate-no-location',
  'gate-stale-location',
  'gate-out-of-range',
  'lock-line-mismatch',
  'payload-missing-kind',
  'movement-no-location',
  'movement-stale-timestamp',
  'movement-low-accuracy',
  'movement-static-speed',
  'movement-static-position',
  'movement-motion-stationary',
  'sleep-first-transfer',
  'lockless-non-intermediate',
  'lockless-opt-out',
  'dismiss-silence',
] as const;

export type KnownGateReason = (typeof KNOWN_GATE_REASONS)[number];

/** 운영 KPI: 본 비율 미만 trip이 alert 임계. catalog SSOT에서 노출. */
export const RECALL_DISTRIBUTION_LABEL_PREFIX = `${METRIC_KIND.GATE_SUPPRESSION_DISTRIBUTION}:reason`;

/**
 * client → backend upload payload.
 *   client `uploadRecallTelemetry`(api/telemetryBackend.ts)와 동일 schema.
 */
export interface RecallUpload {
  /** APNs device token (hex). 8자 prefix만 anonymous aggregate. */
  token: string;
  /** trip 시작 epoch ms. */
  tripStart: number;
  /** trip 종료 epoch ms. tripStart <= tripEnd 강제. */
  tripEnd: number;
  /** route 정차역 총 개수 (분모). */
  expectedStops: number;
  /** route 와 교집합인 fired 역 개수 (분자, 중복 제거). */
  firedStops: number;
  /** 0~100 정수. client에서 산출된 값 (서버 재계산 X — 표시용). */
  recallPct: number;
  /** 게이트별 차단 count. 알려진 reason만 보존. */
  gateSuppressionCounts: Partial<Record<KnownGateReason, number>>;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * `gateSuppressionCounts` 객체에서 알려진 reason만 자연수로 보존한다.
 *   - 객체 아니면 null
 *   - 알려진 reason 값이 자연수 아니면 null (전체 payload reject)
 *   - 미지 reason은 silently drop (구/신 클라이언트 호환)
 */
function parseGateCounts(raw: unknown): Partial<Record<KnownGateReason, number>> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const counts: Partial<Record<KnownGateReason, number>> = {};
  for (const reason of KNOWN_GATE_REASONS) {
    const v = obj[reason];
    if (v === undefined) continue;
    if (!isNonNegativeInt(v)) return null;
    counts[reason] = v;
  }
  return counts;
}

/**
 * payload 검증. 한 필드라도 깨졌으면 null — 호출자는 400 반환.
 *
 * 규칙:
 *   - token 비어있으면 reject
 *   - tripStart/tripEnd는 유한수 + tripStart <= tripEnd
 *   - expectedStops/firedStops는 자연수 (0 허용 — 동행 trip 가짜 신호는 isEmpty 가드가 client에 있음)
 *   - firedStops <= expectedStops
 *   - recallPct는 [0, 100] 정수
 *   - gateSuppressionCounts는 객체, 알려진 reason은 자연수만 보존, 미지 reason은 silently drop
 */
export function validateRecallUpload(input: unknown): RecallUpload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (!isFiniteNumber(obj.tripStart)) return null;
  if (!isFiniteNumber(obj.tripEnd)) return null;
  if (obj.tripEnd < obj.tripStart) return null;
  if (!isNonNegativeInt(obj.expectedStops)) return null;
  if (!isNonNegativeInt(obj.firedStops)) return null;
  if (obj.firedStops > obj.expectedStops) return null;
  if (!isNonNegativeInt(obj.recallPct) || obj.recallPct > 100) return null;
  const counts = parseGateCounts(obj.gateSuppressionCounts);
  if (counts === null) return null;

  return {
    token: obj.token,
    tripStart: obj.tripStart,
    tripEnd: obj.tripEnd,
    expectedStops: obj.expectedStops,
    firedStops: obj.firedStops,
    recallPct: obj.recallPct,
    gateSuppressionCounts: counts,
  };
}

/**
 * recall 1건을 AE에 적재.
 *
 *  1) `perStationAlarmRecall` rate metric — `writeMetricDataPoints` 통해
 *     `phase3:perStationAlarmRecall:hit` / `:total` 두 data point.
 *  2) `gateSuppressionDistribution` — 0보다 큰 reason 마다 data point 1건
 *     (label = `phase3:gateSuppressionDistribution:reason:<reason>`).
 *     Dashboard는 reason 별 sum으로 stacked bar 렌더.
 *
 * expectedStops=0 trip은 client가 `isEmptyRecall` 가드로 skip하므로 보통 도달하지 않지만,
 * 다른 client 버전이 보낼 가능성을 고려해 rate point는 graceful — 0값은 `writeMetricDataPoints`
 * 내부에서 skip된다.
 */
export function recordRecallUpload(
  writer: AnalyticsEngineWriter,
  payload: RecallUpload,
): void {
  const rate: RateMetric = {
    kind: METRIC_KIND.PER_STATION_ALARM_RECALL,
    hit: payload.firedStops,
    total: payload.expectedStops,
  };
  writeMetricDataPoints(writer, payload.token, rate);

  const prefix = tokenPrefix(payload.token);
  for (const reason of KNOWN_GATE_REASONS) {
    const count = payload.gateSuppressionCounts[reason] ?? 0;
    if (count <= 0) continue;
    writer.writeDataPoint({
      blobs: [`${RECALL_DISTRIBUTION_LABEL_PREFIX}:${reason}`, prefix],
      doubles: [count],
      indexes: [prefix],
    });
  }
}
