/**
 * A3 사전 예약 효과 텔레메트리 (#918, Epic #912 P1).
 *
 * Trip 1건 종료 시 client `prescheduledMetrics.computePrescheduledMetrics`가 산출한 결과를
 * Cloudflare Analytics Engine에 적재한다. metrics.catalog.json SSOT의 세 항목:
 *
 *   prescheduledFireMissRate      : RateMetric (hit=missed, total=scheduled)
 *                                   → missed = scheduled - fired (OS drop/cancel/일정 변경)
 *   prescheduledStationAccuracy   : RateMetric (hit=accurate, total=fired)
 *                                   → fired alarm이 알람 로그상 같은 station에서 fired로 확인된 비율
 *   prescheduledFireDeltaMs       : HistogramMetric (samples = actualFire-scheduledFire ms)
 *                                   → OS local notification 타이밍 정확도. p95로 SLA 추적.
 *
 * Privacy: 좌표/원문 미적재. token 8자 prefix만 anonymous aggregate에 사용 — recallTelemetry 동형.
 *
 * 본 메트릭은 Phase 4 결정 게이트와 분리된 운영 KPI — `decidePhaseFour`에 포함하지 않는다.
 * (catalog entry에 `gate` 필드 없음.)
 */

import {
  METRIC_KIND,
  writeMetricDataPoints,
  type HistogramMetric,
  type RateMetric,
} from './metrics';
import type { AnalyticsEngineWriter } from './types';

/**
 * Trip-end 진단 컨텍스트 (#986). 모든 필드 optional — 신호 없으면 생략.
 * client `prescheduledMissContext.PrescheduledMissContext` 와 동형. validation 동기 갱신.
 */
export interface MissContext {
  lockedTrainCode?: string;
  lockedAt?: number;
  lastSilentPushReceived?: {
    sentAt?: number;
    receivedAt: number;
    stationName?: string;
  };
  lastScheduledStamp?: {
    selectedArrivalSeconds?: number;
    expectedStationAtFire?: string;
    actualLastNotifiedStation?: string;
  };
  missedIdentifiers?: readonly string[];
}

/**
 * client → backend upload payload.
 *   client `uploadPrescheduledTelemetry`(api/telemetryBackend.ts)와 동일 schema.
 */
export interface PrescheduledUpload {
  /** APNs device token (hex). 8자 prefix만 anonymous aggregate. */
  token: string;
  /** trip 시작 epoch ms. */
  tripStart: number;
  /** trip 종료 epoch ms. tripStart <= tripEnd 강제. */
  tripEnd: number;
  /** ledger 내 trip 윈도우의 사전 예약 entry 총 수 (분모 — miss/fired). */
  scheduledCount: number;
  /** 그 중 fire가 기록된 entry 수 (분자 — accuracy / 누락 분모). */
  firedCount: number;
  /** fired entry 중 station이 alarmLog fired와 일치한 entry 수 (분자 — accuracy). */
  stationAccurateCount: number;
  /** actualFireMs - scheduledFireMs 차이 sample. fired entry당 1건. */
  fireDeltaSamplesMs: readonly number[];
  /** miss 발생 trip 진단 컨텍스트 (#986). 없으면 생략. */
  missContext?: MissContext;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * fireDeltaSamplesMs 배열 검증 — 유한수만 보존. 한 entry라도 비유한이면 전체 reject
 * (조용히 drop하지 않음 — 비정상 sample이 mean/p95를 오염시키지 않게).
 */
function parseDeltaSamples(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (!isFiniteNumber(v)) return null;
    out.push(v);
  }
  return out;
}

/** missContext.missedIdentifiers 길이 상한. trip 1건의 사전 예약은 최대 ~80건이라 여유. */
const MAX_MISSED_IDENTIFIERS = 200;
/** identifier/stationName 문자열 길이 상한 — 비정상 입력 안전망. */
const MAX_STRING_LEN = 200;

function isShortString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_STRING_LEN;
}

function parseLastSilentPushReceived(
  raw: unknown,
): NonNullable<MissContext['lastSilentPushReceived']> | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!isFiniteNumber(obj.receivedAt)) return null;
  const out: NonNullable<MissContext['lastSilentPushReceived']> = { receivedAt: obj.receivedAt };
  if (obj.sentAt !== undefined) {
    if (!isFiniteNumber(obj.sentAt)) return null;
    out.sentAt = obj.sentAt;
  }
  if (obj.stationName !== undefined) {
    if (!isShortString(obj.stationName)) return null;
    out.stationName = obj.stationName;
  }
  return out;
}

function parseLastScheduledStamp(
  raw: unknown,
): NonNullable<MissContext['lastScheduledStamp']> | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const out: NonNullable<MissContext['lastScheduledStamp']> = {};
  if (obj.selectedArrivalSeconds !== undefined) {
    if (!isFiniteNumber(obj.selectedArrivalSeconds)) return null;
    out.selectedArrivalSeconds = obj.selectedArrivalSeconds;
  }
  if (obj.expectedStationAtFire !== undefined) {
    if (!isShortString(obj.expectedStationAtFire)) return null;
    out.expectedStationAtFire = obj.expectedStationAtFire;
  }
  if (obj.actualLastNotifiedStation !== undefined) {
    if (!isShortString(obj.actualLastNotifiedStation)) return null;
    out.actualLastNotifiedStation = obj.actualLastNotifiedStation;
  }
  return out;
}

