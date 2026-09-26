/**
 * 회귀 카운터 텔레메트리 (#1261, Epic #1204 그룹 0).
 *
 * 2026-06-12 사용자 trip 분석 후 도입한 4개 회귀의 발생 빈도를 자동 카운트한다.
 * 클라이언트가 trip 종료 시 누적된 회귀 발생 수를 보고하면, 5분 sliding window + 일별 KV
 * 카운터에 적재한다. 운영자는 `GET /telemetry/regressions`로 5분/일/주 추이를 확인한다.
 *
 *   regression_8  — 동일 알림 재발사 (alarmKey에 routeSig 부재)
 *   regression_10 — trip 재생성 후 실시간 정보 3분+ 지연 (POST /trips 다중 등록)
 *   regression_11 — BoardingTrainList에 "지난 차" 노출 (시각 표시 누락)
 *   regression_12 — bg→fg 전환 후 boardingLock/route 휘발 (HomeScreen reload 누락)
 *
 * Privacy: 카운트만 적재한다. 좌표/시각/원문 미저장. token은 8자 prefix만 익명 aggregate에 사용.
 * AE binding 미설정 시 datapoint write는 graceful no-op (recall/prescheduled 동형).
 * KV(`TRIPS`)는 필수 — 카운터 적재용. KV는 모든 환경에 바인딩되어 있다.
 */

import { tokenPrefix } from './telemetry';
import type { AnalyticsEngineWriter } from './types';

/**
 * client `regressionMetrics.ts:KNOWN_REGRESSION_IDS`와 양방향 SSOT.
 * 본 배열에 없는 id는 validate 단계에서 silently drop — 구버전/신버전 client 호환.
 */
export const KNOWN_REGRESSION_IDS = ['8', '10', '11', '12'] as const;
export type RegressionId = (typeof KNOWN_REGRESSION_IDS)[number];

/** 5분 bucket size (ms). sliding window 분해능. */
export const BUCKET_MS = 5 * 60 * 1000;

/** last hour 조회 시 합산할 5분 bucket 개수 (현재 bucket 포함 12개 = 60분). */
const HOUR_BUCKET_COUNT = 12;

/** last 7d 조회 시 합산할 day key 개수 (오늘 포함 7일). */
const WEEK_DAY_COUNT = 7;

/** 5분 bucket KV TTL — last hour 조회를 위해 1시간 + 여유. */
const BUCKET_TTL_SECONDS = 60 * 60 + 300;

/** 일별 카운터 KV TTL — last week 조회를 위해 8일. */
const DAY_TTL_SECONDS = 8 * 24 * 60 * 60;

export interface RegressionUpload {
  /** APNs device token (hex). prefix(8자)만 anonymous aggregate에 사용. */
  token: string;
  /** 이전 flush 시각(epoch ms). 첫 flush는 0. */
  since: number;
  /** 현재 flush 시각(epoch ms). */
  until: number;
  /** regression id별 카운트. 알려진 id만 보존. */
  counts: Partial<Record<RegressionId, number>>;
}

function isFiniteNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

/**
 * payload 검증. 형태가 깨졌으면 null, 정상이면 정규화된 객체.
 * - 음수/NaN/소수 reject (카운터는 자연수)
 * - counts는 객체만 허용, 알려진 id만 보존
 * - 모든 알려진 id 카운트가 0이거나 누락이면 reject (no-op upload 차단)
 */
export function validateRegressionUpload(input: unknown): RegressionUpload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (!isFiniteNonNegativeInt(obj.since)) return null;
  if (!isFiniteNonNegativeInt(obj.until)) return null;
  if (obj.until < obj.since) return null;
  if (!obj.counts || typeof obj.counts !== 'object') return null;

  const rawCounts = obj.counts as Record<string, unknown>;
  const counts: Partial<Record<RegressionId, number>> = {};
  let total = 0;
  for (const id of KNOWN_REGRESSION_IDS) {
    const v = rawCounts[id];
    if (v === undefined) continue;
    if (!isFiniteNonNegativeInt(v)) return null;
    counts[id] = v;
    total += v;
  }
  if (total === 0) return null;

  return {
    token: obj.token,
    since: obj.since,
    until: obj.until,
    counts,
  };
}

/**
 * Analytics Engine에 회귀 id별 data point를 적재한다.
 *
 * Schema:
 *   blob1 = `regression:<id>`
 *   blob2 = token prefix (8자)
 *   double1 = count
 *   index1 = token prefix (sampling용)
 */
