/**
 * 운행 phase 분류기 — APPROACHING / DWELLING / DEPARTING / CRUISING (#825 Phase 3 E3).
 *
 * 입력: Kalman smoothed velocity (E2) + accel summary (E1) + 가장 가까운 정거장 거리 (#834).
 * 출력: phase + confidence(0~1) + 2-cycle hysteresis state.
 *
 * 알고리즘 (rule-based + score matrix):
 *   1. 각 phase에 대해 feature score를 합산
 *   2. argmax phase 선택 + confidence = (max - second) / Σ|score|
 *   3. hysteresis: 직전 cycle phase와 같으면 confidence boost. 다르면 같은 candidate가
 *      2 cycle 연속이어야 전환 (flicker 방지)
 *
 * ML 모델은 보류 — score matrix가 데이터 주도라 임계값만 E5 측정으로 조정하면 됨.
 *
 * ADR: https://app.notion.com/p/37430c0194b6819c8323e37d4c31a777 Section 5 (Phase 3).
 */

import type { StationPhaseState, StationPhaseType } from './types';

/** 정거장 근접 임계 (m) — APPROACHING/DWELLING/DEPARTING 모두 정거장 근처에서 의미. */
export const STATION_NEAR_RADIUS_M = 200;
/** 정차 인접 임계 (m) — DWELLING은 더 가까운 거리. */
export const STATION_DWELL_RADIUS_M = 50;
/** 정지 속도 임계 (km/h) — DWELLING 후보. */
export const STATIONARY_KMH = 5;
/** 순항 속도 임계 (km/h) — CRUISING 후보. */
export const CRUISE_KMH = 20;
/** 감속/가속 magnitude 임계 (m/s²) — 출발/감속 phase 신호. */
export const MOTION_ACCEL_THRESHOLD = 0.5;
/**
 * 속도 변화 임계 (km/h) — cycle간 |Δv|가 이 이상이면 가/감속 추세로 인정.
 * cron 60s 주기 × 지하철 가속 ~1 m/s²(약 3.6 km/h/s)면 cycle 차이가 수 km/h 이상.
 * 노이즈는 줄이고 실제 가/감속만 잡도록 보수적인 임계.
 */
export const VELOCITY_DELTA_KMH = 3;
/** hysteresis confidence boost — 같은 phase 유지 시. */
export const SAME_PHASE_BOOST = 0.2;
/** 같은 candidate가 N cycle 연속이어야 전환. */
export const SWITCH_CYCLES = 2;

/** 모든 phase 목록 — argmax / 점수 매트릭스 iteration 데이터 주도. */
export const PHASES: readonly StationPhaseType[] = [
  'APPROACHING',
  'DWELLING',
  'DEPARTING',
  'CRUISING',
] as const;

export interface ClassifyInputs {
  /** Kalman smoothed velocity km/h. E2 결과 (state.v). */
  kalmanKmh: number;
  /**
   * 직전 cycle의 Kalman v (km/h). cycle간 추세로 APPROACHING(감속) vs DEPARTING(가속)을
   * 구분 — accel magnitude만으로는 부호가 없어 불가능. undefined = 첫 cycle (추세 신호 없음).
   */
  prevKalmanKmh: number | undefined;
  /** accel magnitude 평균 m/s². E1 evaluateAccelWindow.avgMagnitudeMean. */
  accelMagnitudeMean: number;
  /** accel magnitude std m/s². E1 evaluateAccelWindow.avgMagnitudeStd. */
  accelMagnitudeStd: number;
  /** 가장 가까운 정거장 거리 m (#834에서 클라가 stamp). undefined = phase 분류 skip. */
  nearestStationDistanceM: number | undefined;
  /** CMMotionActivity 분류 — DWELLING 보강 신호. */
  motion: 'stationary' | 'walking' | 'automotive' | 'unknown';
  /** 현 시각 epoch ms. */
  now: number;
}

/** phase별 score 벡터. argmax/normalize 용이하게 별도 타입으로 노출 (테스트 검증용). */
export type PhaseScores = Record<StationPhaseType, number>;

/**
 * Feature → phase 점수 기여 매트릭스. 각 feature가 어떤 phase에 +/-로 기여하는지 데이터로 표현.
 * 확장 시 새 phase/feature는 이 매트릭스에 행/열 추가만으로 처리 (Open/Closed).
 */
type FeatureContribution = Record<StationPhaseType, number>;
interface PhaseFeature {
  name: string;
  /** feature가 활성인지 판단. */
  active: (i: ClassifyInputs) => boolean;
  /** 활성 시 phase별 가중치 기여. */
  contribution: FeatureContribution;
}

