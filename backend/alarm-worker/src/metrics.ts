/**
 * Phase 3 fusion 효과 정량 측정 — baseline 지표 추상화 (#827).
 *
 * 기존 silent-push 텔레메트리(`telemetry.ts`)는 게이트 outcome 카운트만 다룬다.
 * 본 모듈은 Phase 3 epic(#818) 효과를 비교하기 위한 핵심 지표를
 * **데이터 주도(카탈로그 JSON)** 방식으로 집계 + Analytics Engine 적재한다.
 *
 *   카탈로그 = `metrics.catalog.json` (SSOT — perf-report.js와 공유)
 *   새 지표 등록 = JSON 객체 1개 추가 (호출/리포팅/결정 코드 무수정)
 *   새 게이트 등록 = 객체에 `gate` 필드 1개 추가
 *
 * Phase 4 (Particle filter) 진행 결정 게이트는 카탈로그의 `gate` 메타를 순회해
 * 임계 위반 트리거를 자동 수집한다. if 체인 0건.
 *
 * Privacy: 개별 위치/시각/원문은 적재하지 않는다. 카운트/히스토그램/통계량만.
 * token은 8자 prefix만 anonymous aggregate에 사용.
 */

import catalog from './metrics.catalog.json';
import { tokenPrefix } from './telemetry';
import type { AnalyticsEngineWriter } from './types';

// ───────────────────────────────────────────────────────────────
// 카탈로그 타입 — JSON SSOT를 컴파일 타임에 강타입화.
// ───────────────────────────────────────────────────────────────

type GateOperator = '>';
type GateField = 'value' | 'p95';
type MetricFormat = 'rate' | 'histogram';

interface GateMeta {
  field: GateField;
  op: GateOperator;
  thresholdConst: ConstantName;
  triggerName: string;
}

interface MetricCatalogEntry {
  key: string;
  constantName: string;
  format: MetricFormat;
  display: 'percentage' | 'numeric';
  description: string;
  gate?: GateMeta;
}

type ConstantName = keyof typeof catalog.constants;

const CATALOG = catalog as {
  constants: Record<ConstantName, number | string>;
  metrics: readonly MetricCatalogEntry[];
};

// ───────────────────────────────────────────────────────────────
// 임계 상수 — 카탈로그 SSOT에서 추출.
// ───────────────────────────────────────────────────────────────

function readNumber(name: ConstantName): number {
  const v = CATALOG.constants[name];
  if (typeof v !== 'number') {
    throw new Error(`metrics.catalog.json: constants.${name} must be number`);
  }
  return v;
}

function readString(name: ConstantName): string {
  const v = CATALOG.constants[name];
  if (typeof v !== 'string') {
    throw new Error(`metrics.catalog.json: constants.${name} must be string`);
  }
  return v;
}

/** 임박 알람 발사 vs 실제 도착 시각 95p 허용치(ms). 초과 시 Phase 4 검토. */
export const SLA_LATE_THRESHOLD_MS = readNumber('SLA_LATE_THRESHOLD_MS');

/** false positive율 허용 상한(0~1). 초과 시 Phase 4 검토. */
export const FALSE_POSITIVE_RATIO_THRESHOLD = readNumber('FALSE_POSITIVE_RATIO_THRESHOLD');

/** Phase 4 진행 여부 판정에 필요한 최소 표본 — 통계적 의미 확보용. */
export const MIN_SAMPLE_FOR_DECISION = readNumber('MIN_SAMPLE_FOR_DECISION');

/** 히스토그램 메트릭의 SLA 평가용 백분위수. 0.95 = 95p. */
export const SLA_PERCENTILE = readNumber('SLA_PERCENTILE');

/**
 * #919 A4 — 매역 알림 recall 운영 KPI 하한 비율. 본 비율 미만 trip이 alert 임계.
 * Phase 4 결정 게이트(`decidePhaseFour`)와 분리된 운영 회귀 감시용 — 본 PR은 SSOT 노출만 하고
 * 실제 alert 배선은 후속 PR (Slack webhook / cron summary)에서 처리.
 */
export const MIN_RECALL_RATIO_THRESHOLD = readNumber('MIN_RECALL_RATIO_THRESHOLD');

/** AE 적재 label prefix — 기존 silent-push 텔레메트리와 namespace 분리. */
const METRIC_LABEL_PREFIX = readString('METRIC_LABEL_PREFIX');

// ───────────────────────────────────────────────────────────────
// 지표 카탈로그 외부 노출 — METRIC_KIND는 기존 호출자/테스트 호환을 위해
// 카탈로그에서 동적 생성 (constantName → key 매핑).
// ───────────────────────────────────────────────────────────────

/**
 * Phase 3 핵심 지표 — 카탈로그(`metrics.catalog.json`)에서 동적 생성.
 * 새 지표 추가 = JSON 객체 1개 추가. 호출/리포팅 코드 무수정.
 */
