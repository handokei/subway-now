/**
 * Phase 3 fusion 효과 정량 측정 — baseline 지표 추상화 (#827).
 *
 * 기존 silent-push 텔레메트리(`telemetry.ts`)는 게이트 outcome 카운트만 다룬다.
 * 본 모듈은 Phase 3 epic(#818) 효과를 비교하기 위한 6종 핵심 지표를
 * data-driven 방식으로 집계 + Analytics Engine 적재한다. enum/객체 키 추가만으로
 * 새 지표를 등록할 수 있게 분리 — 호출 코드 변경 없이 항목이 늘어남.
 *
 * Phase 4 (Particle filter) 진행 결정 게이트:
 *   - 임박 알람 시점 오차 95p > SLA_LATE_THRESHOLD_MS → 진행 검토
 *   - false positive율 > FALSE_POSITIVE_RATIO_THRESHOLD → 진행 검토
 *   - 둘 다 미만이면 Phase 4 skip — ADR에 결정 근거 1회 stamp
 *
 * Privacy: 개별 위치/시각/원문은 적재하지 않는다. 카운트/히스토그램/통계량만.
 * token은 8자 prefix만 anonymous aggregate에 사용.
 */

import { tokenPrefix } from './telemetry';
import type { AnalyticsEngineWriter } from './types';

// ───────────────────────────────────────────────────────────────
// Phase 4 결정 임계 — 매직넘버 금지 (글로벌 CLAUDE.md 3번).
// ───────────────────────────────────────────────────────────────

/** 임박 알람 발사 vs 실제 도착 시각 95p 허용치(ms). 초과 시 Phase 4 검토. */
export const SLA_LATE_THRESHOLD_MS = 30_000;

/** false positive율 허용 상한(0~1). 초과 시 Phase 4 검토. */
export const FALSE_POSITIVE_RATIO_THRESHOLD = 0.05;

/** Phase 4 진행 여부 판정에 필요한 최소 표본 — 통계적 의미 확보용. */
export const MIN_SAMPLE_FOR_DECISION = 30;

// ───────────────────────────────────────────────────────────────
// 지표 카탈로그 — data-driven (글로벌 CLAUDE.md 3번).
// 새 지표 추가 = 객체 키 1개 추가. 호출/리포팅 코드 무수정.
// ───────────────────────────────────────────────────────────────

/**
 * Phase 3 핵심 지표 6종 (이슈 #827 본문 범위).
 *
 *   1. boardingFalsePositiveRate — 9단 게이트 통과 후 "미탑승" dismiss된 비율
 *   2. imminentSlaErrorMs        — 임박 알람 발사 vs 실제 도착 시각 차이 (히스토그램)
 *   3. stationPassedAccuracy     — 사전 예약 station-passed가 실제 통과와 일치한 비율
 *   4. phaseClassificationAccuracy — E3 4-class precision/recall (라벨링 가능 시)
 *   5. driftRecoveryMeters       — E4 GPS 회복 시점에 측정된 position 오차 (히스토그램)
 *   6. kalmanResidual            — E2 Kalman predict vs observe 차이 (히스토그램)
 */
export const METRIC_KIND = {
  BOARDING_FALSE_POSITIVE: 'boardingFalsePositiveRate',
  IMMINENT_SLA_ERROR: 'imminentSlaErrorMs',
  STATION_PASSED_ACCURACY: 'stationPassedAccuracy',
  PHASE_CLASSIFICATION_ACCURACY: 'phaseClassificationAccuracy',
  DRIFT_RECOVERY: 'driftRecoveryMeters',
  KALMAN_RESIDUAL: 'kalmanResidual',
} as const;

export type MetricKind = (typeof METRIC_KIND)[keyof typeof METRIC_KIND];

const METRIC_KINDS: readonly MetricKind[] = Object.values(METRIC_KIND);

/**
 * 비율형 지표 (0~1). hit / total 누적 → rate = hit / total.
 * total이 MIN_SAMPLE_FOR_DECISION 미만이면 의미 없는 표본으로 간주.
 */
