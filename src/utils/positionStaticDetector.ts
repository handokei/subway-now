/**
 * 위치 이력 기반 정적 판정 (#733).
 *
 * 배경: iOS Core Location은 정적 사용자에게 speed=-1(미측정)을 자주 보고한다.
 * movementGate의 speed 기반 판정이 무력화되는 케이스(snapshot 2: speed=null,
 * confidence=arrival-arriving)에서, 최근 좌표들의 spread로 정적 여부를 별도 판정한다.
 *
 * 알고리즘:
 *   1. windowMs(60s) 안에 들어온 sample만 본다.
 *   2. minSamples(3개) 미만이면 'unknown' — 데이터 부족.
 *   3. 시간 폭이 windowMs * MIN_TIME_SPAN_RATIO 미만이면 'unknown' — 부분 윈도우.
 *   4. 최대 pairwise haversine 거리가 maxDeltaM(60m) 이하이면 'static', 초과면 'moving'.
 *
 * 60m 기준은 STATIC_SPEED_THRESHOLD_MPS(0.5) * 60s(window) * 2(보수배수) ≈ 60m
 *   — 정적 사용자가 GPS 지터(~12m accuracy)로 그려내는 spread를 흡수하는 임계값.
 */

import { haversine } from './haversine';

/** 정적 판정에 필요한 시간 윈도우 (ms). 60s = 일반 GPS 폴링 2~3 cycle 보장. */
export const STATIC_WINDOW_MS = 60_000;

/** 정적 판정 최소 sample 개수. 3개 미만이면 'unknown' 반환. */
export const STATIC_MIN_SAMPLES = 3;

/** 정적 spread 허용 임계값 (m). 사람 걸음 0.5 m/s × 60s = 30m + GPS 지터 마진. */
export const STATIC_MAX_DELTA_M = 60;

/**
 * 윈도우 시간 폭 최소 비율. fresh samples의 (newest - oldest) ts가
 * windowMs * 이 비율 미만이면 'unknown' — 짧은 burst만 모인 경우 부분 판정 회피.
 */
export const MIN_TIME_SPAN_RATIO = 0.5;

export type PositionStability = 'static' | 'moving' | 'unknown';

export interface PositionSample {
  lat: number;
  lng: number;
  /** epoch ms — sample 생성 시각. */
  ts: number;
}

export interface PositionStaticConfig {
  windowMs?: number;
  minSamples?: number;
  maxDeltaM?: number;
  minTimeSpanRatio?: number;
}

/**
 * 최근 N개 sample을 평가해 정적/이동/판정불가 분류.
 *
 * @param samples ts 오름차순 또는 임의 순서 (내부에서 windowMs로 필터, ts 비교)
 * @param now     기준 시각 (테스트 결정성 위해 주입 가능). 기본 Date.now().
 * @param config  임계값 override (테스트/튜닝용).
 */
export function classifyPositionStability(
  samples: readonly PositionSample[],
  now: number = Date.now(),
  config: PositionStaticConfig = {},
): PositionStability {
  const windowMs = config.windowMs ?? STATIC_WINDOW_MS;
  const minSamples = config.minSamples ?? STATIC_MIN_SAMPLES;
  const maxDeltaM = config.maxDeltaM ?? STATIC_MAX_DELTA_M;
  const minTimeSpanRatio = config.minTimeSpanRatio ?? MIN_TIME_SPAN_RATIO;

  const fresh = samples.filter((s) => now - s.ts <= windowMs);
  if (fresh.length < minSamples) return 'unknown';

  const tsValues = fresh.map((s) => s.ts);
  const oldestTs = Math.min(...tsValues);
  const newestTs = Math.max(...tsValues);
  if (newestTs - oldestTs < windowMs * minTimeSpanRatio) return 'unknown';

  let maxDeltaKm = 0;
  for (let i = 0; i < fresh.length; i++) {
    for (let j = i + 1; j < fresh.length; j++) {
      const d = haversine(fresh[i].lat, fresh[i].lng, fresh[j].lat, fresh[j].lng);
      if (d > maxDeltaKm) maxDeltaKm = d;
    }
  }
  const maxDeltaMeters = maxDeltaKm * 1000;
  return maxDeltaMeters <= maxDeltaM ? 'static' : 'moving';
}
