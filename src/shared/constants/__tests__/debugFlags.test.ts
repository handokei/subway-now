import { isMinimalAlarmEnabled, isLocalFireDeferEnabled } from '../debugFlags';

describe('isMinimalAlarmEnabled', () => {
  const originalEnv = process.env.EXPO_PUBLIC_MINIMAL_ALARM;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
    } else {
      process.env.EXPO_PUBLIC_MINIMAL_ALARM = originalEnv;
    }
  });

  it('EXPO_PUBLIC_MINIMAL_ALARM 미설정 시 false (기본값 — 회귀 가드)', () => {
    delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
    expect(isMinimalAlarmEnabled()).toBe(false);
  });

  it('EXPO_PUBLIC_MINIMAL_ALARM="true"일 때 true', () => {
    process.env.EXPO_PUBLIC_MINIMAL_ALARM = 'true';
    expect(isMinimalAlarmEnabled()).toBe(true);
  });

  it('EXPO_PUBLIC_MINIMAL_ALARM이 "true" 이외 값이면 false', () => {
    process.env.EXPO_PUBLIC_MINIMAL_ALARM = 'false';
    expect(isMinimalAlarmEnabled()).toBe(false);
  });
});

// #2927 (ADR-040 2단계) — device 로컬 FG 보조 발사를 "즉시"에서 "유예 후 backend 미수신
// 확인"으로 축소하는 전환 스위치. isMinimalAlarmEnabled와 동일 패턴(ⓓ: OFF 기본값 보장).
describe('isLocalFireDeferEnabled', () => {
  const originalEnv = process.env.EXPO_PUBLIC_LOCAL_FIRE_DEFER;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EXPO_PUBLIC_LOCAL_FIRE_DEFER;
    } else {
      process.env.EXPO_PUBLIC_LOCAL_FIRE_DEFER = originalEnv;
    }
  });

  it('EXPO_PUBLIC_LOCAL_FIRE_DEFER 미설정 시 false (기본값 — ⓓ 회귀 가드)', () => {
    delete process.env.EXPO_PUBLIC_LOCAL_FIRE_DEFER;
    expect(isLocalFireDeferEnabled()).toBe(false);
  });

  it('EXPO_PUBLIC_LOCAL_FIRE_DEFER="true"일 때 true', () => {
    process.env.EXPO_PUBLIC_LOCAL_FIRE_DEFER = 'true';
    expect(isLocalFireDeferEnabled()).toBe(true);
  });

  it('EXPO_PUBLIC_LOCAL_FIRE_DEFER가 "true" 이외 값이면 false', () => {
    process.env.EXPO_PUBLIC_LOCAL_FIRE_DEFER = 'false';
    expect(isLocalFireDeferEnabled()).toBe(false);
  });
});
