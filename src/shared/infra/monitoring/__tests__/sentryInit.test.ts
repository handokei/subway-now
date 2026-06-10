import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';
import { getSentryOptIn, initSentryIfOptedIn, setSentryOptIn } from '../sentryInit';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));
jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  close: jest.fn(),
}));

const getItemMock = AsyncStorage.getItem as jest.Mock;
const setItemMock = AsyncStorage.setItem as jest.Mock;
const initMock = Sentry.init as jest.Mock;
const closeMock = Sentry.close as jest.Mock;

const originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

beforeEach(() => {
  getItemMock.mockReset();
  setItemMock.mockReset();
  initMock.mockReset();
  closeMock.mockReset();
  delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  if (originalDsn !== undefined) {
    process.env.EXPO_PUBLIC_SENTRY_DSN = originalDsn;
  }
});

describe('initSentryIfOptedIn', () => {
  it('opt-in 키가 없으면 Sentry.init 호출하지 않음 (default OFF)', async () => {
    getItemMock.mockResolvedValueOnce(null);
    await initSentryIfOptedIn();
    expect(initMock).not.toHaveBeenCalled();
  });

  it('opt-in 값이 "true"가 아니면 init 안 함', async () => {
    getItemMock.mockResolvedValueOnce('false');
    await initSentryIfOptedIn();
    expect(initMock).not.toHaveBeenCalled();
  });

  it('opt-in true + DSN 미설정 → graceful no-op (init 호출 안 함)', async () => {
    getItemMock.mockResolvedValueOnce('true');
    await initSentryIfOptedIn();
    expect(initMock).not.toHaveBeenCalled();
  });

  it('opt-in true + DSN 있음 → Sentry.init 호출', async () => {
    getItemMock.mockResolvedValueOnce('true');
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/123';
    await initSentryIfOptedIn();
    expect(initMock).toHaveBeenCalledWith({ dsn: 'https://test@sentry.io/123' });
  });

  it('AsyncStorage throw → throw 전파하지 않음 (boot path 비차단)', async () => {
    getItemMock.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(initSentryIfOptedIn()).resolves.toBeUndefined();
    expect(initMock).not.toHaveBeenCalled();
  });

  it('Sentry.init throw → swallow (boot path 비차단)', async () => {
    getItemMock.mockResolvedValueOnce('true');
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/123';
    initMock.mockImplementationOnce(() => {
      throw new Error('sentry boom');
    });
    await expect(initSentryIfOptedIn()).resolves.toBeUndefined();
  });
});

describe('setSentryOptIn', () => {
  it('enabled=true: storage에 "true" 저장 + DSN 있으면 Sentry.init', async () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/123';
    setItemMock.mockResolvedValueOnce(undefined);
    await setSentryOptIn(true);
    expect(setItemMock).toHaveBeenCalledWith('subway-now:sentry-opt-in', 'true');
    expect(initMock).toHaveBeenCalledWith({ dsn: 'https://test@sentry.io/123' });
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('enabled=true + DSN 미설정: storage 저장만 하고 init은 skip (graceful)', async () => {
    setItemMock.mockResolvedValueOnce(undefined);
    await setSentryOptIn(true);
    expect(setItemMock).toHaveBeenCalledWith('subway-now:sentry-opt-in', 'true');
    expect(initMock).not.toHaveBeenCalled();
  });

  it('enabled=false: storage에 "false" 저장 + Sentry.close', async () => {
    setItemMock.mockResolvedValueOnce(undefined);
    await setSentryOptIn(false);
    expect(setItemMock).toHaveBeenCalledWith('subway-now:sentry-opt-in', 'false');
    expect(closeMock).toHaveBeenCalled();
    expect(initMock).not.toHaveBeenCalled();
  });

  it('AsyncStorage 실패해도 SDK 토글은 계속 진행 (graceful)', async () => {
    setItemMock.mockRejectedValueOnce(new Error('storage boom'));
    await expect(setSentryOptIn(false)).resolves.toBeUndefined();
    expect(closeMock).toHaveBeenCalled();
  });

  it('Sentry SDK 토글 실패해도 throw하지 않음', async () => {
    setItemMock.mockResolvedValueOnce(undefined);
    closeMock.mockImplementationOnce(() => {
      throw new Error('close boom');
    });
    await expect(setSentryOptIn(false)).resolves.toBeUndefined();
  });
});

describe('getSentryOptIn', () => {
  it('"true" 저장값 → true', async () => {
    getItemMock.mockResolvedValueOnce('true');
    await expect(getSentryOptIn()).resolves.toBe(true);
  });

  it('null 저장값 → false (default OFF)', async () => {
    getItemMock.mockResolvedValueOnce(null);
    await expect(getSentryOptIn()).resolves.toBe(false);
  });

  it('"false" 저장값 → false', async () => {
    getItemMock.mockResolvedValueOnce('false');
    await expect(getSentryOptIn()).resolves.toBe(false);
  });

  it('AsyncStorage 실패 → false (default OFF)', async () => {
    getItemMock.mockRejectedValueOnce(new Error('storage boom'));
    await expect(getSentryOptIn()).resolves.toBe(false);
  });
});
