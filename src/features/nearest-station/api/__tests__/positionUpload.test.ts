import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  defaultNearestStationResolver,
  dismissBoardingPrompt,
  readActiveBoardingLine,
  uploadPosition,
  withMapMatched,
  withNearestStationDistance,
} from '../positionUpload';
import { ACTIVE_BOARDING_LINE_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('../../../../utils/logger', () => ({
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

// #834 — 강남역 좌표(37.4979/127.0276) 기반 uploadPosition body 캡처 헬퍼.
// 두 신규 테스트가 공유하는 fetch mock setup + body 추출을 중복 없이 표현한다.
async function captureGangnamUploadBody(
  overrides: Partial<Parameters<typeof uploadPosition>[0]> = {},
): Promise<Record<string, unknown>> {
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
  (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
  await uploadPosition({
    token: 'tok',
    lat: 37.4979,
    lng: 127.0276,
    accuracy: 10,
    ts: 0,
    motion: 'automotive',
    ...overrides,
  });
  const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
  return JSON.parse(init.body);
}

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
    // #834: 한국 좌표는 defaultNearestStationResolver가 자동으로 nearestStationDistanceM을
    // 첨부하므로 exact toEqual 대신 핵심 필드만 비교한다.
    expect(JSON.parse(init.body)).toEqual(
      expect.objectContaining({
        token: 'tok',
        lat: 37.5,
        lng: 127,
        accuracy: 10,
        ts: 1234,
        motion: 'automotive',
      }),
    );
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

  it('#834: 한국 좌표(강남역) → body에 nearestStationDistanceM이 finite 양수', async () => {
    // ACTIVE_BOARDING_LINE_KEY 미설정 — mapMatched는 omit, nearestStationDistance만 첨부 확인.
    const body = await captureGangnamUploadBody();
    expect(typeof body.nearestStationDistanceM).toBe('number');
    expect(Number.isFinite(body.nearestStationDistanceM)).toBe(true);
    expect(body.nearestStationDistanceM).toBeGreaterThanOrEqual(0);
  });

  it('#834: 호출자가 명시 전달한 nearestStationDistanceM은 override (resolver 미호출)', async () => {
    // payload에 0 명시 → resolver를 호출하지 않고 그대로 직렬화 (스파이로 미호출 확인).
    const body = await captureGangnamUploadBody({ nearestStationDistanceM: 0 });
    expect(body.nearestStationDistanceM).toBe(0);
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

  it('resolver 주입 — 호출자가 지정한 line으로 snap 수행 (확장성)', async () => {
    // AsyncStorage 키에 의존하지 않고 명시 resolver만으로 snap 가능 — multi-trip/fallback 시나리오 확장점.
    // 2호선 강남역 좌표(matched) + resolver가 '2' 반환 → 결과에 mapMatched 필드가 채워짐.
    const out = await withMapMatched(
      {
        token: 'tok',
        lat: 37.4979,
        lng: 127.0276,
        accuracy: 0,
        ts: 0,
        motion: 'walking',
      },
      async () => '2',
    );
    expect(out.mapMatchedLine).toBe('2');
    expect(typeof out.mapMatchedArcM).toBe('number');
  });

  it('resolver가 null 반환 → snap skip (필드 omit)', async () => {
    const payload = {
      token: 'tok',
      lat: 37.4979,
      lng: 127.0276,
      accuracy: 0,
      ts: 0,
      motion: 'walking' as const,
    };
    const out = await withMapMatched(payload, async () => null);
    expect(out).toEqual(payload);
  });
});

describe('withNearestStationDistance (#834)', () => {
  it('명시 nearestStationDistanceM이 이미 있으면 그대로 반환 (resolver 미호출)', async () => {
    const resolver = jest.fn();
    const out = withNearestStationDistance(
      {
        token: 'tok',
        lat: 37.4979,
        lng: 127.0276,
        accuracy: 0,
        ts: 0,
        motion: 'walking',
        nearestStationDistanceM: 0,
      },
      resolver,
    );
    expect(out.nearestStationDistanceM).toBe(0);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('resolver 주입 — 호출자가 지정한 값으로 첨부 (확장성)', () => {
    // 측정 fixture / spatial index 등 호출자 단 확장 시나리오.
    const out = withNearestStationDistance(
      {
        token: 'tok',
        lat: 37.4979,
        lng: 127.0276,
        accuracy: 0,
        ts: 0,
        motion: 'walking',
      },
      () => 42,
    );
    expect(out.nearestStationDistanceM).toBe(42);
  });

  it('resolver가 undefined 반환 → 필드 omit (graceful)', () => {
    const payload = {
      token: 'tok',
      lat: 37.4979,
      lng: 127.0276,
      accuracy: 0,
      ts: 0,
      motion: 'walking' as const,
    };
    const out = withNearestStationDistance(payload, () => undefined);
    expect(out).toEqual(payload);
    expect(out.nearestStationDistanceM).toBeUndefined();
  });

  it('defaultNearestStationResolver — 한국 좌표 → finite 양수 m', () => {
    // findNearestStation은 maxDistanceKm 없이 호출되므로 지구 어디든 매칭은 되지만
    // 한국 좌표(강남역)에서는 실제 거리가 작은 값이어야 한다.
    const m = defaultNearestStationResolver(37.4979, 127.0276);
    expect(typeof m).toBe('number');
    expect(Number.isFinite(m)).toBe(true);
    expect(m).toBeGreaterThanOrEqual(0);
  });

  it('defaultNearestStationResolver — findNearestStation null → undefined (graceful 분기)', () => {
    // 실제 stations.json은 528개라 null이 나올 수 없지만, 안전 가드 분기를 커버하기 위해
    // 모듈을 mock해 null을 강제한다.
    jest.isolateModules(() => {
      jest.doMock('../../utils/findNearestStation', () => ({
        findNearestStation: () => null,
      }));
      const mod = require('../positionUpload');
      expect(mod.defaultNearestStationResolver(0, 0)).toBeUndefined();
    });
  });
});

describe('readActiveBoardingLine (#828)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('AsyncStorage 값이 stations.json line 코드면 LineNumber로 좁힘', async () => {
    await AsyncStorage.setItem(ACTIVE_BOARDING_LINE_KEY, '2');
    expect(await readActiveBoardingLine()).toBe('2');
  });

  it('유효하지 않은 line 코드(가짜 호선)는 null — isLineNumber 가드', async () => {
    await AsyncStorage.setItem(ACTIVE_BOARDING_LINE_KEY, 'fake-line-99');
    expect(await readActiveBoardingLine()).toBeNull();
  });

  it('키 부재 → null', async () => {
    expect(await readActiveBoardingLine()).toBeNull();
  });

  it('AsyncStorage throw → null (graceful)', async () => {
    const originalGetItem = AsyncStorage.getItem;
    (AsyncStorage.getItem as jest.Mock) = jest.fn().mockRejectedValue(new Error('boom'));
    expect(await readActiveBoardingLine()).toBeNull();
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