export function writeRegressionDataPoints(
  writer: AnalyticsEngineWriter,
  payload: RegressionUpload,
): void {
  const prefix = tokenPrefix(payload.token);
  for (const id of KNOWN_REGRESSION_IDS) {
    const count = payload.counts[id] ?? 0;
    if (count <= 0) continue;
    writer.writeDataPoint({
      blobs: [`regression:${id}`, prefix],
      doubles: [count],
      indexes: [prefix],
    });
  }
}

function bucketStart(now: number): number {
  return Math.floor(now / BUCKET_MS) * BUCKET_MS;
}

function isoDateUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** 5분 bucket KV 키. */
export function bucketKey(bucketTs: number, id: RegressionId): string {
  return `regression:5m:${bucketTs}:${id}`;
}

/** 일별 KV 키. */
export function dayKey(dateStr: string, id: RegressionId): string {
  return `regression:day:${dateStr}:${id}`;
}

async function readCount(kv: KVNamespace, key: string): Promise<number> {
  const raw = await kv.get(key);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * 회귀 카운트를 5분 bucket + 일별 KV에 누적 적재한다.
 * 0인 id는 skip.
 *
 * Race: read-modify-write 패턴. 분당 ≤ 수회 trip 종료 빈도에서 5분 bucket으로 슬롯이 넓어
 * 충돌 가능성 낮음 (기존 `incrementDailyRequestCount`와 동형).
 */
export async function incrementRegressionCounters(
  kv: KVNamespace,
  now: number,
  counts: Partial<Record<RegressionId, number>>,
): Promise<void> {
  const ts = bucketStart(now);
  const dateStr = isoDateUtc(now);
  for (const id of KNOWN_REGRESSION_IDS) {
    const delta = counts[id] ?? 0;
    if (delta <= 0) continue;

    const bKey = bucketKey(ts, id);
    const dKey = dayKey(dateStr, id);
    const [bPrev, dPrev] = await Promise.all([readCount(kv, bKey), readCount(kv, dKey)]);
    await Promise.all([
      kv.put(bKey, String(bPrev + delta), { expirationTtl: BUCKET_TTL_SECONDS }),
      kv.put(dKey, String(dPrev + delta), { expirationTtl: DAY_TTL_SECONDS }),
    ]);
  }
}

/** id별 윈도우 카운트 응답 형태. */
export interface RegressionWindowCounts {
  last5m: number;
  lastHour: number;
  today: number;
  last7d: number;
}

export type RegressionCountsResponse = Record<RegressionId, RegressionWindowCounts>;

async function sumBuckets(
  kv: KVNamespace,
  id: RegressionId,
  startTs: number,
  endTs: number,
): Promise<number> {
  const keys: string[] = [];
  for (let ts = startTs; ts <= endTs; ts += BUCKET_MS) {
    keys.push(bucketKey(ts, id));
  }
  const vals = await Promise.all(keys.map((k) => readCount(kv, k)));
  return vals.reduce((a, b) => a + b, 0);
}

async function sumDays(kv: KVNamespace, id: RegressionId, now: number, days: number): Promise<number> {
  const keys: string[] = [];
  for (let i = 0; i < days; i += 1) {
    keys.push(dayKey(isoDateUtc(now - i * 24 * 60 * 60 * 1000), id));
  }
  const vals = await Promise.all(keys.map((k) => readCount(kv, k)));
  return vals.reduce((a, b) => a + b, 0);
}

/**
 * 회귀 id별 last5m / lastHour / today / last7d 카운트를 KV에서 조회한다.
 * 운영자/DebugModal용. 결과는 모든 알려진 id를 포함 (값이 0이어도 키 포함 — 클라이언트 표 안정성).
 */
export async function readRegressionCounters(
  kv: KVNamespace,
  now: number,
): Promise<RegressionCountsResponse> {
  const currentBucket = bucketStart(now);
  const hourStart = currentBucket - (HOUR_BUCKET_COUNT - 1) * BUCKET_MS;
  const out = {} as RegressionCountsResponse;
  for (const id of KNOWN_REGRESSION_IDS) {
    const [last5m, lastHour, today, last7d] = await Promise.all([
      readCount(kv, bucketKey(currentBucket, id)),
      sumBuckets(kv, id, hourStart, currentBucket),
      readCount(kv, dayKey(isoDateUtc(now), id)),
      sumDays(kv, id, now, WEEK_DAY_COUNT),
    ]);
    out[id] = { last5m, lastHour, today, last7d };
  }
  return out;
}
