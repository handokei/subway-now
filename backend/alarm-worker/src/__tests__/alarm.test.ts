import { describe, expect, it } from 'vitest';
import {
  ARRIVAL_CODE,
  EARLY_THRESHOLD_SEC,
  IMMINENT_THRESHOLD_SEC,
  evaluatePhase,
  evaluatePhaseFromSignal,
  isSignificantEtaChange,
  shouldFire,
} from '../alarm';

describe('evaluatePhase', () => {
  it('imminent below 30s', () => {
    expect(evaluatePhase(IMMINENT_THRESHOLD_SEC)).toBe('imminent');
    expect(evaluatePhase(0)).toBe('imminent');
  });
  it('early between 31s and EARLY_THRESHOLD_SEC', () => {
    expect(evaluatePhase(IMMINENT_THRESHOLD_SEC + 1)).toBe('early');
    expect(evaluatePhase(EARLY_THRESHOLD_SEC)).toBe('early');
    expect(evaluatePhase(240)).toBe('early');
  });
  it('null above early threshold', () => {
    expect(evaluatePhase(EARLY_THRESHOLD_SEC + 1)).toBeNull();
  });
});

describe('shouldFire', () => {
  it('fires when no lastFired', () => {
    expect(shouldFire('early')).toBe(true);
    expect(shouldFire('imminent')).toBe(true);
  });
  it('escalates early → imminent', () => {
    expect(shouldFire('imminent', 'early')).toBe(true);
  });
  it('blocks same phase', () => {
    expect(shouldFire('early', 'early')).toBe(false);
    expect(shouldFire('imminent', 'imminent')).toBe(false);
  });
  it('blocks regression imminent → early', () => {
    expect(shouldFire('early', 'imminent')).toBe(false);
  });
});

describe('evaluatePhaseFromSignal (#409 arvlCd + ETA fallback)', () => {
  const FAR_ETA = EARLY_THRESHOLD_SEC + 100; // ETA만으론 null인 거리

  it('arvlCd=ENTERING(0)이면 ETA와 무관하게 imminent', () => {
    expect(evaluatePhaseFromSignal(FAR_ETA, ARRIVAL_CODE.ENTERING)).toBe('imminent');
  });

  it('arvlCd=ARRIVED(1)이면 ETA와 무관하게 imminent', () => {
    expect(evaluatePhaseFromSignal(FAR_ETA, ARRIVAL_CODE.ARRIVED)).toBe('imminent');
  });

  it('arvlCd=PREV_ENTERING(4)이면 early', () => {
    expect(evaluatePhaseFromSignal(FAR_ETA, ARRIVAL_CODE.PREV_ENTERING)).toBe('early');
  });

  it('arvlCd=PREV_ARRIVED(5)이면 early', () => {
    expect(evaluatePhaseFromSignal(FAR_ETA, ARRIVAL_CODE.PREV_ARRIVED)).toBe('early');
  });

  it('arvlCd가 null이면 ETA fallback', () => {
    expect(evaluatePhaseFromSignal(IMMINENT_THRESHOLD_SEC, null)).toBe('imminent');
    expect(evaluatePhaseFromSignal(EARLY_THRESHOLD_SEC, null)).toBe('early');
    expect(evaluatePhaseFromSignal(FAR_ETA, null)).toBeNull();
  });

  it('arvlCd가 비매칭 코드(2,3,99)면 ETA fallback', () => {
    expect(evaluatePhaseFromSignal(10, 2)).toBe('imminent'); // ETA가 imminent
    expect(evaluatePhaseFromSignal(150, 3)).toBe('early'); // ETA가 early
    expect(evaluatePhaseFromSignal(FAR_ETA, 99)).toBeNull(); // ETA도 미달
  });
});

describe('isSignificantEtaChange', () => {
  it('true when prev is undefined', () => {
    expect(isSignificantEtaChange(undefined, 100)).toBe(true);
  });
  it('true when delta >= 60s', () => {
    expect(isSignificantEtaChange(100, 40)).toBe(true);
    expect(isSignificantEtaChange(40, 100)).toBe(true);
  });
  it('false when delta < 60s', () => {
    expect(isSignificantEtaChange(100, 50)).toBe(false);
    expect(isSignificantEtaChange(100, 100)).toBe(false);
  });
});
