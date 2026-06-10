import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';
import { initSentryIfOptedIn } from '../sentryInit';
import { isSentryEnabled, setSentryEnabled } from '../sentryState';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));
// @sentry/react-native는 jest.setup.js에서 글로벌 모킹됨.

const getItemMock = AsyncStorage.getItem as jest.Mock;
const initMock = Sentry.init as jest.Mock;

const originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

beforeEach(() => {
  getItemMock.mockReset();
  initMock.mockReset();
  delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  setSentryEnabled(false);
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

  it('opt-in true + DSN 있음 → Sentry.init 호출 + isSentryEnabled true', async () => {
    getItemMock.mockResolvedValueOnce('true');
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/123';
    await initSentryIfOptedIn();
    expect(initMock).toHaveBeenCalledWith({ dsn: 'https://test@sentry.io/123' });
    expect(isSentryEnabled()).toBe(true);
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