const PHASE_FEATURES: readonly PhaseFeature[] = [
  {
    name: 'dwellingZone',
    active: (i) =>
      i.nearestStationDistanceM !== undefined &&
      i.nearestStationDistanceM <= STATION_DWELL_RADIUS_M,
    contribution: { APPROACHING: 0, DWELLING: 2, DEPARTING: 0, CRUISING: -1 },
  },
  {
    name: 'stationVicinity',
    active: (i) =>
      i.nearestStationDistanceM !== undefined &&
      i.nearestStationDistanceM <= STATION_NEAR_RADIUS_M,
    contribution: { APPROACHING: 1, DWELLING: 1, DEPARTING: 1, CRUISING: -1 },
  },
  {
    name: 'slowOrStop',
    active: (i) => i.kalmanKmh <= STATIONARY_KMH,
    contribution: { APPROACHING: 1, DWELLING: 2, DEPARTING: -1, CRUISING: -2 },
  },
  {
    name: 'cruiseSpeed',
    active: (i) => i.kalmanKmh >= CRUISE_KMH,
    contribution: { APPROACHING: -1, DWELLING: -2, DEPARTING: -1, CRUISING: 3 },
  },
  {
    name: 'motionStationary',
    active: (i) => i.motion === 'stationary',
    contribution: { APPROACHING: 0, DWELLING: 2, DEPARTING: -1, CRUISING: -2 },
  },
  {
    // 정거장 근처에서 큰 magnitude — 감속/가속 phase 신호 (방향은 velocity trend가 결정).
    // 첫 cycle처럼 prev 없을 때도 "near station에서 뭔가 일어나는 중"을 잡아 CRUISING 차단.
    name: 'highAccelNearStation',
    active: (i) =>
      i.nearestStationDistanceM !== undefined &&
      i.nearestStationDistanceM <= STATION_NEAR_RADIUS_M &&
      i.accelMagnitudeMean >= MOTION_ACCEL_THRESHOLD,
    contribution: { APPROACHING: 1, DWELLING: -1, DEPARTING: 1, CRUISING: -2 },
  },
  {
    // velocity 추세 — Δv ≤ -VELOCITY_DELTA_KMH (현재 < 이전): 감속 → APPROACHING.
    // prevKalmanKmh 없으면 비활성 (첫 cycle은 추세 신호 없음).
    name: 'velocityDecreasing',
    active: (i) =>
      i.prevKalmanKmh !== undefined &&
      i.prevKalmanKmh - i.kalmanKmh >= VELOCITY_DELTA_KMH,
    contribution: { APPROACHING: 3, DWELLING: 1, DEPARTING: -2, CRUISING: -1 },
  },
  {
    // velocity 추세 — Δv ≥ +VELOCITY_DELTA_KMH (현재 > 이전): 가속 → DEPARTING.
    name: 'velocityIncreasing',
    active: (i) =>
      i.prevKalmanKmh !== undefined &&
      i.kalmanKmh - i.prevKalmanKmh >= VELOCITY_DELTA_KMH,
    contribution: { APPROACHING: -2, DWELLING: -1, DEPARTING: 3, CRUISING: 1 },
  },
  {
    // 정거장 멀리 + 거의 정지 — 데이터 무효 (지하 dead zone 등) → CRUISING 안 가게 살짝 막음.
    name: 'farFromStationStill',
    active: (i) =>
      i.nearestStationDistanceM !== undefined &&
      i.nearestStationDistanceM > STATION_NEAR_RADIUS_M &&
      i.kalmanKmh <= STATIONARY_KMH,
    contribution: { APPROACHING: 0, DWELLING: 0, DEPARTING: 0, CRUISING: -2 },
  },
];

/**
 * score matrix 계산 + argmax + confidence 산출.
 *
 * confidence = (max - second_max) / Σ|score|
 *   - 두 phase가 점수 동률이면 0 (불확실)
 *   - 한 phase만 크게 압도하면 → 1에 근접
 *
 * Σ|score|이 0이면 confidence 0 (signal 부재). 호출자가 hysteresis 적용 시 신중하게 처리.
 */
export function classifyStationPhase(inputs: ClassifyInputs): {
  phase: StationPhaseType;
  confidence: number;
  scores: PhaseScores;
} {
  const scores: PhaseScores = {
    APPROACHING: 0,
    DWELLING: 0,
    DEPARTING: 0,
    CRUISING: 0,
  };
  for (const feature of PHASE_FEATURES) {
    if (!feature.active(inputs)) continue;
    for (const phase of PHASES) {
      scores[phase] += feature.contribution[phase];
    }
  }

  // argmax
  let best: StationPhaseType = PHASES[0];
  let bestScore = scores[best];
  for (const phase of PHASES) {
    if (scores[phase] > bestScore) {
      best = phase;
      bestScore = scores[phase];
    }
  }
  // second max — best 제외 최댓값
  let secondScore = -Infinity;
  for (const phase of PHASES) {
    if (phase === best) continue;
    if (scores[phase] > secondScore) secondScore = scores[phase];
  }

  // normalize confidence — Σ|score|이 0이면 confidence 0.
  let totalAbs = 0;
  for (const phase of PHASES) {
    totalAbs += Math.abs(scores[phase]);
  }
  const confidence =
    totalAbs === 0 ? 0 : Math.max(0, Math.min(1, (bestScore - secondScore) / totalAbs));

  return { phase: best, confidence, scores };
}

