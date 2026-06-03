/**
 * 클라이언트 위치 series KV 저장 + 60s 평균속도/방향/motion 분류 (#819 Phase 1).
 *
 * 디바이스가 POST /position으로 보낸 단일 sample을 토큰별 ring buffer로 누적한다.
 * 게이트 평가 시 60s 윈도우만 잘라 평균속도(accuracy ≥ 50m 제외)와 motion 최빈값을
 * 산출한다. 노이즈가 큰 raw client.speed에 의존하지 않는 것이 핵심 정책 (#812 회귀).
 */

import type { PositionPoint } from './types';

/** KV 키 prefix — device token 1개당 1 series. */
const POSITION_SERIES_PREFIX = 'pos:';
/** 평균속도 계산용 시간 윈도우 (ms). ADR Section 6 step 4-5: 60s. */
export const POSITION_WINDOW_MS = 60_000;
/** ring buffer 한 device에 저장하는 최대 좌표 수 — 60s window가 보통 6~12 sample. */
const MAX_SERIES_POINTS = 30;
/** KV TTL — 사용자가 1시간 미활동이면 series는 자연 폐기 (게이트 #6 reset 정책 정렬). */
const SERIES_TTL_SEC = 60 * 60;
/** motion 최빈값 계산용 윈도우 (최근 sample 개수). ADR Section 6 step 6. */
const MOTION_RECENT_COUNT = 6;
/** 게이트 #3 / 평균속도 산출에서 컷오프할 accuracy (meters). */
export const ACCURACY_CUTOFF_M = 50;

const EARTH_RADIUS_KM = 6371;

function toRadians(deg: number): number {
  return deg * (Math.PI / 180);
}

/** km 단위 거리 — haversine. backend는 client utils와 분리 빌드라 동일 식을 복제. */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * 디바이스 토큰의 위치 series를 KV에서 읽어 새 point를 append 후 저장.
 * window를 벗어난 오래된 sample은 평가 시 잘리지만, KV에는 최대 MAX_SERIES_POINTS까지
 * 보관해 cron 한 사이클 누락(>60s)에서도 직전 데이터를 활용할 수 있게 한다.
 */
export async function appendPositionPoint(
  kv: KVNamespace,
  token: string,
  point: PositionPoint,
): Promise<PositionPoint[]> {
  const series = await readSeries(kv, token);
  series.push(point);
  // 오래된 쪽부터 제거 (push 후 잘림).
  while (series.length > MAX_SERIES_POINTS) series.shift();
  await kv.put(seriesKey(token), JSON.stringify(series), { expirationTtl: SERIES_TTL_SEC });
  return series;
}

/** 디바이스의 현재 series를 읽는다 — 없으면 빈 배열. */
export async function readSeries(
  kv: KVNamespace,
  token: string,
): Promise<PositionPoint[]> {
  const raw = await kv.get(seriesKey(token));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPositionPoint);
  } catch {
    return [];
  }
}

/** 테스트/관리 — series 명시 삭제 (게이트 평가 후 1회 발사한 trip을 정리할 때 등). */
export async function clearSeries(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(seriesKey(token));
}

function seriesKey(token: string): string {
  return `${POSITION_SERIES_PREFIX}${token}`;
}

function isPositionPoint(value: unknown): value is PositionPoint {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (
    typeof o.lat !== 'number' ||
    typeof o.lng !== 'number' ||
    typeof o.accuracy !== 'number' ||
    typeof o.ts !== 'number'
  ) {
    return false;
  }
  if (
    o.motion !== 'stationary' &&
    o.motion !== 'walking' &&
    o.motion !== 'automotive' &&
    o.motion !== 'unknown'
  ) {
    return false;
  }
  // #828 — optional map matching 필드는 짝(line+arcM)이 함께 있을 때만 유효. 한쪽만 있는
  // payload는 stale write로 간주해 series에서 거부 (false positive 1차 차단 정책 정렬).
  if (o.mapMatchedLine !== undefined && typeof o.mapMatchedLine !== 'string') return false;
  if (o.mapMatchedArcM !== undefined && typeof o.mapMatchedArcM !== 'number') return false;
  const hasLine = typeof o.mapMatchedLine === 'string';
  const hasArc = typeof o.mapMatchedArcM === 'number';
  if (hasLine !== hasArc) return false;
  // #825 — nearestStationDistanceM은 옵션. 값이 있다면 finite number 필수. 음수도 거부
  //   (haversine 거리는 항상 ≥ 0).
  if (o.nearestStationDistanceM !== undefined) {
    if (typeof o.nearestStationDistanceM !== 'number') return false;
    if (!Number.isFinite(o.nearestStationDistanceM)) return false;
    if (o.nearestStationDistanceM < 0) return false;
  }
  return true;
}

