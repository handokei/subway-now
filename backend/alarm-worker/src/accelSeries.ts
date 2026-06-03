/**
 * 디바이스 가속도 1초 요약 KV ring buffer + 60s window evaluate (#823 Phase 3 E1).
 *
 * positionSeries.ts와 동일 구조 — token별 단일 series, 시간 윈도우로 평가.
 * 이 단계(E1)는 **수집 + 저장**만. 게이트/fusion 사용은 E2 Kalman, E3 phase 감지가 별도로 가져간다.
 */

import type { AccelSummary } from './types';

/** KV 키 prefix — device token 1개당 1 series. */
const ACCEL_SERIES_PREFIX = 'accel:';
/** ring buffer 한 device의 최대 sample 수. 60s window가 보통 60 sample. */
const MAX_SERIES_SAMPLES = 90;
/** KV TTL — 사용자 1시간 미활동 시 자연 폐기 (positionSeries SERIES_TTL과 정렬). */
const SERIES_TTL_SEC = 60 * 60;
/** evaluateAccelWindow 기본 window — 60s, positionSeries POSITION_WINDOW_MS와 정합. */
export const ACCEL_WINDOW_MS = 60_000;

/**
 * 디바이스 토큰의 가속도 series에 새 요약값을 append하고 저장.
 * positionSeries와 같은 ring 패턴.
 */
export async function appendAccelSample(
  kv: KVNamespace,
  token: string,
  sample: AccelSummary,
): Promise<AccelSummary[]> {
  const series = await readAccelSeries(kv, token);
  series.push(sample);
  while (series.length > MAX_SERIES_SAMPLES) series.shift();
  await kv.put(seriesKey(token), JSON.stringify(series), { expirationTtl: SERIES_TTL_SEC });
  return series;
}

/** series read — 없거나 invalid JSON이면 빈 배열. */
export async function readAccelSeries(
  kv: KVNamespace,
  token: string,
): Promise<AccelSummary[]> {
  const raw = await kv.get(seriesKey(token));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAccelSummary);
  } catch {
    return [];
  }
}

/** 명시적 series 삭제 — 테스트/cleanup 용. */
export async function clearAccelSeries(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(seriesKey(token));
}

function seriesKey(token: string): string {
  return `${ACCEL_SERIES_PREFIX}${token}`;
}

/** 외부 입력 검증 — backend `/position` 라우터가 옵션 필드 검증에 사용. */
export function isAccelSummary(value: unknown): value is AccelSummary {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    isFiniteNumber(o.startTs) &&
    isFiniteNumber(o.endTs) &&
    isFiniteNumber(o.count) &&
    isFiniteNumber(o.ax) &&
    isFiniteNumber(o.ay) &&
    isFiniteNumber(o.az) &&
    isFiniteNumber(o.magnitudeMean) &&
    isFiniteNumber(o.magnitudeStd) &&
    isFiniteNumber(o.magnitudePeak)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export interface AccelWindowMetrics {
  /** window 내 sample 개수. */
  count: number;
  /** window 평균 magnitude (m/s²). */
  avgMagnitudeMean: number;
  /** window 내 최대 magnitudePeak (m/s²). */
  maxMagnitudePeak: number;
  /** window 내 magnitudeStd의 평균 (m/s²). */
  avgMagnitudeStd: number;
}

/**
 * series에서 `[now - ACCEL_WINDOW_MS, now]` 윈도우만 잘라 평균 magnitude/std/peak 산출.
 *
 * E2 Kalman/E3 phase 감지가 평가 시점에 호출. 본 PR은 수집만이므로 metric 정의를 깔아두고
 * 호출자는 후속 sub-issue에서 합류한다.
 */
export function evaluateAccelWindow(
  series: readonly AccelSummary[],
  now: number,
): AccelWindowMetrics {
  const windowed = series.filter((s) => now - s.endTs <= ACCEL_WINDOW_MS);
  if (windowed.length === 0) {
    return { count: 0, avgMagnitudeMean: 0, maxMagnitudePeak: 0, avgMagnitudeStd: 0 };
  }
  let sumMean = 0;
  let sumStd = 0;
  let maxPeak = 0;
  for (const s of windowed) {
    sumMean += s.magnitudeMean;
    sumStd += s.magnitudeStd;
    if (s.magnitudePeak > maxPeak) maxPeak = s.magnitudePeak;
  }
  return {
    count: windowed.length,
    avgMagnitudeMean: sumMean / windowed.length,
    maxMagnitudePeak: maxPeak,
    avgMagnitudeStd: sumStd / windowed.length,
  };
}