export const METRIC_KIND: Readonly<Record<string, string>> = Object.freeze(
  CATALOG.metrics.reduce<Record<string, string>>((acc, m) => {
    acc[m.constantName] = m.key;
    return acc;
  }, {}),
);

export type MetricKind = string;

const METRIC_KEYS: readonly string[] = CATALOG.metrics.map((m) => m.key);

function findEntry(kind: MetricKind): MetricCatalogEntry | undefined {
  return CATALOG.metrics.find((m) => m.key === kind);
}

/** 카탈로그 entry 외부 노출 — 리포팅/테스트에서 순회용. 불변. */
export const METRIC_CATALOG: readonly MetricCatalogEntry[] = Object.freeze([...CATALOG.metrics]);

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

/** sample 배열의 p 분위수 — 정렬 후 ceil(p * n) - 1 인덱스. 빈 배열은 0. */
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
    p95: percentile(entry.samples, SLA_PERCENTILE),
    count: entry.samples.length,
    significant: entry.samples.length >= MIN_SAMPLE_FOR_DECISION,
  };
}

// ───────────────────────────────────────────────────────────────
// Phase 4 결정 게이트 — 카탈로그의 `gate` 메타를 순회.
// 새 게이트 추가 = 카탈로그 객체에 `gate` 필드 추가. 분기 코드 무수정.
// ───────────────────────────────────────────────────────────────

export interface PhaseFourDecision {
  /** true = Phase 4 검토 권장 (임계 초과). false = skip 권장. */
  proceed: boolean;
  /** gate가 등록된 지표 중 의미 있는 표본이 한쪽이라도 부족하면 결정 보류. */
  insufficientSamples: boolean;
  /** 어느 지표가 임계를 넘었는지 — ADR stamp 근거 기록용. 카탈로그 triggerName 순. */
  triggers: readonly string[];
}

interface GateBinding {
  entry: MetricCatalogEntry;
  gate: GateMeta;
}

/** 카탈로그에서 gate가 있는 메트릭만 추출 — Phase 4 결정 입력. */
function gatedEntries(): readonly GateBinding[] {
  return CATALOG.metrics
    .filter((m): m is MetricCatalogEntry & { gate: GateMeta } => m.gate !== undefined)
    .map((m) => ({ entry: m, gate: m.gate }));
}

function gateThreshold(gate: GateMeta): number {
  return readNumber(gate.thresholdConst);
}

function gateValue(summary: MetricSummary, gate: GateMeta): number {
  return gate.field === 'p95' ? summary.p95 : summary.value;
}

function gateBreached(summary: MetricSummary, gate: GateMeta): boolean {
  const threshold = gateThreshold(gate);
  const v = gateValue(summary, gate);
  // 현재 op는 '>'만 지원 — 추후 카탈로그 확장 시 분기 추가.
  return gate.op === '>' && v > threshold;
}

/**
 * Phase 4 (Particle filter) 진행 여부 판정.
 *
 * 카탈로그에서 `gate`가 정의된 모든 메트릭의 요약을 입력받아 임계 위반 여부 평가.
 * 게이트가 있는 모든 메트릭이 의미 있는 표본을 갖춰야 결정 — 한쪽이라도 부족하면
 * 보류 (proceed=false, insufficientSamples=true).
 *
 * @param summaries 요약 배열 — gate 등록된 메트릭의 summary가 모두 포함되어야 함
 */
export function decidePhaseFour(summaries: readonly MetricSummary[]): PhaseFourDecision {
  const byKind = new Map(summaries.map((s) => [s.kind, s]));
  const gates = gatedEntries();
  // gate 등록된 메트릭 중 missing 또는 insignificant면 hold.
  for (const { entry } of gates) {
    const s = byKind.get(entry.key);
    if (!s || !s.significant) {
      return { proceed: false, insufficientSamples: true, triggers: [] };
    }
  }
  const triggers: string[] = [];
  for (const { entry, gate } of gates) {
    // missing 분기는 위 loop에서 이미 hold로 반환됨 — non-null 보장.
    const s = byKind.get(entry.key) as MetricSummary;
    if (gateBreached(s, gate)) triggers.push(gate.triggerName);
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

/** 히스토그램 p95 적재용 label 접미사 — SLA_PERCENTILE 기반 동적 생성. */
const HISTOGRAM_PERCENTILE_LABEL = `p${Math.round(SLA_PERCENTILE * 100)}`;

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
  write(HISTOGRAM_PERCENTILE_LABEL, summary.p95);
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
  return typeof value === 'string' && METRIC_KEYS.includes(value);
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
  const meta = findEntry(obj.kind);
  // 카탈로그의 format에 따라 분기 — rate면 hit/total, histogram이면 samples.
  if (meta?.format === 'rate') {
    if (!isNonNegativeInt(obj.hit) || !isNonNegativeInt(obj.total)) return null;
    if (obj.hit > obj.total) return null;
    return { kind: obj.kind, hit: obj.hit, total: obj.total };
  }
  // histogram (or unknown — safety net으로 histogram 처리)
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

