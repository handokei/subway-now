import { dismissBoardingPrompt, uploadPosition } from '../positionUpload';

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('uploadPosition (#819)', () => {
  it('URL 미설정 시 skipped=true — fetch 미호출', async () => {
    const r = await uploadPosition({
      token: 't',
      lat: 1,
      lng: 2,
      accuracy: 5,
      ts: 0,
      motion: 'walking',
    });
    expect(r).toEqual({ ok: false, skipped: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('정상 응답 → ok=true + payload 직렬화', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
    const r = await uploadPosition({
      token: 'tok',
      lat: 37.5,
      lng: 127,
      accuracy: 10,
      ts: 1234,
      motion: 'automotive',
    });
    expect(r).toEqual({ ok: true, status: 200 });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test.dev/position');
    expect(JSON.parse(init.body)).toEqual({
      token: 'tok',
      lat: 37.5,
      lng: 127,
      accuracy: 10,
      ts: 1234,
      motion: 'automotive',
    });
  });

  it('non-OK status → ok=false + status', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 } as Response);
    const r = await uploadPosition({
      token: 'tok',
      lat: 0,
      lng: 0,
      accuracy: 0,
      ts: 0,
      motion: 'unknown',
    });
    expect(r).toEqual({ ok: false, status: 500 });
  });

  it('#823 accelSummary 포함 → body에 그대로 직렬화', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
    const accelSummary = {
      startTs: 1000,
      endTs: 2000,
      count: 100,
      ax: 0.1,
      ay: 0.2,
      az: 0.3,
      magnitudeMean: 0.5,
      magnitudeStd: 0.1,
      magnitudePeak: 1.2,
    };
    await uploadPosition({
      token: 'tok',
      lat: 37.5,
      lng: 127,
      accuracy: 10,
      ts: 1234,
      motion: 'automotive',
      accelSummary,
    });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body).accelSummary).toEqual(accelSummary);
  });

  it('fetch throw → ok=false (graceful)', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
    const r = await uploadPosition({
      token: 'tok',
      lat: 0,
      lng: 0,
      accuracy: 0,
      ts: 0,
      motion: 'unknown',
    });
    expect(r).toEqual({ ok: false });
  });

  it('5s 후 timeout abort — controller.abort 콜백 호출됨', async () => {
    // fetch가 abort signal을 받기까지 timer를 advance. setTimeout 콜백이 실행돼야
    // controller.abort()가 호출됨 (함수 커버리지 확보).
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const promise = uploadPosition({
      token: 'tok',
      lat: 0,
      lng: 0,
      accuracy: 0,
      ts: 0,
      motion: 'unknown',
    });
    jest.advanceTimersByTime(6000);
    const r = await promise;
    expect(r).toEqual({ ok: false });
    jest.useRealTimers();
  });
});

describe('dismissBoardingPrompt (#819)', () => {
  it('URL 미설정 → skipped', async () => {
    const r = await dismissBoardingPrompt('tok');
    expect(r.skipped).toBe(true);
  });

  it('빈 token → ok:false 즉시 반환 (fetch 미호출)', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    const r = await dismissBoardingPrompt('');
    expect(r).toEqual({ ok: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('정상 응답 → ok=true', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
    const r = await dismissBoardingPrompt('tok');
    expect(r).toEqual({ ok: true, status: 200 });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test.dev/boarding-prompt/dismiss');
    expect(JSON.parse(init.body)).toEqual({ token: 'tok' });
  });

  it('non-OK status → ok=false + status', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 } as Response);
    const r = await dismissBoardingPrompt('tok');
    expect(r).toEqual({ ok: false, status: 404 });
  });

  it('fetch throw → ok=false', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
    const r = await dismissBoardingPrompt('tok');
    expect(r).toEqual({ ok: false });
  });
});
