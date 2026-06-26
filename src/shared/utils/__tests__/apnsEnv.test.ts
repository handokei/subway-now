jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  resolveApnsEnv,
  getRegisteringApnsEnv,
  setConfirmedApnsEnv,
} from '../apnsEnv';
import { LAST_CONFIRMED_APNS_ENV_KEY } from '../../constants/storageKeys';

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

// #1897 (RC-5) — backend가 confirm한 env stamp + register 송신 우선순위 검증.
describe('getRegisteringApnsEnv / setConfirmedApnsEnv (#1897)', () => {
  const original = process.env.EXPO_PUBLIC_APNS_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.EXPO_PUBLIC_APNS_ENV;
    } else {
      process.env.EXPO_PUBLIC_APNS_ENV = original;
    }
  });

  it.each(['sandbox', 'production'] as const)(
    'stamp=%s 면 AsyncStorage stamp를 1순위로 반환 (build env 무시)',
    async (stamp) => {
      // build env는 정반대로 설정해 우선순위 검증.
      process.env.EXPO_PUBLIC_APNS_ENV = stamp === 'sandbox' ? 'production' : 'sandbox';
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(stamp);
      await expect(getRegisteringApnsEnv()).resolves.toBe(stamp);
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(LAST_CONFIRMED_APNS_ENV_KEY);
    },
  );

  it('stamp 부재 (첫 register) → resolveApnsEnv() fallback', async () => {
    process.env.EXPO_PUBLIC_APNS_ENV = 'production';
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    await expect(getRegisteringApnsEnv()).resolves.toBe('production');
  });

  it('stamp 값 오류 (legacy/오타) → resolveApnsEnv() fallback', async () => {
    process.env.EXPO_PUBLIC_APNS_ENV = 'sandbox';
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('bogus');
    await expect(getRegisteringApnsEnv()).resolves.toBe('sandbox');
  });

  it('AsyncStorage.getItem 실패 → graceful resolveApnsEnv() fallback', async () => {
    process.env.EXPO_PUBLIC_APNS_ENV = 'production';
    (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('disk'));
    await expect(getRegisteringApnsEnv()).resolves.toBe('production');
  });

  it.each(['sandbox', 'production'] as const)(
    'setConfirmedApnsEnv(%s) → AsyncStorage.setItem(KEY, env) 호출',
    async (env) => {
      (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
      await setConfirmedApnsEnv(env);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(LAST_CONFIRMED_APNS_ENV_KEY, env);
    },
  );

  it('setConfirmedApnsEnv: AsyncStorage 실패 → graceful (throw 없음)', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValue(new Error('disk'));
    await expect(setConfirmedApnsEnv('sandbox')).resolves.toBeUndefined();
  });
});