function parseMissedIdentifiers(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_MISSED_IDENTIFIERS) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (!isShortString(v)) return null;
    out.push(v);
  }
  return out;
}

/**
 * `missContext` 검증 (#986). 부재(undefined) 시 호출자 통과. 한 필드라도 깨졌으면 null —
 * caller는 전체 payload 400으로 처리해 client bug를 빨리 노출.
 */
export function validateMissContext(raw: unknown): MissContext | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const out: MissContext = {};

  if (obj.lockedTrainCode !== undefined) {
    if (!isShortString(obj.lockedTrainCode)) return null;
    out.lockedTrainCode = obj.lockedTrainCode;
  }
  if (obj.lockedAt !== undefined) {
    if (!isFiniteNumber(obj.lockedAt)) return null;
    out.lockedAt = obj.lockedAt;
  }

  const silent = parseLastSilentPushReceived(obj.lastSilentPushReceived);
  if (silent === null) return null;
  if (silent !== undefined) out.lastSilentPushReceived = silent;

  const stamp = parseLastScheduledStamp(obj.lastScheduledStamp);
  if (stamp === null) return null;
  if (stamp !== undefined) out.lastScheduledStamp = stamp;

  const missed = parseMissedIdentifiers(obj.missedIdentifiers);
  if (missed === null) return null;
  if (missed !== undefined) out.missedIdentifiers = missed;

  return out;
}

/**
 * payload 검증. 한 필드라도 깨졌으면 null — caller는 400.
 *
 * 규칙:
 *   - token 비어있으면 reject
 *   - tripStart/tripEnd는 유한수 + tripStart <= tripEnd
 *   - scheduledCount/firedCount/stationAccurateCount는 자연수
 *   - firedCount <= scheduledCount, stationAccurateCount <= firedCount
 *   - fireDeltaSamplesMs는 유한수 배열, 길이는 firedCount와 일치(불일치=client bug, reject)
 *   - missContext (#986)는 optional — 존재 시 shape 강제, 깨졌으면 reject
 */
export function validatePrescheduledUpload(input: unknown): PrescheduledUpload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (!isFiniteNumber(obj.tripStart)) return null;
  if (!isFiniteNumber(obj.tripEnd)) return null;
  if (obj.tripEnd < obj.tripStart) return null;
  if (!isNonNegativeInt(obj.scheduledCount)) return null;
  if (!isNonNegativeInt(obj.firedCount)) return null;
  if (!isNonNegativeInt(obj.stationAccurateCount)) return null;
  if (obj.firedCount > obj.scheduledCount) return null;
  if (obj.stationAccurateCount > obj.firedCount) return null;
  const samples = parseDeltaSamples(obj.fireDeltaSamplesMs);
  if (samples === null) return null;
  if (samples.length !== obj.firedCount) return null;

  const missContext = validateMissContext(obj.missContext);
  if (missContext === null) return null;

  const payload: PrescheduledUpload = {
    token: obj.token,
    tripStart: obj.tripStart,
    tripEnd: obj.tripEnd,
    scheduledCount: obj.scheduledCount,
    firedCount: obj.firedCount,
    stationAccurateCount: obj.stationAccurateCount,
    fireDeltaSamplesMs: samples,
  };
  if (missContext !== undefined) payload.missContext = missContext;
  return payload;
}

/**
 * 사전 예약 텔레메트리 1건을 AE에 적재.
 *
 *  1) prescheduledFireMissRate     — RateMetric (missed/scheduled)
 *  2) prescheduledStationAccuracy  — RateMetric (accurate/fired)  — fired=0이면 skip (의미 없음)
 *  3) prescheduledFireDeltaMs      — HistogramMetric — samples=0이면 skip
 *
 * writeMetricDataPoints가 0값을 skip하므로 fully empty trip은 자동 no-op이지만
 * 호출자는 isEmptyPrescheduledMetrics 가드로 0건 upload 자체를 막는다 (네트워크 절약).
 */
export function recordPrescheduledUpload(
  writer: AnalyticsEngineWriter,
  payload: PrescheduledUpload,
): void {
  const missRate: RateMetric = {
    kind: METRIC_KIND.PRESCHEDULED_FIRE_MISS_RATE,
    hit: payload.scheduledCount - payload.firedCount,
    total: payload.scheduledCount,
  };
  writeMetricDataPoints(writer, payload.token, missRate);

  if (payload.firedCount > 0) {
    const accuracy: RateMetric = {
      kind: METRIC_KIND.PRESCHEDULED_STATION_ACCURACY,
      hit: payload.stationAccurateCount,
      total: payload.firedCount,
    };
    writeMetricDataPoints(writer, payload.token, accuracy);
  }

  if (payload.fireDeltaSamplesMs.length > 0) {
    const histogram: HistogramMetric = {
      kind: METRIC_KIND.PRESCHEDULED_FIRE_DELTA_MS,
      samples: payload.fireDeltaSamplesMs,
    };
    writeMetricDataPoints(writer, payload.token, histogram);
  }
}