export interface RateMetric {
  kind: MetricKind;
  hit: number;
  total: number;
}

/**
 * 히스토그램형 지표. observed 값을 그대로 받아 mean/p95/min/max 산출.
 * count가 MIN_SAMPLE_FOR_DECISION 미만이면 의미 없는 표본으로 간주.
 */
export interface HistogramMetric {
  kind: MetricKind;
  /** 최근 N개 sample. 호출자가 ring buffer로 보관할 수도, 모두 누적할 수도 있음. */
  samples: readonly number[];
}

export type MetricEntry = RateMetric | HistogramMetric;

/** RateMetric type guard. */
export function isRateMetric(entry: MetricEntry): entry is RateMetric {
  return 'total' in entry;
}

// ───────────────────────────────────────────────────────────────
// 통계량 — 외부 의존성 없음 (linear scan).
// ───────────────────────────────────────────────────────────────

/** sample 배열의 p95 — 정렬 후 ceil(0.95 * n) - 1 인덱스. 빈 배열은 0. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  if (p < 0 || p > 1) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** sample 배열 평균. 빈 배열은 0. */
export function mean(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const v of samples) sum += v;
  return sum / samples.length;
}

/** RateMetric → 0~1 비율. total=0이면 0. */
export function rate(metric: RateMetric): number {
  if (metric.total === 0) return 0;
  return metric.hit / metric.total;
}

// ───────────────────────────────────────────────────────────────
// 요약 — Phase 4 결정 입력에 그대로 사용.
// ───────────────────────────────────────────────────────────────

export interface MetricSummary {
  kind: MetricKind;
  /** RateMetric인 경우 rate, HistogramMetric인 경우 mean. */
  value: number;
  /** 히스토그램 한정 — RateMetric은 0. */
  p95: number;
  /** 표본 수 (rate=total, histogram=count). */
  count: number;
  /**
   * MIN_SAMPLE_FOR_DECISION 충족 여부 — Phase 4 결정 게이트 입력.
   * false면 위 value/p95는 표본 부족으로 무시해야 한다.
   */
  significant: boolean;
}

/**
 * 단일 지표 요약. 호출자가 호출 시점에 한 번 계산해 perf-report/decision 양쪽에 전달.
 */
export function summarizeMetric(entry: MetricEntry): MetricSummary {
  if (isRateMetric(entry)) {
    return {
      kind: entry.kind,
      value: rate(entry),
      p95: 0,
      count: entry.total,
      significant: entry.total >= MIN_SAMPLE_FOR_DECISION,
    };
  }
  return {
    kind: entry.kind,
    value: mean(entry.samples),
    p95: percentile(entry.samples, 0.95),
    count: entry.samples.length,
    significant: entry.samples.length >= MIN_SAMPLE_FOR_DECISION,
  };
}

// ───────────────────────────────────────────────────────────────
// Phase 4 결정 게이트.
// ───────────────────────────────────────────────────────────────

export interface PhaseFourDecisionInputs {
  /** boardingFalsePositiveRate 요약 — RateMetric 기반. */
  falsePositive: MetricSummary;
  /** imminentSlaErrorMs 요약 — HistogramMetric 기반. */
  imminentSla: MetricSummary;
}

export interface PhaseFourDecision {
  /** true = Phase 4 검토 권장 (임계 초과). false = skip 권장. */
  proceed: boolean;
  /** 의미 있는 표본이 한쪽이라도 부족하면 결정 보류. */
  insufficientSamples: boolean;
  /** 어느 지표가 임계를 넘었는지 — ADR stamp 근거 기록용. */
  triggers: ReadonlyArray<'falsePositive' | 'imminentSla'>;
}

/**
 * Phase 4 (Particle filter) 진행 여부 판정.
 *
 * 둘 다 의미 있는 표본을 갖춰야 결정 — 한쪽이라도 부족하면 보류 (proceed=false,
 * insufficientSamples=true). triggers 배열은 데이터 주도로 임계 위반 지표를 모두 수집해
 * ADR에 일괄 기록 가능.
 */
