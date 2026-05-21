import { resolveApnsEnv } from '../apnsEnv';

describe('resolveApnsEnv', () => {
  const original = process.env.EXPO_PUBLIC_APNS_ENV;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.EXPO_PUBLIC_APNS_ENV;
    } else {
      process.env.EXPO_PUBLIC_APNS_ENV = original;
    }
  });

  it('returns production when env explicitly set to production', () => {
    process.env.EXPO_PUBLIC_APNS_ENV = 'production';
    expect(resolveApnsEnv()).toBe('production');
  });

  it('returns sandbox when env explicitly set to sandbox', () => {
    process.env.EXPO_PUBLIC_APNS_ENV = 'sandbox';
    expect(resolveApnsEnv()).toBe('sandbox');
  });

  it('falls back to sandbox when env is unset', () => {
    delete process.env.EXPO_PUBLIC_APNS_ENV;
    expect(resolveApnsEnv()).toBe('sandbox');
  });

  it('falls back to sandbox when env has unknown value', () => {
    process.env.EXPO_PUBLIC_APNS_ENV = 'bogus';
    expect(resolveApnsEnv()).toBe('sandbox');
  });
});
