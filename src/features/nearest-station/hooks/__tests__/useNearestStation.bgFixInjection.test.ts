/**
 * #3191 PR-2 — (1) FG watch가 꺼져 있을 때만 BG task의 마지막 fix(BG_LAST_FIX_KEY)를 L로 주입,
 * (2) L 단조성 가드(과거/같은 timestamp fix는 표시 경로에 반영하지 않는다).
 *
 * 단조성 입력은 10/28 W 덤프 L738→L735의 실측 역행이다:
 *   06:26:51 fix(acc 67, watch=inactive) 다음에 06:26:34 fix(acc 45)가 다시 L이 됐다.
 * 값은 덤프 원문(시각/accuracy) 그대로 — 통과시키려고 조정 금지.
 */
import { renderHook, act } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNearestStation } from '../useNearestStation';
import { BG_FIX_INJECT_POLL_INTERVAL_MS } from '../../../../shared/constants/location';
import { BG_LAST_FIX_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('expo-location');

const appStateListeners: Array<(state: string) => void> = [];
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  appStateListeners.push(listener as (state: string) => void);
  return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
});

type WatchLocation = {
  coords: { latitude: number; longitude: number; speed?: number | null; accuracy?: number | null };
  timestamp: number;
};
let watchCallback: ((location: WatchLocation) => void) | null = null;
const mockSubscription = { remove: jest.fn() };

// 06:26:51 / 06:26:34 KST (2026-10-28) — W 덤프 L738 / L735. KST = UTC+9 이므로 전날 21시(UTC).
const T_0626_51 = Date.UTC(2026, 9, 27, 21, 26, 51);
const T_0626_34 = Date.UTC(2026, 9, 27, 21, 26, 34);

const YONGMASAN = { lat: 37.5741, lng: 127.0942 };
// 17초 안에 도달 가능한 거리(~290m < 50 m/s jump 게이트) - 좌표 자체는 테스트 입력일 뿐 실측 아님.
const JUNGGOK = { lat: 37.5715, lng: 127.0942 };

function bgFix(
  extra: Partial<{ lat: number; lng: number; timestamp: number; acc: number | null; speed: number | null }> = {},
) {
  return { ...YONGMASAN, timestamp: T_0626_51, acc: 11.5, speed: null, ...extra };
}

async function mount(inputs: Parameters<typeof useNearestStation>[0] = {}) {
  const hook = renderHook(() => useNearestStation(inputs));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  return hook;
}

async function tick() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(BG_FIX_INJECT_POLL_INTERVAL_MS);
  });
}

async function goBackground() {
  await act(async () => {
    appStateListeners.forEach((l) => l('background'));
    await jest.advanceTimersByTimeAsync(0);
  });
}

async function storeBgFix(fix: ReturnType<typeof bgFix>) {
  await AsyncStorage.setItem(BG_LAST_FIX_KEY, JSON.stringify(fix));
}

function watchFix(lat: number, lng: number, timestamp: number, accuracy: number) {
  act(() => {
    watchCallback?.({ coords: { latitude: lat, longitude: lng, speed: null, accuracy }, timestamp });
  });
}

function setupMocks() {
  jest.useFakeTimers();
  jest.clearAllMocks();
  appStateListeners.length = 0;
  watchCallback = null;
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Location.getLastKnownPositionAsync as jest.Mock).mockResolvedValue(null);
  (Location.watchPositionAsync as jest.Mock).mockImplementation(
    async (_o: unknown, cb: typeof watchCallback) => {
      watchCallback = cb;
      return mockSubscription;
    },
  );
}

