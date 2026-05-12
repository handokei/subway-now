import { MAX_ACCURACY_M, MAX_ACCURACY_M_DISPLAY, MAX_LOCATION_AGE_MS } from '../../constants/location';
import { isAccuracyAcceptable, isAccuracyAcceptableForDisplay, isLocationFresh } from '../locationGates';

describe('isLocationFresh', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('timestamp가 undefined면 false', () => {
    expect(isLocationFresh(undefined)).toBe(false);
  });

  it('현재 시각이면 true', () => {
    expect(isLocationFresh(NOW)).toBe(true);
  });

  it('임계값과 정확히 같은 age면 true (경계 포함)', () => {
    expect(isLocationFresh(NOW - MAX_LOCATION_AGE_MS)).toBe(true);
  });

  it('임계값을 1ms 초과하면 false', () => {
    expect(isLocationFresh(NOW - MAX_LOCATION_AGE_MS - 1)).toBe(false);
  });
});

describe('isAccuracyAcceptable', () => {
  it('null이면 true (accuracy 정보 없음 = 통과)', () => {
    expect(isAccuracyAcceptable(null)).toBe(true);
  });

  it('undefined면 true', () => {
    expect(isAccuracyAcceptable(undefined)).toBe(true);
  });

  it('임계값과 정확히 같으면 true (경계 포함)', () => {
    expect(isAccuracyAcceptable(MAX_ACCURACY_M)).toBe(true);
  });

  it('임계값보다 작으면 true', () => {
    expect(isAccuracyAcceptable(MAX_ACCURACY_M - 1)).toBe(true);
  });

  it('임계값을 초과하면 false', () => {
    expect(isAccuracyAcceptable(MAX_ACCURACY_M + 1)).toBe(false);
  });
});

describe('isAccuracyAcceptableForDisplay', () => {
  it('null이면 true (accuracy 정보 없음 = 통과)', () => {
    expect(isAccuracyAcceptableForDisplay(null)).toBe(true);
  });

  it('undefined면 true', () => {
    expect(isAccuracyAcceptableForDisplay(undefined)).toBe(true);
  });

  it('표시 임계값과 정확히 같으면 true (경계 포함)', () => {
    expect(isAccuracyAcceptableForDisplay(MAX_ACCURACY_M_DISPLAY)).toBe(true);
  });

  it('표시 임계값을 초과하면 false', () => {
    expect(isAccuracyAcceptableForDisplay(MAX_ACCURACY_M_DISPLAY + 1)).toBe(false);
  });

  it('알람 임계값을 초과해도 표시 임계값 이내면 true (지하 구간 가정)', () => {
    expect(isAccuracyAcceptableForDisplay(MAX_ACCURACY_M + 1)).toBe(true);
  });
});
