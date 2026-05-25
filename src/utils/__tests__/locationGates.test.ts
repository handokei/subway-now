import { MAX_ACCURACY_M, MAX_ACCURACY_M_DISPLAY, MAX_LOCATION_AGE_MS } from '../../constants/location';
import {
  isAccuracyAcceptable,
  isAccuracyAcceptableForDisplay,
  isLocationFresh,
  isPlausibleJump,
} from '../locationGates';

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

describe('isPlausibleJump', () => {
  // 효창공원앞 ≈ (37.5390, 126.9610), 신내 ≈ (37.6128, 127.0966) — 대략 25km 떨어진 두 점
  const HYOCHANG = { lat: 37.5390, lng: 126.9610 };
  const SINNAE = { lat: 37.6128, lng: 127.0966 };

  it('prev가 null이면 true (콜드 스타트)', () => {
    expect(isPlausibleJump(null, { ...HYOCHANG, timestamp: 1_700_000_000_000 })).toBe(true);
  });

  it('정상 도보/주행: 30s 동안 200m → true', () => {
    const prev = { lat: 37.5390, lng: 126.9610, timestamp: 1_700_000_000_000 };
    // 약 200m 북쪽 (0.0018° lat ≈ 200m)
    const curr = { lat: 37.5408, lng: 126.9610, timestamp: 1_700_000_030_000 };
    expect(isPlausibleJump(prev, curr)).toBe(true);
  });

  it('비현실 점프: 8s 동안 25km → false (21:29 사고)', () => {
    const prev = { ...HYOCHANG, timestamp: 1_700_000_000_000 };
    const curr = { ...SINNAE, timestamp: 1_700_000_008_000 };
    expect(isPlausibleJump(prev, curr)).toBe(false);
  });

  it('정지 시 GPS 노이즈: 5s 동안 5m → true', () => {
    const prev = { lat: 37.5390, lng: 126.9610, timestamp: 1_700_000_000_000 };
    // 약 5m 변동 (0.00005° lat ≈ 5.5m)
    const curr = { lat: 37.53905, lng: 126.9610, timestamp: 1_700_000_005_000 };
    expect(isPlausibleJump(prev, curr)).toBe(true);
  });

  it('timestamp 동일/역행: true (중복 fix 보호)', () => {
    const prev = { ...HYOCHANG, timestamp: 1_700_000_000_000 };
    const sameTs = { ...SINNAE, timestamp: 1_700_000_000_000 };
    const earlier = { ...SINNAE, timestamp: 1_699_999_999_000 };
    expect(isPlausibleJump(prev, sameTs)).toBe(true);
    expect(isPlausibleJump(prev, earlier)).toBe(true);
  });
});
