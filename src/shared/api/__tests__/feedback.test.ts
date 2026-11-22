import {
  buildFeedbackContext,
  FEEDBACK_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
  FEEDBACK_REQUEST_TIMEOUT_MS,
  submitFeedback,
} from '../feedback';

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

  describe('진단 첨부(#3366)', () => {
    const HEX64 = '3f9a1c7be24d5086a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

    beforeEach(() => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
      (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 201 });
    });

    const sentBody = () =>
      JSON.parse((globalThis.fetch as jest.Mock).mock.calls[0][1].body as string);

    it('options 없으면 body에 report·diagnostics 키가 없다(하위호환)', async () => {
      await submitFeedback('hello');
      const body = sentBody();
      expect(Object.keys(body).sort()).toEqual(['context', 'message']);
    });

    it('report·diagnostics를 body에 싣는다', async () => {
      await submitFeedback('m', {
        report: { category: 'alarm-missing', stationId: '2-211', tripKey: 'abcd1234', occurredAt: 1 },
        diagnostics: 'dump',
      });
      const body = sentBody();
      expect(body.report).toEqual({
        category: 'alarm-missing',
        stationId: '2-211',
        tripKey: 'abcd1234',
        occurredAt: 1,
      });
      expect(body.diagnostics).toBe('dump');
    });

    it('diagnostics는 송신 직전 방어 스크럽(좌표 문맥·40자 이상 hex)을 거친다', async () => {
      await submitFeedback('m', {
        diagnostics: `pos=37.54321,127.05432 /trips/${HEX64}/status arc=33.53`,
      });
      expect(sentBody().diagnostics).toBe('pos=[redacted] /trips/[token]/status arc=33.53');
    });

    it('진단 첨부 요청은 20s 타임아웃, message-only는 5s 유지', () => {
      expect(FEEDBACK_REQUEST_TIMEOUT_MS).toBe(5000);
      expect(FEEDBACK_DIAGNOSTICS_REQUEST_TIMEOUT_MS).toBe(20000);
    });

    it('진단 첨부 요청은 5s에 끊기지 않고 20s에 abort', async () => {
      jest.useFakeTimers();
      (globalThis.fetch as jest.Mock).mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      );
      try {
        const promise = submitFeedback('m', { diagnostics: 'dump' });
        let settled = false;
        void promise.then(() => {
          settled = true;
        });
        await jest.advanceTimersByTimeAsync(19_999);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(2);
        expect(await promise).toEqual({ ok: false });
      } finally {
        jest.useRealTimers();
      }
    });

    it('diagnostics 없이 report만 보내면 5s 타임아웃', async () => {
      jest.useFakeTimers();
      (globalThis.fetch as jest.Mock).mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      );
      try {
        const promise = submitFeedback('m', { report: { occurredAt: 1 } });
        await jest.advanceTimersByTimeAsync(5_001);
        expect(await promise).toEqual({ ok: false });
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
