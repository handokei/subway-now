import { buildFeedbackContext, submitFeedback } from '../feedback';

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

jest.mock('i18next', () => ({
  __esModule: true,
  default: { language: 'ko-KR' },
}));

const ORIGINAL_FETCH = globalThis.fetch;

describe('buildFeedbackContext', () => {
  it('collects appVersion / platform / locale', () => {
    expect(buildFeedbackContext()).toEqual({
      appVersion: '9.9.9',
      platform: 'ios',
      locale: 'ko-KR',
    });
  });

  it('omits fields when underlying sources are missing', () => {
    const Constants = require('expo-constants').default as { expoConfig: { version?: string } };
    const RN = require('react-native') as { Platform: { OS: string } };
    const i18nMod = require('i18next').default as { language: string };
    const origVersion = Constants.expoConfig.version;
    const origOs = RN.Platform.OS;
    const origLang = i18nMod.language;
    try {
      Constants.expoConfig.version = undefined;
      RN.Platform.OS = 'web';
      i18nMod.language = '';
      expect(buildFeedbackContext()).toEqual({});
    } finally {
      Constants.expoConfig.version = origVersion;
      RN.Platform.OS = origOs;
      i18nMod.language = origLang;
    }
  });
});

describe('submitFeedback', () => {
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    globalThis.fetch = jest.fn();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('URL 미설정이면 skipped=true', async () => {
    const result = await submitFeedback('hi');
    expect(result).toEqual({ ok: false, skipped: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('정상 응답 시 ok=true + body 직렬화 확인', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 201 });
    const result = await submitFeedback('hello world');
    expect(result).toEqual({ ok: true, status: 201 });
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test/feedback');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.message).toBe('hello world');
    expect(body.context).toEqual({
      appVersion: '9.9.9',
      platform: 'ios',
      locale: 'ko-KR',
    });
  });

  it('non-2xx 응답이면 ok=false + status', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 400 });
    const result = await submitFeedback('m');
    expect(result).toEqual({ ok: false, status: 400 });
  });

  it('fetch throw 시 ok=false', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockRejectedValue(new Error('network'));
    const result = await submitFeedback('m');
    expect(result).toEqual({ ok: false });
  });

  it('aborts on timeout', async () => {
    jest.useFakeTimers();
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const promise = submitFeedback('m');
    await jest.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    expect(result).toEqual({ ok: false });
    jest.useRealTimers();
  });
});