export interface WindowedMetrics {
  /** 시간 윈도우에 들어간 sample 개수 (raw, accuracy 컷오프 전). 게이트 #6 N≥3 평가용. */
  count: number;
  /** accuracy ≥ 50m 제외 후 hop 시간을 합산한 누적 거리 / 시간 평균속도 km/h. */
  gpsAvgKmh: number;
  /** 평균속도 산출에 사용된 sample들의 평균 accuracy meters. fusedSpeed 가중치 결정용. */
  avgAccuracyMeters: number;
  /** 최근 MOTION_RECENT_COUNT개 sample의 최빈 motion 분류. */
  motion: PositionPoint['motion'];
  /** 시작점/끝점 좌표 — 방향 cosine 계산 입력 (없으면 null, 0/1 sample 케이스). */
  start: { lat: number; lng: number } | null;
  /** 시작점/끝점 좌표 — 방향 cosine 계산 입력. */
  end: { lat: number; lng: number } | null;
  /**
   * Phase 2 map matching 결과 (#828). 윈도우 양 끝 sample이 모두 같은 line + arcM을 가질 때만
   * `|Δarc| / Δt`로 산출 — fusedSpeed의 mapMatchedKmh 인자로 그대로 전달된다.
   *
   * - null: 클라이언트가 한쪽이라도 snap 못한 경우 (boarding line 미설정/멀리 떨어진 좌표).
   *   fusedSpeed는 GPS-only로 자연 동작 (Phase 1 회귀 없음).
   * - 환승역 disambiguate: start/end line이 다르면 null로 강등.
   */
  mapMatchedKmh: number | null;
}

/**
 * series에서 `[now - POSITION_WINDOW_MS, now]` 윈도우만 잘라 평균속도/방향/motion 산출.
 *
 * 평균속도는 인접 sample 쌍의 거리/시간 hop 평균 — accuracy ≥ 50m sample은 hop에서 빠진다.
 * (ADR Section 6 step 5: `gpsAvgKmh = Σ haversine(points[i-1], points[i]) / Δt`)
 *
 * motion은 ADR Section 6 step 6 — 최근 MOTION_RECENT_COUNT(6)개 sample의 최빈값.
 * 최빈이 동률이면 'unknown'으로 폴백해 게이트 #8을 보수적으로 차단.
 */
export function evaluateWindow(
  series: readonly PositionPoint[],
  now: number,
): WindowedMetrics {
  const windowed = series.filter((p) => now - p.ts <= POSITION_WINDOW_MS);
  const start = windowed[0];
  const end = windowed[windowed.length - 1];

  let totalDistanceKm = 0;
  let totalHopMs = 0;
  let acceptedSampleCount = 0;
  let totalAccuracy = 0;
  for (let i = 1; i < windowed.length; i++) {
    const prev = windowed[i - 1];
    const cur = windowed[i];
    // accuracy 50m 이상 sample은 hop에 포함하지 않음 (ADR Section 6 step 5).
    if (prev.accuracy >= ACCURACY_CUTOFF_M || cur.accuracy >= ACCURACY_CUTOFF_M) continue;
    const dtMs = cur.ts - prev.ts;
    if (dtMs <= 0) continue;
    totalDistanceKm += haversineKm(prev.lat, prev.lng, cur.lat, cur.lng);
    totalHopMs += dtMs;
    // 가중치 평균: 두 sample의 평균을 hop의 accuracy로 본다.
    totalAccuracy += (prev.accuracy + cur.accuracy) / 2;
    acceptedSampleCount += 1;
  }
  const gpsAvgKmh =
    totalHopMs > 0 ? totalDistanceKm / (totalHopMs / 3_600_000) : 0;
  const avgAccuracyMeters =
    acceptedSampleCount > 0 ? totalAccuracy / acceptedSampleCount : Infinity;

  const motion = pickMotionMode(windowed.slice(-MOTION_RECENT_COUNT));

  return {
    count: windowed.length,
    gpsAvgKmh,
    avgAccuracyMeters,
    motion,
    start: start ? { lat: start.lat, lng: start.lng } : null,
    end: end ? { lat: end.lat, lng: end.lng } : null,
    mapMatchedKmh: computeMapMatchedKmh(start, end),
  };
}

