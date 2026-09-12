import { isMinimalAlarmEnabled } from '../debugFlags';

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
