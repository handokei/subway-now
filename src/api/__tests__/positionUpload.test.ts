import AsyncStorage from '@react-native-async-storage/async-storage';
import { dismissBoardingPrompt, uploadPosition, withMapMatched } from '../positionUpload';
import { ACTIVE_BOARDING_LINE_KEY } from '../../constants/storageKeys';

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const ORIGINAL_FETCH = global.fetch;

beforeEach(async () => {
  delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  global.fetch = jest.fn();
  await AsyncStorage.clear();
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

  it('#828: ACTIVE_BOARDING_LINE_KEY set → snap 결과가 body에 첨부', async () => {
    // 2호선 강남역(37.4979, 127.0276) 좌표 정확히 사용 → snap matched + arcM 출력.
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    await AsyncStorage.setItem(ACTIVE_BOARDING_LINE_KEY, '2');
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
    await uploadPosition({
      token: 'tok',
      lat: 37.4979,
      lng: 127.0276,
      accuracy: 10,
      ts: 0,
      motion: 'automotive',
    });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.mapMatchedLine).toBe('2');
    expect(typeof body.mapMatchedArcM).toBe('number');
    expect(body.mapMatchedArcM).toBeGreaterThanOrEqual(0);
  });

  it('#828: ACTIVE_BOARDING_LINE_KEY set but unmatched (멀리 떨어진 좌표) → 필드 omit', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    await AsyncStorage.setItem(ACTIVE_BOARDING_LINE_KEY, '2');
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
    // 노선에서 매우 먼 좌표 (남극 인근).
    await uploadPosition({
      token: 'tok',
      lat: -89,
      lng: 0,
      accuracy: 10,
      ts: 0,
      motion: 'automotive',
    });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.mapMatchedLine).toBeUndefined();
    expect(body.mapMatchedArcM).toBeUndefined();
  });

  it('#828: mirror 부재 → snap skip, body 그대로', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
    await uploadPosition({
      token: 'tok',
      lat: 37.4979,
      lng: 127.0276,
      accuracy: 10,
      ts: 0,
      motion: 'automotive',
    });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.mapMatchedLine).toBeUndefined();
    expect(body.mapMatchedArcM).toBeUndefined();
  });

  it('#828: 호출자가 명시 전달한 mapMatched 필드는 override (mirror snap 안 함)', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    await AsyncStorage.setItem(ACTIVE_BOARDING_LINE_KEY, '2');
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
    await uploadPosition({
      token: 'tok',
      lat: 37.4979,
      lng: 127.0276,
      accuracy: 10,
      ts: 0,
      motion: 'automotive',
      mapMatchedLine: '3',
      mapMatchedArcM: 999,
    });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.mapMatchedLine).toBe('3');
    expect(body.mapMatchedArcM).toBe(999);
  });

  it('5s 후 timeout abort — controller.abort 콜백 호출됨', async () => {
    // fetch가 abort signal을 받기까지 timer를 advance. setTimeout 콜백이 실행돼야
    // controller.abort()가 호출됨 (함수 커버리지 확보).
    // #828 — uploadPosition은 fetch 직전에 withMapMatched(AsyncStorage await)를 거치므로
    // advanceTimersByTimeAsync로 microtask까지 함께 흘려야 한다 (Async 버전이 promise도 진행).
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
    await jest.advanceTimersByTimeAsync(6000);
    const r = await promise;
    expect(r).toEqual({ ok: false });
    jest.useRealTimers();
  });
});

describe('withMapMatched (#828)', () => {
  it('명시 mapMatched 필드가 이미 있으면 그대로 반환 (snap 안 함)', async () => {
    await AsyncStorage.setItem(ACTIVE_BOARDING_LINE_KEY, '2');
    const out = await withMapMatched({
      token: 'tok',
      lat: 1,
      lng: 2,
      accuracy: 0,
      ts: 0,
      motion: 'walking',
      mapMatchedLine: 'x',
      mapMatchedArcM: 42,
    });
    expect(out.mapMatchedLine).toBe('x');
    expect(out.mapMatchedArcM).toBe(42);
  });

  it('AsyncStorage throw → 원본 payload 반환 (graceful)', async () => {
    const originalGetItem = AsyncStorage.getItem;
    (AsyncStorage.getItem as jest.Mock) = jest.fn().mockRejectedValue(new Error('storage down'));
    const payload = {
      token: 'tok',
      lat: 1,
      lng: 2,
      accuracy: 0,
      ts: 0,
      motion: 'walking' as const,
    };
    const out = await withMapMatched(payload);
    expect(out).toEqual(payload);
    AsyncStorage.getItem = originalGetItem;
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
