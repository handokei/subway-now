import { describe, expect, it } from 'vitest';
import {
  EARLY_THRESHOLD_SEC,
  IMMINENT_THRESHOLD_SEC,
  evaluatePhase,
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