describe('useNearestStation — BG fix 주입 (#3191 PR-2)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    setupMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('FG watch가 꺼져 있으면(BG 전환) BG fix를 L로 주입한다 - 좌표/accuracy/speed/시각', async () => {
    const { result } = await mount();
    await goBackground();
    await storeBgFix(bgFix({ acc: 11.5, speed: 0.2 }));
    await tick();

    expect(result.current.userLocation).toEqual(YONGMASAN);
    expect(result.current.accuracyMeters).toBe(11.5);
    expect(result.current.speedMps).toBe(0.2);
    expect(result.current.lastFixAtMs).toBe(T_0626_51);
    expect(result.current.lastFixFromBg).toBe(true);
  });

  it('FG watch 구독이 살아 있으면 주입하지 않는다 (0회)', async () => {
    const { result } = await mount();
    await storeBgFix(bgFix());
    await tick();

    expect(result.current.isWatchActive()).toBe(true);
    expect(result.current.userLocation).toBeNull();
    expect(result.current.lastFixFromBg).toBe(false);
  });

  it('키가 없으면 아무 일도 없다', async () => {
    const { result } = await mount();
    await goBackground();
    await tick();
    expect(result.current.userLocation).toBeNull();
  });

  it('같은 timestamp 재주입은 상태를 바꾸지 않는다 (좌표가 달라도)', async () => {
    const { result } = await mount();
    await goBackground();
    await storeBgFix(bgFix());
    await tick();
    await storeBgFix(bgFix({ ...JUNGGOK, acc: 5 }));
    await tick();

    expect(result.current.userLocation).toEqual(YONGMASAN);
    expect(result.current.accuracyMeters).toBe(11.5);
  });

  it('과거 timestamp는 주입하지 않는다', async () => {
    const { result } = await mount();
    await goBackground();
    await storeBgFix(bgFix());
    await tick();
    await storeBgFix(bgFix({ ...JUNGGOK, timestamp: T_0626_34, acc: 45 }));
    await tick();

    expect(result.current.userLocation).toEqual(YONGMASAN);
    expect(result.current.lastFixAtMs).toBe(T_0626_51);
  });

  it('더 새 timestamp는 주입한다', async () => {
    const { result } = await mount();
    await goBackground();
    await storeBgFix(bgFix({ timestamp: T_0626_34 }));
    await tick();
    await storeBgFix(bgFix({ ...JUNGGOK, timestamp: T_0626_51 }));
    await tick();

    expect(result.current.userLocation).toEqual(JUNGGOK);
    expect(result.current.lastFixAtMs).toBe(T_0626_51);
  });

  it('enabled=false 인스턴스는 주입하지 않는다 (MapScreen 등 보조 인스턴스)', async () => {
    const { result } = await mount({ enabled: false });
    await storeBgFix(bgFix());
    await tick();
    expect(result.current.userLocation).toBeNull();
  });

  it('FG watch fix가 오면 출처가 watch로 돌아온다 (lastFixFromBg=false)', async () => {
    const { result } = await mount();
    await goBackground();
    await storeBgFix(bgFix({ timestamp: T_0626_34 }));
    await tick();
    expect(result.current.lastFixFromBg).toBe(true);

    // FG 복귀로 watch 재구독 후 새 fix.
    await act(async () => {
      appStateListeners.forEach((l) => l('active'));
      await jest.advanceTimersByTimeAsync(0);
    });
    watchFix(JUNGGOK.lat, JUNGGOK.lng, T_0626_51, 9);
    expect(result.current.lastFixFromBg).toBe(false);
    expect(result.current.userLocation).toEqual(JUNGGOK);
  });
});

describe('useNearestStation - L 단조성 가드 (#3191 PR-2, 10/28 W L738->L735)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    setupMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('06:26:51 fix 뒤에 06:26:34 fix가 와도 L(좌표/시각/accuracy)은 되돌아가지 않는다', async () => {
    const { result } = await mount();
    watchFix(YONGMASAN.lat, YONGMASAN.lng, T_0626_51, 67);
    expect(result.current.lastFixAtMs).toBe(T_0626_51);
    expect(result.current.accuracyMeters).toBe(67);

    watchFix(JUNGGOK.lat, JUNGGOK.lng, T_0626_34, 45);

    expect(result.current.userLocation).toEqual(YONGMASAN);
    expect(result.current.lastFixAtMs).toBe(T_0626_51);
    // B6 - 역행 fix의 정확도가 표시 경로로 새지 않는다.
    expect(result.current.accuracyMeters).toBe(67);
  });

  it('같은 timestamp의 다른 fix도 무시한다', async () => {
    const { result } = await mount();
    watchFix(YONGMASAN.lat, YONGMASAN.lng, T_0626_51, 67);
    watchFix(JUNGGOK.lat, JUNGGOK.lng, T_0626_51, 10);
    expect(result.current.userLocation).toEqual(YONGMASAN);
    expect(result.current.accuracyMeters).toBe(67);
  });

  it('더 새 timestamp는 정상 반영한다 (거부 케이스의 짝)', async () => {
    const { result } = await mount();
    watchFix(YONGMASAN.lat, YONGMASAN.lng, T_0626_34, 45);
    watchFix(JUNGGOK.lat, JUNGGOK.lng, T_0626_51, 67);
    expect(result.current.userLocation).toEqual(JUNGGOK);
    expect(result.current.accuracyMeters).toBe(67);
  });
});