/**
 * 2 cycle hysteresis 적용 + state transition.
 *
 *   - prev 없음: candidate가 곧 current (첫 평가는 곧바로 채택, 그러나 confidence는 boost 없음)
 *   - candidate == prev.current: state 유지, confidence boost (max 1.0)
 *   - candidate != prev.current:
 *      · candidate == prev.candidate → count++. count >= SWITCH_CYCLES면 전환.
 *      · 아니면 prev.candidate := candidate, count := 1
 *      · 전환 안 됨 → current는 prev.current 유지, confidence는 boost 없음 (원본 그대로)
 *
 * hysteresis는 flicker 방지 — 한 cycle 흔들림이 phase 토글로 이어지지 않게 한다.
 */
export function applyPhaseHysteresis(
  classification: { phase: StationPhaseType; confidence: number },
  prev: StationPhaseState | undefined,
  now: number,
): StationPhaseState {
  const candidate = classification.phase;
  const baseConfidence = classification.confidence;

  if (!prev) {
    return {
      current: candidate,
      confidence: baseConfidence,
      lastEvaluatedAt: now,
    };
  }

  if (candidate === prev.current) {
    return {
      current: prev.current,
      confidence: Math.min(1, baseConfidence + SAME_PHASE_BOOST),
      lastEvaluatedAt: now,
    };
  }

  // candidate가 prev.candidate와 동일하면 count++. 임계 도달 시 전환.
  const nextCount =
    prev.candidate === candidate ? (prev.candidateCount ?? 0) + 1 : 1;
  if (nextCount >= SWITCH_CYCLES) {
    return {
      current: candidate,
      confidence: baseConfidence,
      lastEvaluatedAt: now,
    };
  }
  return {
    current: prev.current,
    confidence: prev.confidence,
    candidate,
    candidateCount: nextCount,
    lastEvaluatedAt: now,
  };
}

/**
 * 한 cycle의 phase 분류 + hysteresis 적용 — scheduled.ts에서 호출하는 진입점.
 *
 *   - nearestStationDistanceM 없으면 분류 skip — `null` 반환. 기존 state는 호출자가 그대로 유지.
 *     (klient #834에서 wire되기 전까지 자연 회귀 없음.)
 *   - 있으면 classify + hysteresis → 새 state 반환.
 */
export function runStationPhaseStep(
  inputs: ClassifyInputs,
  prev: StationPhaseState | undefined,
): StationPhaseState | null {
  if (inputs.nearestStationDistanceM === undefined) return null;
  const classification = classifyStationPhase(inputs);
  return applyPhaseHysteresis(classification, prev, inputs.now);
}

/** imminent push 발사 허용 phase (SSOT — E5 측정 후 조정 가능). */
export const IMMINENT_FIRING_PHASES: readonly StationPhaseType[] = ['APPROACHING'];
/** imminent gate confidence 임계. 낮은 신뢰는 기존 신호에 위임 (false positive 방지보다 회귀 회피). */
export const IMMINENT_FIRING_CONFIDENCE = 0.7;

/**
 * imminent silent push 발사 허용 여부 (#825 게이트 wire).
 *
 *   - phaseState null (분류 신호 부재) → 허용 (기존 동작 유지, #834 wire 전까지 회귀 없음)
 *   - confidence < IMMINENT_FIRING_CONFIDENCE → 허용 (낮은 신뢰는 기존 arvlCd/ETA 신호에 위임)
 *   - confidence ≥ 임계 + phase ∈ IMMINENT_FIRING_PHASES → 허용
 *   - 그 외 (high-confidence non-APPROACHING, 예: CRUISING with conf 0.9) → 차단
 *
 * 정책: "phase 신호가 강하게 '지금 임박 아니다'"라고 말할 때만 발사를 막는다.
 * 낮은 신뢰 또는 신호 부재면 기존 동작 그대로 — gate는 **false positive 1차 차단**용.
 */
export function phaseAllowsImminentFiring(state: StationPhaseState | null): boolean {
  if (!state) return true;
  if (state.confidence < IMMINENT_FIRING_CONFIDENCE) return true;
  return IMMINENT_FIRING_PHASES.includes(state.current);
}