export function decidePhaseFour(inputs: PhaseFourDecisionInputs): PhaseFourDecision {
  const insufficient = !inputs.falsePositive.significant || !inputs.imminentSla.significant;
  if (insufficient) {
    return { proceed: false, insufficientSamples: true, triggers: [] };
  }
  const triggers: Array<'falsePositive' | 'imminentSla'> = [];
  if (inputs.falsePositive.value > FALSE_POSITIVE_RATIO_THRESHOLD) {
    triggers.push('falsePositive');
  }
  if (inputs.imminentSla.p95 > SLA_LATE_THRESHOLD_MS) {
    triggers.push('imminentSla');
  }
  return {
    proceed: triggers.length > 0,
    insufficientSamples: false,
    triggers,
  };
}

// ───────────────────────────────────────────────────────────────
// Analytics Engine 적재 — telemetry.ts와 동일 schema, 별도 label namespace.
// ───────────────────────────────────────────────────────────────

/** AE 적재 label prefix — 기존 silent-push 텔레메트리와 namespace 분리. */
const METRIC_LABEL_PREFIX = 'phase3';

/**
 * MetricEntry 한 건을 AE에 적재. RateMetric은 hit/total 두 point,
 * HistogramMetric은 count/mean/p95 세 point로 분해해 query하기 쉽게.
 *
 * Schema:
 *   blob1 = `${prefix}:${kind}:${field}` (예: phase3:boardingFalsePositiveRate:hit)
 *   blob2 = token prefix (8자)
 *   double1 = value
 *   index1 = token prefix (sampling용)
 *
 * 0값은 skip — query 노이즈 감소. token이 빈 문자열인 경우(서버 합산 등) prefix 그대로.
 */
export function writeMetricDataPoints(
  writer: AnalyticsEngineWriter,
  token: string,
  entry: MetricEntry,
): void {
  const prefix = tokenPrefix(token);
  const write = (field: string, value: number): void => {
    if (value <= 0) return;
    writer.writeDataPoint({
      blobs: [`${METRIC_LABEL_PREFIX}:${entry.kind}:${field}`, prefix],
      doubles: [value],
      indexes: [prefix],
    });
  };

  if (isRateMetric(entry)) {
    write('hit', entry.hit);
    write('total', entry.total);
    return;
  }
  const summary = summarizeMetric(entry);
  write('count', summary.count);
  write('mean', summary.value);
  write('p95', summary.p95);
}

// ───────────────────────────────────────────────────────────────
// payload validation — perf-report CLI / HTTP endpoint 공용.
// ───────────────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && Number.isInteger(value);
}

function isKnownKind(value: unknown): value is MetricKind {
  return typeof value === 'string' && METRIC_KINDS.includes(value as MetricKind);
}

/**
 * 외부에서 들어온 단일 MetricEntry payload 검증.
 * - kind는 카탈로그 등록된 값만 허용
 * - rate는 hit/total 자연수
 * - histogram은 samples가 유한수 배열
 */
export function validateMetricEntry(input: unknown): MetricEntry | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (!isKnownKind(obj.kind)) return null;
  // rate 우선 — total 필드 존재로 분기.
  if ('total' in obj) {
    if (!isNonNegativeInt(obj.hit) || !isNonNegativeInt(obj.total)) return null;
    if (obj.hit > obj.total) return null;
    return { kind: obj.kind, hit: obj.hit, total: obj.total };
  }
  if (!Array.isArray(obj.samples)) return null;
  const samples: number[] = [];
  for (const v of obj.samples) {
    if (!isFiniteNumber(v)) return null;
    samples.push(v);
  }
  return { kind: obj.kind, samples };
}

/**
 * MetricEntry 배열 일괄 검증. 하나라도 깨졌으면 null — 호출자는 400으로.
 */
export function validateMetricBatch(input: unknown): MetricEntry[] | null {
  if (!Array.isArray(input)) return null;
  const out: MetricEntry[] = [];
  for (const raw of input) {
    const entry = validateMetricEntry(raw);
    if (!entry) return null;
    out.push(entry);
  }
  return out;
}
