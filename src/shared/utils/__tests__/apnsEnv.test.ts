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
  warmupConfirmedApnsEnv,
  _resetApnsEnvCacheForTesting,
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
    // #1931 — module cache 격리. 매 case가 fresh warmup으로 시작.
    _resetApnsEnvCacheForTesting();
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

// #1931 — cold start race window 차단. warmup priming + cache 동작 검증.
describe('warmupConfirmedApnsEnv (#1931)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetApnsEnvCacheForTesting();
  });

  it.each(['sandbox', 'production'] as const)(
    'stamp=%s 일 때 첫 호출 → AsyncStorage read + 동일 값 반환',
    async (stamp) => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(stamp);
      await expect(warmupConfirmedApnsEnv()).resolves.toBe(stamp);
      expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
    },
  );

  it('stamp 부재 → null 반환', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    await expect(warmupConfirmedApnsEnv()).resolves.toBeNull();
  });

  it('stamp 값 오류 (legacy/오타) → null 반환', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('bogus');
    await expect(warmupConfirmedApnsEnv()).resolves.toBeNull();
  });

  it('AsyncStorage 실패 → graceful null 반환 (throw 없음)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('disk'));
    await expect(warmupConfirmedApnsEnv()).resolves.toBeNull();
  });

  it('multiple 호출 → 동일 promise cache (AsyncStorage.getItem 1회만)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('production');
    const [a, b, c] = await Promise.all([
      warmupConfirmedApnsEnv(),
      warmupConfirmedApnsEnv(),
      warmupConfirmedApnsEnv(),
    ]);
    expect(a).toBe('production');
    expect(b).toBe('production');
    expect(c).toBe('production');
    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
  });

  it('warmup 후 getRegisteringApnsEnv → 동일 cache 사용 (AsyncStorage 추가 read 없음)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('sandbox');
    await warmupConfirmedApnsEnv();
    await expect(getRegisteringApnsEnv()).resolves.toBe('sandbox');
    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
  });

  it('setConfirmedApnsEnv → cache invalidate + 다음 read 즉시 신규 값 반영', async () => {
    // 1차: warmup이 'sandbox' 반환.
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('sandbox');
    await expect(warmupConfirmedApnsEnv()).resolves.toBe('sandbox');

    // 2차: backend가 'production'으로 정정 → setConfirmedApnsEnv 호출.
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    await setConfirmedApnsEnv('production');

    // cache 가 신규 값으로 교체되어 추가 AsyncStorage read 없이 production 반환.
    await expect(warmupConfirmedApnsEnv()).resolves.toBe('production');
    // setItem 1회 + 최초 warmup의 getItem 1회 (cache 교체로 추가 read 없음).
    expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
  });
});