/**
 * 윈도우 양 끝 sample이 모두 같은 line + arcM을 갖는 경우 `|Δarc| / Δt`로 평균속도(km/h) 산출.
 *
 * - 한쪽이라도 snap 안 됨 / line 다름 / Δt ≤ 0 / Δarc = 0 → null (fusedSpeed가 GPS-only로 강등).
 * - 역방향 진행(음의 Δarc)은 `|·|`로 처리해 호출자가 방향을 알 필요 없게 한다 — 이는
 *   client `mapMatchedSpeedKmh`(#817) 정책과 정렬.
 */
function computeMapMatchedKmh(
  start: PositionPoint | undefined,
  end: PositionPoint | undefined,
): number | null {
  if (!start || !end) return null;
  const { mapMatchedLine: startLine, mapMatchedArcM: startArc } = start;
  const { mapMatchedLine: endLine, mapMatchedArcM: endArc } = end;
  if (startLine === undefined || startArc === undefined) return null;
  if (endLine === undefined || endArc === undefined) return null;
  if (startLine !== endLine) return null;
  const dtMs = end.ts - start.ts;
  if (dtMs <= 0) return null;
  const deltaM = Math.abs(endArc - startArc);
  if (deltaM === 0) return null;
  const mps = deltaM / (dtMs / 1000);
  return mps * 3.6;
}

/**
 * 최근 sample의 motion 최빈값. 동률 또는 빈 입력은 'unknown'으로 강등 — 게이트 #8을
 * 보수 차단한다 (false positive 1차 정책).
 */
export function pickMotionMode(
  recent: readonly PositionPoint[],
): PositionPoint['motion'] {
  if (recent.length === 0) return 'unknown';
  const counts: Record<PositionPoint['motion'], number> = {
    stationary: 0,
    walking: 0,
    automotive: 0,
    unknown: 0,
  };
  for (const p of recent) counts[p.motion] += 1;
  let best: PositionPoint['motion'] = 'unknown';
  let bestCount = -1;
  let tied = false;
  for (const motion of ['stationary', 'walking', 'automotive', 'unknown'] as const) {
    const c = counts[motion];
    if (c > bestCount) {
      best = motion;
      bestCount = c;
      tied = false;
    } else if (c === bestCount && motion !== best) {
      tied = true;
    }
  }
  return tied ? 'unknown' : best;
}

/**
 * 진행 방향 cosine — `velocity vector(start→end)` 대 `expected vector(origin→nextStation)` (게이트 #5).
 *
 * 길이 0(정지/동일점)은 0으로 강등해 게이트 ≥ 0.7 차단. atan2 vs degree 변환 노이즈를
 * 피하려고 평면 근사 dot product를 직접 계산한다 — 도시 한 정거장 hop 거리에서는 충분히 정확.
 */
export function cosineDirection(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  expectedFromLat: number,
  expectedFromLng: number,
  expectedToLat: number,
  expectedToLng: number,
): number {
  const ax = toLng - fromLng;
  const ay = toLat - fromLat;
  const bx = expectedToLng - expectedFromLng;
  const by = expectedToLat - expectedFromLat;
  const magA = Math.hypot(ax, ay);
  const magB = Math.hypot(bx, by);
  if (magA === 0 || magB === 0) return 0;
  return (ax * bx + ay * by) / (magA * magB);
}
