/**
 * "탑승했냐?" 푸시 (#819 B 슬라이스) — 9단 AND 게이트 + arvlCd 우선순위 trainCode 선택.
 *
 * 게이트 (ADR Section 2):
 *   1. trip 활성 (caller가 listTrips로 보장)
 *   2. BoardingLock 없음 (caller가 lockMissing trip 분기에서만 호출)
 *   3. GPS accuracy < 50m (윈도우 평균 기준)
 *   4. 출발역 100m 이내 (마지막 sample 기준 haversine)
 *   5. 방향 cosine ≥ 0.7 (velocity vector vs 출발역→다음역)
 *   6. 60s 윈도우 sample N≥3
 *   7. fused speed ≥ 5 km/h AND confidence ≠ 'low'
 *   8. motion ∈ {walking, automotive}
 *   9. trip당 1회 + 5분 silence
 *
 * arvlCd 우선순위 (ADR Section 1.2):
 *   2 (출발) > 1 (도착) > 0 (진입) > 그 외 receivedAt 가까운 + 방향 매칭
 *   ambiguity → 자동 안 함 → 클라가 manual fallback.
 */

import { ARRIVAL_CODE } from './alarm';
import { fusedSpeed } from './fusedSpeed';
import { matchLine } from './lineAlias';
import {
  ACCURACY_CUTOFF_M,
  cosineDirection,
  evaluateWindow,
  haversineKm,
  type WindowedMetrics,
} from './positionSeries';
import type { ArrivalEntry } from './seoul';
import type { BoardingPromptState, PositionPoint } from './types';

/** 게이트 #4 — 출발역 거리 임계 (km 변환). */
export const ORIGIN_RADIUS_KM = 0.1;
/** 게이트 #5 — 방향 cosine 임계. */
export const DIRECTION_COSINE_THRESHOLD = 0.7;
/** 게이트 #6 — 60s 윈도우 최소 sample. */
export const MIN_WINDOW_SAMPLES = 3;
/** 게이트 #7 — fused speed 임계 (km/h). */
export const MIN_FUSED_SPEED_KMH = 5;
/** 게이트 #9 — dismiss 후 silence 길이. */
export const DISMISS_SILENCE_MS = 5 * 60 * 1000;

export type GateOutcome =
  | { pass: true; metrics: WindowedMetrics; fusedSpeedKmh: number }
  | { pass: false; reason: GateSkipReason; metrics?: WindowedMetrics };

export type GateSkipReason =
  | 'no-series'
  | 'window-too-small'
  | 'accuracy-too-poor'
  | 'origin-too-far'
  | 'direction-mismatch'
  | 'speed-too-low'
  | 'motion-not-moving'
  | 'silenced'
  | 'already-fired';

export interface OriginCoord {
  lat: number;
  lng: number;
}

export interface NextStationCoord {
  lat: number;
  lng: number;
}

export interface EvaluateBoardingPromptInputs {
  series: readonly PositionPoint[];
  origin: OriginCoord;
  /** trip 출발역 → 다음역의 좌표 — 방향 cosine 계산용. */
  nextStation: NextStationCoord;
  now: number;
  /** trip의 boarding-prompt 상태 — 게이트 #9 평가. */
  promptState?: BoardingPromptState;
}

/**
 * 9단 AND 게이트 평가. 한 게이트라도 실패하면 즉시 reason과 함께 fail.
 * 게이트 #1/#2는 caller가 미리 보장 (listTrips × lockMissing 분기) — 본 함수는 #3~#9만 평가.
 */
