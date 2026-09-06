/**
 * stationPhase.ts 단위 테스트 (#825 Phase 3 E3).
 *
 * 검증 대상:
 *   - classifyStationPhase: 4 golden 시나리오 + 경계값 + score/confidence 수치 + 동률
 *   - applyPhaseHysteresis: 전이 패턴 6가지 (신규/유지/boost/전환/후보 accumulate/후보 reset)
 *   - runStationPhaseStep: nearestStationDistanceM 존재 여부 분기
 *   - phaseAllowsImminentFiring: 4가지 정책 경로
 */

import { describe, expect, it } from 'vitest';
import {
  applyPhaseHysteresis,
  classifyStationPhase,
  IMMINENT_FIRING_CONFIDENCE,
  IMMINENT_FIRING_PHASES,
  MOTION_ACCEL_THRESHOLD,
  PHASES,
  phaseAllowsImminentFiring,
  runStationPhaseStep,
  SAME_PHASE_BOOST,
  STATION_DWELL_RADIUS_M,
  STATION_NEAR_RADIUS_M,
  STATIONARY_KMH,
  SWITCH_CYCLES,
  CRUISE_KMH,
} from '../stationPhase';
import type { StationPhaseState } from '../types';

const NOW = 1_700_000_000_000;

/** 기본 입력 팩토리 — 필요한 필드만 override. */
function makeInputs(
  overrides: Partial<{
    kalmanKmh: number;
    prevKalmanKmh: number | undefined;
    accelMagnitudeMean: number;
    accelMagnitudeStd: number;
    nearestStationDistanceM: number | undefined;
    motion: 'stationary' | 'walking' | 'automotive' | 'unknown';
    now: number;
  }> = {},
) {
  return {
    kalmanKmh: 15,
    prevKalmanKmh: undefined as number | undefined,
    accelMagnitudeMean: 0.3,
    accelMagnitudeStd: 0.2,
    nearestStationDistanceM: undefined as number | undefined,
    motion: 'unknown' as const,
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyStationPhase — 4 golden 시나리오
// ---------------------------------------------------------------------------
describe('classifyStationPhase — golden scenarios', () => {
  it('APPROACHING: 정거장 100m + kalmanV 4km/h(감속) + accel 0.8 + automotive', () => {
    // dist=100(≤200) → stationVicinity+highAccelNearStation 활성
    // kmh=4(≤5)  → slowOrStop 활성 → APPROACHING+1 추가 기여로 DEPARTING과 분리
    // scores: APPROACHING=4, DWELLING=2, DEPARTING=2, CRUISING=-4 → 명확한 단독 1위
    const result = classifyStationPhase(
      makeInputs({
        nearestStationDistanceM: 100,
        kalmanKmh: 4,
        accelMagnitudeMean: 0.8,
        motion: 'automotive',
      }),
    );
    expect(result.phase).toBe('APPROACHING');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    // APPROACHING이 최대 점수
    expect(result.scores.APPROACHING).toBeGreaterThan(result.scores.DWELLING);
    expect(result.scores.APPROACHING).toBeGreaterThan(result.scores.DEPARTING);
    expect(result.scores.APPROACHING).toBeGreaterThan(result.scores.CRUISING);
  });

  it('DWELLING: 정거장 20m + kalmanV 2km/h + accel 0.1 + stationary', () => {
    const result = classifyStationPhase(
      makeInputs({
        nearestStationDistanceM: 20,
        kalmanKmh: 2,
        accelMagnitudeMean: 0.1,
        motion: 'stationary',
      }),
    );
    expect(result.phase).toBe('DWELLING');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.scores.DWELLING).toBeGreaterThan(result.scores.APPROACHING);
    expect(result.scores.DWELLING).toBeGreaterThan(result.scores.CRUISING);
  });

  it('DEPARTING: 정거장 150m + kalmanV 12km/h + 직전 4km/h(가속 추세) + accel 0.6 + automotive', () => {
    // 정거장 근처(≤200) + velocityIncreasing(Δv≥+3) → DEPARTING이 단독 우세.
    // velocityIncreasing 기여: APPROACHING-2, DWELLING-1, DEPARTING+3, CRUISING+1
    // stationVicinity: 모두 +1, CRUISING -1
    // highAccelNearStation: A+1, D-1, Dep+1, C-2
    // → APPROACHING=0, DWELLING=-1, DEPARTING=5, CRUISING=-2
    const result = classifyStationPhase(
      makeInputs({
        nearestStationDistanceM: 150,
        kalmanKmh: 12,
        prevKalmanKmh: 4, // Δv=+8 ≥ VELOCITY_DELTA_KMH(3) → 가속 추세
        accelMagnitudeMean: 0.6,
        motion: 'automotive',
      }),
    );
    expect(result.phase).toBe('DEPARTING');
    expect(result.scores.DEPARTING).toBeGreaterThan(result.scores.APPROACHING);
    expect(result.scores.DEPARTING).toBeGreaterThan(result.scores.DWELLING);
    expect(result.scores.DEPARTING).toBeGreaterThan(result.scores.CRUISING);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('APPROACHING 추세 보강: 정거장 150m + kalmanV 8km/h + 직전 18km/h(감속 추세)', () => {
    // velocityDecreasing(Δv≤-3) → APPROACHING 단독 우세.
    // velocityDecreasing 기여: APPROACHING+3, DWELLING+1, DEPARTING-2, CRUISING-1
    const result = classifyStationPhase(
      makeInputs({
        nearestStationDistanceM: 150,
        kalmanKmh: 8,
        prevKalmanKmh: 18, // Δv=-10 ≤ -VELOCITY_DELTA_KMH → 감속 추세
        accelMagnitudeMean: 0.6,
        motion: 'automotive',
      }),
    );
    expect(result.phase).toBe('APPROACHING');
    expect(result.scores.APPROACHING).toBeGreaterThan(result.scores.DEPARTING);
  });

  it('CRUISING: 정거장 500m + kalmanV 35km/h + accel 0.2 + automotive', () => {
    const result = classifyStationPhase(
      makeInputs({
        nearestStationDistanceM: 500,
        kalmanKmh: 35,
        accelMagnitudeMean: 0.2,
        motion: 'automotive',
      }),
    );
    expect(result.phase).toBe('CRUISING');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.scores.CRUISING).toBeGreaterThan(result.scores.APPROACHING);
    expect(result.scores.CRUISING).toBeGreaterThan(result.scores.DWELLING);
  });
});

// ---------------------------------------------------------------------------
// classifyStationPhase — confidence 수치 검증
// ---------------------------------------------------------------------------
describe('classifyStationPhase — confidence 수치 검증', () => {
  it('confidence는 항상 0 이상 1 이하', () => {
    // APPROACHING 시나리오
    const r1 = classifyStationPhase(
      makeInputs({ nearestStationDistanceM: 100, kalmanKmh: 10, accelMagnitudeMean: 0.8, motion: 'automotive' }),
    );
    expect(r1.confidence).toBeGreaterThanOrEqual(0);
    expect(r1.confidence).toBeLessThanOrEqual(1);

    // CRUISING 시나리오
    const r2 = classifyStationPhase(
      makeInputs({ nearestStationDistanceM: 500, kalmanKmh: 35, accelMagnitudeMean: 0.2 }),
    );
    expect(r2.confidence).toBeGreaterThanOrEqual(0);
    expect(r2.confidence).toBeLessThanOrEqual(1);
  });

  it('모든 feature 비활성(신호 전무) → Σ|score|=0 → confidence=0', () => {
    // nearestStationDistanceM=undefined 이면 거리 기반 feature 모두 비활성.
    // kalmanKmh는 STATIONARY_KMH 초과 + CRUISE_KMH 미만 → slowOrStop/cruiseSpeed 모두 비활성.
    // motion='unknown' → motionStationary 비활성.
    // accelMagnitudeMean < 0.5 → highAccelNearStation 비활성.
    const result = classifyStationPhase(
      makeInputs({
        nearestStationDistanceM: undefined,
        kalmanKmh: 10, // 5 초과 + 20 미만 → slowOrStop/cruiseSpeed 둘 다 비활성
        accelMagnitudeMean: 0.1,
        motion: 'unknown',
      }),
    );
    // 모든 feature가 비활성이면 score는 전부 0 → Σ|score|=0 → confidence=0
    expect(Object.values(result.scores).every((s) => s === 0)).toBe(true);
    expect(result.confidence).toBe(0);
  });

  it('두 phase 동률 → confidence 공식에서 gap=0이면 0', () => {
    // APPROACHING과 DEPARTING이 동점이 되는 입력:
    // stationVicinity(1+1+1+1=각 1) + highAccelNearStation(2+2) → APPROACHING=3, DEPARTING=3
    // slowOrStop 비활성, cruiseSpeed 비활성, motionStationary 비활성
    // nearestStationDistanceM = 100(≤200 ≤200) — stationVicinity 활성화, highAccelNearStation 활성화
    // kalmanKmh = 10 (5 초과, 20 미만)
    // accelMagnitudeMean = 0.6 (≥0.5 → highAccelNearStation 활성)
    const result = classifyStationPhase(
      makeInputs({
        nearestStationDistanceM: 100,
        kalmanKmh: 10,
        accelMagnitudeMean: 0.6,
        motion: 'unknown',
      }),
    );
    // stationVicinity: APPROACHING+1, DWELLING+1, DEPARTING+1, CRUISING-1
    // highAccelNearStation: APPROACHING+2, DWELLING-1, DEPARTING+2, CRUISING-1
    // → APPROACHING=3, DWELLING=0, DEPARTING=3, CRUISING=-2
    // 동률이면 argmax는 첫 번째(APPROACHING) 선택
    expect(result.phase).toBe('APPROACHING');
    // confidence = (3-3)/Σ|score| = 0
    expect(result.confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyStationPhase — 경계값 테스트
// ---------------------------------------------------------------------------
describe('classifyStationPhase — feature 활성 경계값', () => {
  describe('STATION_NEAR_RADIUS_M (=200m) 경계', () => {
    it('nearestStationDistanceM=199 → stationVicinity 활성', () => {
      const inside = classifyStationPhase(
        makeInputs({ nearestStationDistanceM: 199, kalmanKmh: 25 }),
      );
      // stationVicinity 활성 → CRUISING에 -1 기여 → cruiseSpeed(+3)를 상쇄해 confidence 감소
      const outside = classifyStationPhase(
        makeInputs({ nearestStationDistanceM: 201, kalmanKmh: 25 }),
      );
      // 거리만 다른 두 경우: 199m일 때 stationVicinity가 CRUISING score에 -1 추가
      expect(inside.scores.CRUISING).toBeLessThan(outside.scores.CRUISING);
    });

    it('nearestStationDistanceM=200 → stationVicinity 활성 (≤ 포함)', () => {
      // kmh=12: slowOrStop/cruiseSpeed 모두 비활성 → stationVicinity 기여만 반영
      const at = classifyStationPhase(
        makeInputs({ nearestStationDistanceM: STATION_NEAR_RADIUS_M, kalmanKmh: 12, accelMagnitudeMean: 0.3 }),
      );
      expect(at.scores.APPROACHING).toBeGreaterThan(0); // stationVicinity 기여 (+1)
    });

    it('nearestStationDistanceM=201 → stationVicinity 비활성', () => {
      const outside = classifyStationPhase(
        makeInputs({ nearestStationDistanceM: 201, kalmanKmh: 25 }),
      );
      // stationVicinity 비활성 → APPROACHING에 +1 기여 없음
      const inside = classifyStationPhase(
        makeInputs({ nearestStationDistanceM: 199, kalmanKmh: 25 }),
      );
      expect(outside.scores.APPROACHING).toBeLessThan(inside.scores.APPROACHING);
    });
  });

  describe('STATIONARY_KMH (=5km/h) 경계', () => {
    it('kalmanKmh=5 → slowOrStop 활성 (≤ 포함)', () => {
      const at = classifyStationPhase(makeInputs({ kalmanKmh: STATIONARY_KMH }));
      const above = classifyStationPhase(makeInputs({ kalmanKmh: STATIONARY_KMH + 0.1 }));
      // slowOrStop 활성 시 DWELLING+2 기여 → at의 DWELLING이 above보다 높아야 함
      expect(at.scores.DWELLING).toBeGreaterThan(above.scores.DWELLING);
    });

    it('kalmanKmh=5.1 → slowOrStop 비활성', () => {
      const result = classifyStationPhase(makeInputs({ kalmanKmh: 5.1 }));
      const below = classifyStationPhase(makeInputs({ kalmanKmh: 4.9 }));
      expect(result.scores.DWELLING).toBeLessThan(below.scores.DWELLING);
    });
  });

  describe('CRUISE_KMH (=20km/h) 경계', () => {
    it('kalmanKmh=20 → cruiseSpeed 활성 (≥ 포함)', () => {
      const at = classifyStationPhase(makeInputs({ kalmanKmh: CRUISE_KMH }));
      const below = classifyStationPhase(makeInputs({ kalmanKmh: CRUISE_KMH - 0.1 }));
      // cruiseSpeed 활성 시 CRUISING+3 기여
      expect(at.scores.CRUISING).toBeGreaterThan(below.scores.CRUISING);
    });

    it('kalmanKmh=19.9 → cruiseSpeed 비활성', () => {
      const result = classifyStationPhase(makeInputs({ kalmanKmh: 19.9 }));
      const above = classifyStationPhase(makeInputs({ kalmanKmh: 20.1 }));
      expect(result.scores.CRUISING).toBeLessThan(above.scores.CRUISING);
    });
  });

  describe('MOTION_ACCEL_THRESHOLD (=0.5) + 근처 역 경계', () => {
    it('accelMagnitudeMean=0.5 + 근처(100m) → highAccelNearStation 활성', () => {
      const at = classifyStationPhase(
        makeInputs({
          nearestStationDistanceM: 100,
          accelMagnitudeMean: MOTION_ACCEL_THRESHOLD,
          kalmanKmh: 10,
        }),
      );
      const below = classifyStationPhase(
        makeInputs({
          nearestStationDistanceM: 100,
          accelMagnitudeMean: MOTION_ACCEL_THRESHOLD - 0.01,
          kalmanKmh: 10,
        }),
      );
      // highAccelNearStation 활성 → APPROACHING+2
      expect(at.scores.APPROACHING).toBeGreaterThan(below.scores.APPROACHING);
    });

    it('accelMagnitudeMean=0.49 → highAccelNearStation 비활성 (feature contribution 없음)', () => {
      const result = classifyStationPhase(
        makeInputs({
          nearestStationDistanceM: 100,
          accelMagnitudeMean: 0.49,
          kalmanKmh: 10,
        }),
      );
      const above = classifyStationPhase(
        makeInputs({
          nearestStationDistanceM: 100,
          accelMagnitudeMean: 0.51,
          kalmanKmh: 10,
        }),
      );
      // 0.49는 feature 비활성이므로 APPROACHING 점수가 더 낮음
      expect(result.scores.APPROACHING).toBeLessThan(above.scores.APPROACHING);
    });
  });

  describe('STATION_DWELL_RADIUS_M (=50m) 경계', () => {
    it('nearestStationDistanceM=50 → dwellingZone 활성 (≤ 포함)', () => {
      const at = classifyStationPhase(
        makeInputs({ nearestStationDistanceM: STATION_DWELL_RADIUS_M, kalmanKmh: 2, motion: 'stationary' }),
      );
      expect(at.scores.DWELLING).toBeGreaterThan(0); // dwellingZone +2 + stationVicinity +1 + slowOrStop +2 + motionStationary +2
    });

    it('nearestStationDistanceM=51 → dwellingZone 비활성', () => {
      const outside = classifyStationPhase(
        makeInputs({ nearestStationDistanceM: 51, kalmanKmh: 2, motion: 'stationary' }),
      );
      const inside = classifyStationPhase(
        makeInputs({ nearestStationDistanceM: 49, kalmanKmh: 2, motion: 'stationary' }),
      );
      // dwellingZone 활성/비활성 차이: DWELLING+2
      expect(inside.scores.DWELLING).toBeGreaterThan(outside.scores.DWELLING);
    });
  });

  describe('farFromStationStill feature', () => {
    it('정거장 먼 거리(>200m) + 저속 → farFromStationStill 활성 → CRUISING-2', () => {
      const far = classifyStationPhase(
        makeInputs({ nearestStationDistanceM: 300, kalmanKmh: 2 }),
      );
      const near = classifyStationPhase(
        makeInputs({ nearestStationDistanceM: 100, kalmanKmh: 2 }),
      );
      // farFromStationStill 활성 시 CRUISING에 -2 추가 → far의 CRUISING이 낮아야 함
      expect(far.scores.CRUISING).toBeLessThan(near.scores.CRUISING);
    });
  });
});

// ---------------------------------------------------------------------------
// classifyStationPhase — argmax 동률
// ---------------------------------------------------------------------------
describe('classifyStationPhase — argmax 동률', () => {
  it('최고 점수 phase가 여럿일 때 PHASES 배열 첫 번째가 선택됨', () => {
    // 앞 테스트에서 이미 확인: APPROACHING=3, DEPARTING=3 동률 → APPROACHING 선택
    const result = classifyStationPhase(
      makeInputs({
        nearestStationDistanceM: 100,
        kalmanKmh: 10,
        accelMagnitudeMean: 0.6,
        motion: 'unknown',
      }),
    );
    expect(result.phase).toBe(PHASES[0]); // 'APPROACHING'
  });
});

// ---------------------------------------------------------------------------
// applyPhaseHysteresis
// ---------------------------------------------------------------------------
describe('applyPhaseHysteresis', () => {
  it('prev=undefined → candidate가 current로 즉시 채택, candidateCount 미설정', () => {
    const result = applyPhaseHysteresis(
      { phase: 'CRUISING', confidence: 0.8 },
      undefined,
      NOW,
    );
    expect(result.current).toBe('CRUISING');
    expect(result.confidence).toBe(0.8);
    expect(result.candidate).toBeUndefined();
    expect(result.candidateCount).toBeUndefined();
    expect(result.lastEvaluatedAt).toBe(NOW);
  });

  it('candidate == prev.current → current 유지, confidence += SAME_PHASE_BOOST', () => {
    const prev: StationPhaseState = {
      current: 'CRUISING',
      confidence: 0.5,
      lastEvaluatedAt: NOW - 1000,
    };
    const result = applyPhaseHysteresis(
      { phase: 'CRUISING', confidence: 0.6 },
      prev,
      NOW,
    );
    expect(result.current).toBe('CRUISING');
    expect(result.confidence).toBeCloseTo(0.6 + SAME_PHASE_BOOST);
    expect(result.lastEvaluatedAt).toBe(NOW);
  });

  it('confidence boost가 1.0을 초과하면 1.0으로 clamp', () => {
    const prev: StationPhaseState = {
      current: 'CRUISING',
      confidence: 0.9,
      lastEvaluatedAt: NOW - 1000,
    };
    const result = applyPhaseHysteresis(
      { phase: 'CRUISING', confidence: 0.9 },
      prev,
      NOW,
    );
    expect(result.confidence).toBe(1.0);
  });

  it('candidate != prev.current + prev.candidate undefined → candidate 저장, count=1, current 유지', () => {
    const prev: StationPhaseState = {
      current: 'CRUISING',
      confidence: 0.8,
      lastEvaluatedAt: NOW - 1000,
    };
    const result = applyPhaseHysteresis(
      { phase: 'APPROACHING', confidence: 0.5 },
      prev,
      NOW,
    );
    expect(result.current).toBe('CRUISING'); // 아직 전환 안 됨
    expect(result.candidate).toBe('APPROACHING');
    expect(result.candidateCount).toBe(1);
    expect(result.confidence).toBe(prev.confidence); // boost 없음 → prev 값 유지
  });

  it('candidate == prev.candidate + count+1 < SWITCH_CYCLES → count 증가, current 유지', () => {
    // SWITCH_CYCLES=2 이므로 count=1 → nextCount=2 → 전환 발생
    // count=0 케이스 테스트 (count 1 미만 시)
    // SWITCH_CYCLES=2라면 1번 반복 후 count=1이 되어 아직 미달 (nextCount=1 < 2)
    const prev: StationPhaseState = {
      current: 'CRUISING',
      confidence: 0.8,
      candidate: 'APPROACHING',
      candidateCount: 0,
      lastEvaluatedAt: NOW - 1000,
    };
    // candidateCount=0 + 1 = 1, SWITCH_CYCLES=2 → 미달
    const result = applyPhaseHysteresis(
      { phase: 'APPROACHING', confidence: 0.5 },
      prev,
      NOW,
    );
    // SWITCH_CYCLES=2, nextCount=1 < 2 → 전환 안 됨
    expect(result.current).toBe('CRUISING');
    expect(result.candidate).toBe('APPROACHING');
    expect(result.candidateCount).toBe(1);
  });

  it('candidate == prev.candidate + count+1 >= SWITCH_CYCLES → 전환 (current=candidate)', () => {
    const prev: StationPhaseState = {
      current: 'CRUISING',
      confidence: 0.8,
      candidate: 'APPROACHING',
      candidateCount: SWITCH_CYCLES - 1, // 한 번 더 오면 전환
      lastEvaluatedAt: NOW - 1000,
    };
    const result = applyPhaseHysteresis(
      { phase: 'APPROACHING', confidence: 0.6 },
      prev,
      NOW,
    );
    expect(result.current).toBe('APPROACHING');
    expect(result.confidence).toBe(0.6);
    expect(result.candidate).toBeUndefined(); // 전환 후 candidate 초기화
    expect(result.lastEvaluatedAt).toBe(NOW);
  });

  it('candidate != prev.candidate → candidate reset, count=1', () => {
    const prev: StationPhaseState = {
      current: 'CRUISING',
      confidence: 0.8,
      candidate: 'APPROACHING',
      candidateCount: 1,
      lastEvaluatedAt: NOW - 1000,
    };
    // 이번엔 다른 phase로 바뀜
    const result = applyPhaseHysteresis(
      { phase: 'DWELLING', confidence: 0.4 },
      prev,
      NOW,
    );
    expect(result.current).toBe('CRUISING'); // 여전히 전환 안 됨
    expect(result.candidate).toBe('DWELLING');
    expect(result.candidateCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runStationPhaseStep
// ---------------------------------------------------------------------------
describe('runStationPhaseStep', () => {
  it('nearestStationDistanceM=undefined → null 반환 (phase 분류 skip)', () => {
    const result = runStationPhaseStep(
      makeInputs({ nearestStationDistanceM: undefined }),
      undefined,
    );
    expect(result).toBeNull();
  });

  it('nearestStationDistanceM 있으면 classify + hysteresis → StationPhaseState 반환', () => {
    const result = runStationPhaseStep(
      makeInputs({
        nearestStationDistanceM: 500,
        kalmanKmh: 35,
        accelMagnitudeMean: 0.2,
        motion: 'automotive',
      }),
      undefined,
    );
    expect(result).not.toBeNull();
    expect(result?.current).toBe('CRUISING');
    expect(result?.lastEvaluatedAt).toBe(NOW);
  });

  it('prev state가 있으면 hysteresis 적용됨 (같은 phase → boost)', () => {
    const prev: StationPhaseState = {
      current: 'CRUISING',
      confidence: 0.5,
      lastEvaluatedAt: NOW - 1000,
    };
    const result = runStationPhaseStep(
      makeInputs({
        nearestStationDistanceM: 500,
        kalmanKmh: 35,
        accelMagnitudeMean: 0.2,
        motion: 'automotive',
      }),
      prev,
    );
    expect(result?.current).toBe('CRUISING');
    // 같은 phase → confidence boost
    expect(result!.confidence).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// phaseAllowsImminentFiring
// ---------------------------------------------------------------------------
describe('phaseAllowsImminentFiring', () => {
  it('state=null → true (신호 부재 허용, 기존 동작 유지)', () => {
    expect(phaseAllowsImminentFiring(null)).toBe(true);
  });

  it('confidence < IMMINENT_FIRING_CONFIDENCE → true (낮은 신뢰 허용)', () => {
    const state: StationPhaseState = {
      current: 'CRUISING',
      confidence: IMMINENT_FIRING_CONFIDENCE - 0.01,
      lastEvaluatedAt: NOW,
    };
    expect(phaseAllowsImminentFiring(state)).toBe(true);
  });

  it('confidence=0 → true (낮은 신뢰 허용)', () => {
    const state: StationPhaseState = {
      current: 'DWELLING',
      confidence: 0,
      lastEvaluatedAt: NOW,
    };
    expect(phaseAllowsImminentFiring(state)).toBe(true);
  });

  it('confidence >= 임계 + phase=APPROACHING → true (허용 phase)', () => {
    const state: StationPhaseState = {
      current: 'APPROACHING',
      confidence: IMMINENT_FIRING_CONFIDENCE,
      lastEvaluatedAt: NOW,
    };
    expect(phaseAllowsImminentFiring(state)).toBe(true);
  });

  it.each([
    ['DWELLING', 'DWELLING'],
    ['DEPARTING', 'DEPARTING'],
    ['CRUISING', 'CRUISING'],
  ] as const)(
    'confidence >= 임계 + phase=%s → false (non-APPROACHING high-confidence 차단)',
    (_label, phase) => {
      const state: StationPhaseState = {
        current: phase,
        confidence: IMMINENT_FIRING_CONFIDENCE + 0.01,
        lastEvaluatedAt: NOW,
      };
      expect(phaseAllowsImminentFiring(state)).toBe(false);
    },
  );

  it('confidence=1.0 + CRUISING → false (완전 신뢰 차단)', () => {
    const state: StationPhaseState = {
      current: 'CRUISING',
      confidence: 1.0,
      lastEvaluatedAt: NOW,
    };
    expect(phaseAllowsImminentFiring(state)).toBe(false);
  });

  it('상수 export 검증 — IMMINENT_FIRING_PHASES에는 APPROACHING만 포함', () => {
    expect(IMMINENT_FIRING_PHASES).toContain('APPROACHING');
    expect(IMMINENT_FIRING_PHASES).not.toContain('DWELLING');
    expect(IMMINENT_FIRING_PHASES).not.toContain('DEPARTING');
    expect(IMMINENT_FIRING_PHASES).not.toContain('CRUISING');
  });
});

// ---------------------------------------------------------------------------
// 상수 export 검증
// ---------------------------------------------------------------------------
describe('상수 export', () => {
  it('PHASES는 4개 phase를 정해진 순서로 포함', () => {
    expect(PHASES).toEqual(['APPROACHING', 'DWELLING', 'DEPARTING', 'CRUISING']);
  });

  it('STATION_NEAR_RADIUS_M=200', () => {
    expect(STATION_NEAR_RADIUS_M).toBe(200);
  });

  it('STATION_DWELL_RADIUS_M=50', () => {
    expect(STATION_DWELL_RADIUS_M).toBe(50);
  });

  it('STATIONARY_KMH=5', () => {
    expect(STATIONARY_KMH).toBe(5);
  });

  it('CRUISE_KMH=20', () => {
    expect(CRUISE_KMH).toBe(20);
  });

  it('MOTION_ACCEL_THRESHOLD=0.5', () => {
    expect(MOTION_ACCEL_THRESHOLD).toBe(0.5);
  });

  it('SAME_PHASE_BOOST=0.2', () => {
    expect(SAME_PHASE_BOOST).toBe(0.2);
  });

  it('SWITCH_CYCLES=2', () => {
    expect(SWITCH_CYCLES).toBe(2);
  });

  it('IMMINENT_FIRING_CONFIDENCE=0.7', () => {
    expect(IMMINENT_FIRING_CONFIDENCE).toBe(0.7);
  });
});