export function evaluateBoardingPromptGates(
  inputs: EvaluateBoardingPromptInputs,
): GateOutcome {
  // #9 — silence / 1회 발사 dedup. promptState 부재 = 첫 시도, 통과.
  if (inputs.promptState) {
    if (inputs.promptState.fired) {
      return { pass: false, reason: 'already-fired' };
    }
    if (
      inputs.promptState.silencedUntil !== undefined &&
      inputs.promptState.silencedUntil > inputs.now
    ) {
      return { pass: false, reason: 'silenced' };
    }
  }

  // #6 — 60s 윈도우 N≥3 (cold start 보호). 0/1 sample은 metrics.start/end null로 자연 차단.
  const metrics = evaluateWindow(inputs.series, inputs.now);
  if (metrics.count < MIN_WINDOW_SAMPLES) {
    return { pass: false, reason: 'window-too-small', metrics };
  }
  // window-too-small이 통과한 이후엔 start/end가 null이 될 수 없음(count ≥ 3).
  // TypeScript narrowing을 위해 명시 assert로 진행.
  if (!metrics.start || !metrics.end) {
    return { pass: false, reason: 'window-too-small', metrics };
  }

  // #3 — accuracy. 평균 accuracy가 50m 이상이면 신뢰 불가.
  if (metrics.avgAccuracyMeters >= ACCURACY_CUTOFF_M) {
    return { pass: false, reason: 'accuracy-too-poor', metrics };
  }

  // #4 — 출발역 100m 이내. 마지막 sample 기준 (가장 최신 위치).
  const originDistanceKm = haversineKm(
    metrics.end.lat,
    metrics.end.lng,
    inputs.origin.lat,
    inputs.origin.lng,
  );
  if (originDistanceKm > ORIGIN_RADIUS_KM) {
    return { pass: false, reason: 'origin-too-far', metrics };
  }

  // #5 — 방향 cosine ≥ 0.7. expected vector는 출발역 → 다음역.
  const cos = cosineDirection(
    metrics.start.lat,
    metrics.start.lng,
    metrics.end.lat,
    metrics.end.lng,
    inputs.origin.lat,
    inputs.origin.lng,
    inputs.nextStation.lat,
    inputs.nextStation.lng,
  );
  if (cos < DIRECTION_COSINE_THRESHOLD) {
    return { pass: false, reason: 'direction-mismatch', metrics };
  }

  // #8 — motion ∈ {walking, automotive}. stationary/unknown은 차단.
  if (metrics.motion !== 'walking' && metrics.motion !== 'automotive') {
    return { pass: false, reason: 'motion-not-moving', metrics };
  }

  // #7 — fused speed. mapMatchedKmh는 #828에서 wire — 양 끝 sample이 같은 line + arcM을 가질
  // 때만 evaluateWindow가 산출하고, 그 외에는 null로 강등 (GPS-only fallback).
  const fused = fusedSpeed({
    gpsAvgKmh: metrics.gpsAvgKmh,
    gpsAccuracyMeters: metrics.avgAccuracyMeters,
    motion: metrics.motion,
    mapMatchedKmh: metrics.mapMatchedKmh,
  });
  if (fused.speed < MIN_FUSED_SPEED_KMH || fused.confidence === 'low') {
    return { pass: false, reason: 'speed-too-low', metrics };
  }

  return { pass: true, metrics, fusedSpeedKmh: fused.speed };
}

/**
 * trip의 boarding-prompt state를 발사 시점 또는 dismiss 시점에 갱신해 반환.
 * caller는 결과를 trip에 set 후 KV 저장.
 */
export function markPromptFired(now: number): BoardingPromptState {
  return { fired: true, lastFiredAt: now };
}

export function markPromptSilenced(
  prev: BoardingPromptState | undefined,
  now: number,
): BoardingPromptState {
  return {
    ...prev,
    silencedUntil: now + DISMISS_SILENCE_MS,
  };
}

/**
 * arvlCd 우선순위로 trainCode 자동 선택 (ADR Section 1.2).
 *
 * 같은 line + 진행 방향 매칭하는 후보 중:
 *   1순위: arvlCd=2 (출발) — 사용자가 방금 그 차 타고 출발
 *   2순위: arvlCd=1 (도착) — 막 탑승
 *   3순위: arvlCd=0 (진입) — 다음 차 대기
 *   4순위: 그 외 → 받은 순서 그대로 (Seoul API receivedAt 정렬)
 *
 * 같은 우선순위 후보가 여러 개면 (ambiguity) → null 반환. caller가 manual fallback.
 *
 * `line`은 boarding line (사용자 trip 출발 라인). lineAlias.matchLine으로 별칭(예: "1호선"
 * vs "지하철1호선") 매칭.
 */
export function pickAutoTrainCode(
  arrivals: readonly ArrivalEntry[],
  line: string,
  direction: 'up' | 'down' | null,
): string | null {
  const matching = arrivals.filter((a) => matchLine(a.subwayNm, line));
  if (matching.length === 0) return null;
  // 방향 일치 — direction이 null이면 양방향 허용.
  const directional = direction
    ? matching.filter((a) => (direction === 'up' ? a.isUp : !a.isUp))
    : matching;
  if (directional.length === 0) return null;

  const priority: readonly number[] = [
    /* 2: 출발 */ 2,
    /* 1: 도착 */ ARRIVAL_CODE.ARRIVED,
    /* 0: 진입 */ ARRIVAL_CODE.ENTERING,
  ];
  for (const code of priority) {
    const tier = directional.filter((a) => a.arvlCd === code);
    if (tier.length === 1) return tier[0].trainCode || null;
    if (tier.length > 1) return null; // ambiguity → 자동 안 함
  }
  // 그 외 — 받은 순서 첫 후보.
  return directional[0].trainCode || null;
}
