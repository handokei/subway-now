import { renderHook, act, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNearestStation } from '../useNearestStation';
import * as useStickyStationModule from '../useStickyStation';
import * as findNearestStationModule from '../../utils/findNearestStation';
import {
  MAX_ACCURACY_M,
  MAX_ACCURACY_M_DISPLAY,
  MAX_LOCATION_AGE_MS,
  FG_WATCH_SURFACE_TIME_INTERVAL_MS,
  FG_WATCH_SUBSURFACE_TIME_INTERVAL_MS,
  FG_WATCH_LOCKED_TIME_INTERVAL_MS,
} from '../../../../shared/constants/location';
import { BG_LAST_STATION_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('expo-location');

const e2eState = { isMock: false };
jest.mock('../../../../shared/constants/e2e', () => ({
  get IS_E2E_MOCK() {
    return e2eState.isMock;
  },
  E2E_MOCK_LOCATION: {
    latitude: 37.49799,
    longitude: 127.027912,
    accuracyMeters: 10,
    speedMps: 0,
  },
}));

const mockRemove = jest.fn();
let appStateCallback: ((state: string) => void) | null = null;
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  appStateCallback = listener as (state: string) => void;
  return { remove: mockRemove } as unknown as ReturnType<typeof AppState.addEventListener>;
});

const mockSubscription = { remove: jest.fn() };
type WatchLocation = {
  coords: { latitude: number; longitude: number; speed?: number | null; accuracy?: number | null };
  timestamp?: number;
};
let watchCallback: ((location: WatchLocation) => void) | null = null;

const mockGranted = () => {
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({
    status: 'granted',
  });
};

const mockDenied = () => {
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({
    status: 'denied',
  });
};

const mockLastKnownLocation = (
  lat: number,
  lng: number,
  opts: { ageMs?: number; accuracy?: number | null } = {},
) => {
  (Location.getLastKnownPositionAsync as jest.Mock).mockResolvedValue({
    coords: { latitude: lat, longitude: lng, accuracy: opts.accuracy ?? null },
    timestamp: Date.now() - (opts.ageMs ?? 0),
  });
};

const mockNoLastKnownLocation = () => {
  (Location.getLastKnownPositionAsync as jest.Mock).mockResolvedValue(null);
};

const mockLocation = (lat: number, lng: number, opts: { accuracy?: number | null } = {}) => {
  (Location.getCurrentPositionAsync as jest.Mock).mockResolvedValue({
    coords: { latitude: lat, longitude: lng, accuracy: opts.accuracy ?? null },
    timestamp: Date.now(),
  });
};

const simulateGps = (
  lat: number,
  lng: number,
  opts: { speed?: number | null; accuracy?: number | null; timestamp?: number } = {},
) => {
  act(() => {
    watchCallback?.({
      coords: {
        latitude: lat,
        longitude: lng,
        speed: opts.speed ?? null,
        accuracy: opts.accuracy ?? null,
      },
      timestamp: opts.timestamp ?? Date.now(),
    });
  });
};

// #1540 (S7) — gps-drop sliding window 테스트 공용 setup. Sonar 중복 제거.
function setupGpsDropFakeNow(initialNow = 1_700_000_000_000) {
  const { clearGpsDropEntries, getGpsDropEntries } =
    jest.requireActual('../../utils/gpsDropBuffer');
  clearGpsDropEntries();
  mockGranted();
  const realNow = Date.now;
  const state = { fakeNow: initialNow };
  jest.spyOn(Date, 'now').mockImplementation(() => state.fakeNow);
  const restore = () => {
    (Date.now as jest.Mock).mockRestore?.();
    Date.now = realNow;
  };
  return { state, getGpsDropEntries, restore };
}

describe('useNearestStation', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // #876 — sticky station이 AsyncStorage에 lock을 남기면 다음 테스트 hydrate 시 잔류 lock이
    // result를 override해 회귀(잘못된 station 반환). 매 테스트 전에 storage clear.
    await AsyncStorage.clear();
    appStateCallback = null;
    watchCallback = null;
    mockNoLastKnownLocation();
    mockSubscription.remove.mockClear();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallback) => {
        watchCallback = callback;
        return mockSubscription;
      },
    );
  });

  it('위치 권한 거부 시 permissionDenied가 true이고 loading이 false이다', async () => {
    mockDenied();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.permissionDenied).toBe(true);
    expect(result.current.result).toBeNull();
    expect(Location.watchPositionAsync).not.toHaveBeenCalled();
  });

  it('위치 권한 거부 시 userLocation이 null이다', async () => {
    mockDenied();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.userLocation).toBeNull();
  });

  it('watchPositionAsync 콜백으로 역을 감지한다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277);

    await waitFor(() => expect(result.current.result).not.toBeNull());

    expect(result.current.result?.station.name).toBe('강남');
    expect(result.current.permissionDenied).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.userLocation).toEqual({ lat: 37.4980, lng: 127.0277 });
  });

  it('GPS speed가 양수이면 speedMps로 노출한다', async () => {
    mockGranted();
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, { speed: 15.5 });

    await waitFor(() => expect(result.current.speedMps).toBe(15.5));
  });

  it('GPS speed가 음수면 speedMps를 null로 정규화한다', async () => {
    mockGranted();
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, { speed: -1 });

    await waitFor(() => expect(result.current.speedMps).toBeNull());
  });

  it('GPS speed가 null이면 speedMps도 null이다', async () => {
    mockGranted();
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, { speed: null });

    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.speedMps).toBeNull();
  });

  it('1km 이내 거리는 정상 반환된다 (거리 상한 내 통과)', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.5035, 127.0277);

    await waitFor(() => expect(result.current.result).not.toBeNull());

    expect(result.current.result?.distanceKm).toBeGreaterThan(0);
    expect(result.current.result?.distanceKm).toBeLessThanOrEqual(1.0);
  });

  it('watchPositionAsync 실패 시 error가 설정된다', async () => {
    mockGranted();
    (Location.watchPositionAsync as jest.Mock).mockRejectedValue(new Error('GPS 오류'));

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('위치를 가져오는 데 실패했습니다.');
  });

  it('refresh 호출 시 getCurrentPositionAsync로 위치를 재취득한다', async () => {
    mockGranted();
    mockLocation(37.4980, 127.0277);

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    await act(async () => {
      await result.current.refresh();
    });

    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    // refresh 후 watch 재시작
    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(2);
  });

  it('watchPositionAsync에 High·distanceInterval:0·timeInterval(surface 상수)을 전달한다', async () => {
    // #1440 — surface는 distanceInterval=0으로 정적 FG에서도 watch 이벤트가 흘러야 GPS acc가
    // 회복된다. #1416에서 5m 적용 → 정적 30분 acc>30m stuck + 한양대 820m stuck fix 회귀로 되돌림.
    // #2509 — timeInterval 값 자체는 FG_WATCH_SURFACE_TIME_INTERVAL_MS 상수 참조(리터럴 금지).
    mockGranted();

    renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    expect(Location.watchPositionAsync).toHaveBeenCalledWith(
      {
        accuracy: Location.Accuracy.High,
        distanceInterval: 0,
        timeInterval: FG_WATCH_SURFACE_TIME_INTERVAL_MS,
      },
      expect.any(Function),
    );
  });

  it('#1440 회귀: 정적 FG 시뮬레이션에서 distanceInterval=0이어야 acc 회복 콜백이 흘러간다', async () => {
    // 회귀: #1416에서 distanceInterval=5로 throttle 후 정적 30분 동안 OS가 callback을 끊어
    // GPS acc가 stale(>30m)인 채 고착되고 한양대 820m 같은 stuck fix가 fire를 유발했다.
    // 본 테스트는 같은 좌표라도 acc 회복(>30m → ≤30m)을 위해 watch 옵션이 distanceInterval=0이어야
    // 한다는 계약을 가드한다.
    mockGranted();
    renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    const [options] = (Location.watchPositionAsync as jest.Mock).mock.calls[0];
    expect(options.distanceInterval).toBe(0);

    // 정적 시뮬레이션: 동일 좌표 + acc 변화(50m → 20m)를 같은 lat/lng로 흘려도 distanceInterval=0이면
    // OS가 callback을 차단하지 않는다. callback 자체는 expo-location mock이 처리하므로 본 테스트는
    // 옵션 계약만 검증한다 (native throttle 동작은 단위테스트 범위 외).
    expect(options.accuracy).toBe(Location.Accuracy.High);
  });

  it('언마운트 시 subscription.remove()가 호출된다', async () => {
    mockGranted();

    const { unmount } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    unmount();
    expect(mockSubscription.remove).toHaveBeenCalled();
  });

  it('백그라운드 전환 시 subscription.remove()가 호출된다', async () => {
    mockGranted();

    renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    act(() => { appStateCallback?.('background'); });
    expect(mockSubscription.remove).toHaveBeenCalled();
  });

  it('inactive 상태에서는 watch를 중지하지 않는다', async () => {
    mockGranted();

    renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));

    act(() => { appStateCallback?.('inactive'); });

    // inactive에서는 subscription.remove가 호출되지 않음
    expect(mockSubscription.remove).not.toHaveBeenCalled();
    // watch 재시작도 하지 않음
    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1);
  });

  it('포그라운드 복귀 시 watchPositionAsync가 재호출된다', async () => {
    mockGranted();

    renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));

    act(() => { appStateCallback?.('background'); });

    await act(async () => { appStateCallback?.('active'); });

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(2));
  });

  it('포그라운드 복귀 시 fresh fix를 요청하고 locationUncertain을 true로 전환한다 (#543)', async () => {
    mockGranted();
    // 초기 mount에서는 refresh가 호출되지 않으므로 mockLocation은 FG 복귀 후의 fresh fix에 사용.
    mockLocation(37.498, 127.028, { accuracy: 10 });

    const { result } = renderHook(() => useNearestStation());

    // 초기 fresh fix 들어오면 uncertain은 false로 시작
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));
    simulateGps(37.498, 127.028, { accuracy: 10 });
    await waitFor(() => expect(result.current.userLocation).not.toBeNull());
    expect(result.current.locationUncertain).toBe(false);

    // BG → FG 전환. active 핸들러가 동기적으로 setLocationUncertain(true)을 호출하므로
    // refresh()의 await getCurrentPositionAsync 시점에 uncertain=true가 관측된다.
    act(() => { appStateCallback?.('background'); });

    // active 이벤트 직후 getCurrentPositionAsync 호출이 들어가야 한다 (refresh 경로).
    const callsBeforeResume = (Location.getCurrentPositionAsync as jest.Mock).mock.calls.length;
    // getCurrentPositionAsync을 deferred로 만들어 uncertain=true 구간을 관측한다.
    let resolveFresh: ((value: unknown) => void) | null = null;
    (Location.getCurrentPositionAsync as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFresh = (v) => resolve(v);
        }),
    );

    await act(async () => { appStateCallback?.('active'); });

    // 1) uncertain이 true로 즉시 전환됨
    expect(result.current.locationUncertain).toBe(true);
    // 2) refresh가 getCurrentPositionAsync를 호출했음
    expect((Location.getCurrentPositionAsync as jest.Mock).mock.calls.length).toBe(callsBeforeResume + 1);

    // 3) fresh fix가 들어오면 applyLocation이 uncertain=false로 복귀.
    //    jump gate를 피하기 위해 직전 fix와 동일 좌표 사용 (테스트 의도: uncertain 복귀만 검증).
    await act(async () => {
      resolveFresh?.({
        coords: { latitude: 37.498, longitude: 127.028, accuracy: 10 },
        timestamp: Date.now(),
      });
    });
    await waitFor(() => expect(result.current.locationUncertain).toBe(false));
  });

  it('언마운트 시 AppState 리스너를 해제한다', async () => {
    mockGranted();

    const { unmount } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    unmount();
    expect(mockRemove).toHaveBeenCalled();
  });

  it('환승역 감지 시 variants가 2개 이상 반환된다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    // 교대역 좌표 (2호선/3호선 환승역)
    simulateGps(37.493961, 127.014667);

    await waitFor(() => expect(result.current.result).not.toBeNull());

    expect(result.current.result?.station.name).toBe('교대(법원.검찰청)');
    expect(result.current.variants.length).toBeGreaterThan(1);
    expect(result.current.variants.every((v) => v.name === '교대(법원.검찰청)')).toBe(true);
  });

  it('일반역 감지 시 variants가 1개이다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    // 소요산역 좌표 (1호선 단독역)
    simulateGps(37.9481, 127.061034);

    await waitFor(() => expect(result.current.result).not.toBeNull());

    expect(result.current.result?.station.name).toBe('소요산');
    expect(result.current.variants).toHaveLength(1);
  });

  it('권한 거부 시 variants가 빈 배열이다', async () => {
    mockDenied();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.variants).toEqual([]);
  });

  it('캐시된 위치가 있으면 즉시 loading이 false가 된다', async () => {
    mockGranted();
    mockLastKnownLocation(37.4980, 127.0277);

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(Location.getLastKnownPositionAsync).toHaveBeenCalled();
    expect(result.current.result).not.toBeNull();
    expect(result.current.result?.station.name).toBe('강남');
  });

  it('#1925: getLastKnownPositionAsync에 MAX_LOCATION_AGE_MS를 maxAge로 전달한다', async () => {
    // 회귀: 무인자 호출 시 expo-location 내부 기본값이 `.greatestFiniteMagnitude`라
    // OS가 1h+ stale cached fix를 그대로 반환. JS-level isLocationFresh 게이트 외에
    // OS-level maxAge로도 차단해 defense-in-depth. silentPushLocationGate.ts:140과 동일 패턴.
    mockGranted();
    mockLastKnownLocation(37.4980, 127.0277);

    renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.getLastKnownPositionAsync).toHaveBeenCalled());

    expect(Location.getLastKnownPositionAsync).toHaveBeenCalledWith({
      maxAge: MAX_LOCATION_AGE_MS,
    });
  });

  it('캐시된 위치가 없으면 watchPositionAsync 시작 후 loading이 false가 된다', async () => {
    mockGranted();
    mockNoLastKnownLocation();

    const { result } = renderHook(() => useNearestStation());

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(Location.getLastKnownPositionAsync).toHaveBeenCalled();
    expect(Location.watchPositionAsync).toHaveBeenCalled();
  });

  it('같은 역 좌표 반복 시 result/variants는 throttle되어 동일 reference를 유지한다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277);

    await waitFor(() => expect(result.current.result?.station.name).toBe('강남'));

    const firstResult = result.current.result;
    const firstVariants = result.current.variants;

    // 같은 좌표로 다시 콜백 (거리 변화 <3m) — 표시값은 throttle
    simulateGps(37.4980, 127.0277);

    expect(result.current.result).toBe(firstResult);
    expect(result.current.variants).toBe(firstVariants);
  });

  it('3m 미만 이동이어도 userLocation/speedMps/accuracyMeters는 매 fix마다 갱신된다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, { speed: 1.2, accuracy: 15 });

    await waitFor(() => expect(result.current.userLocation).not.toBeNull());

    const firstResult = result.current.result;

    // 1m 미만 이동 — throttle 안으로 떨어지는 변화
    simulateGps(37.49801, 127.02771, { speed: 1.5, accuracy: 18 });

    // raw 신호는 갱신
    expect(result.current.userLocation).toEqual({ lat: 37.49801, lng: 127.02771 });
    expect(result.current.speedMps).toBe(1.5);
    expect(result.current.accuracyMeters).toBe(18);
    // 표시값은 throttle 유지
    expect(result.current.result).toBe(firstResult);
  });

  it('findNearestStations가 null을 반환하면 result가 null이 된다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    // 먼저 역을 감지한 상태에서
    simulateGps(37.4980, 127.0277);
    await waitFor(() => expect(result.current.result).not.toBeNull());

    // 이후 null 반환. 두 번째 좌표는 직전 fix와 100m 이내(노이즈 범위)로 두어
    // jump gate(#527) 차단 없이 findNearestStations 분기를 검증한다.
    const spy = jest.spyOn(findNearestStationModule, 'findNearestStations').mockReturnValue(null);
    try {
      simulateGps(37.4981, 127.0278);
      await waitFor(() => expect(result.current.result).toBeNull());
      expect(result.current.variants).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh 중 권한 거부 시 watch를 재시작하지 않는다', async () => {
    mockGranted();
    mockLocation(37.4980, 127.0277);

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));

    // refresh 시 권한 거부
    (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValueOnce({
      status: 'denied',
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.permissionDenied).toBe(true);
    // watch 재시작 안 함 (초기 1회만)
    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1);
  });

  it('refresh 중 위치 획득 실패 시 watch는 재시작된다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));

    // refresh 시 getCurrentPositionAsync 실패
    (Location.getCurrentPositionAsync as jest.Mock).mockRejectedValueOnce(
      new Error('GPS 오류'),
    );

    await act(async () => {
      await result.current.refresh();
    });

    // catch 후에도 watch 재시작됨
    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(2);
  });

  it('stale 캐시 위치(MAX_LOCATION_AGE_MS 초과)는 무시하고 진단 로그를 남긴다', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockGranted();
    mockLastKnownLocation(37.4980, 127.0277, { ageMs: MAX_LOCATION_AGE_MS + 1 });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    // stale 캐시는 무시 → result는 null 유지 (watch 콜백 전까지)
    expect(result.current.result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(
      '[useNearestStation]',
      'lastKnown rejected: stale',
      expect.objectContaining({ cumulativeStale: 1 }),
    );
    logSpy.mockRestore();
  });

  it('표시 게이트 초과 캐시 위치(MAX_ACCURACY_M_DISPLAY 초과)는 무시하고 진단 로그를 남긴다', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockGranted();
    mockLastKnownLocation(37.4980, 127.0277, { accuracy: MAX_ACCURACY_M_DISPLAY + 1 });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    expect(result.current.result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(
      '[useNearestStation]',
      'lastKnown rejected: lowAccuracy',
      expect.objectContaining({
        accuracyMeters: MAX_ACCURACY_M_DISPLAY + 1,
        cumulativeLowAccuracy: 1,
      }),
    );
    logSpy.mockRestore();
  });

  it('#808 cold start hydrate: 알람 게이트 초과지만 표시 게이트 통과 fix는 uncertain=true로 hydrate한다', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockGranted();
    // 220m: MAX_ACCURACY_M=200 초과 + MAX_ACCURACY_M_DISPLAY=250 이하
    mockLastKnownLocation(37.4980, 127.0277, { accuracy: 220 });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // cold start 빈 화면 회피: result 채워짐
    expect(result.current.result).not.toBeNull();
    expect(result.current.result?.station.name).toBe('강남');
    // "위치 확인 중" UX: uncertain=true
    expect(result.current.locationUncertain).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(
      '[useNearestStation]',
      'lastKnown coldStart hydrate: uncertain',
      expect.objectContaining({ accuracyMeters: 220 }),
    );
    logSpy.mockRestore();
  });

  it('#808 cold start hydrate 후 fresh fix가 들어오면 uncertain이 false로 복귀한다', async () => {
    mockGranted();
    mockLastKnownLocation(37.4980, 127.0277, { accuracy: 220 });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.locationUncertain).toBe(true);

    // fresh fix(strict 통과)가 들어오면 정정
    simulateGps(37.4980, 127.0277, { accuracy: 30 });
    await waitFor(() => expect(result.current.locationUncertain).toBe(false));
    expect(result.current.result?.station.name).toBe('강남');
  });

  it('#808 cold start hydrate: speed=-1인 lastKnown은 speedMps를 null로 정규화한다', async () => {
    mockGranted();
    (Location.getLastKnownPositionAsync as jest.Mock).mockResolvedValue({
      coords: { latitude: 37.4980, longitude: 127.0277, accuracy: 220, speed: -1 },
      timestamp: Date.now() - 5_000,
    });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.result).not.toBeNull());
    // speed=-1 → null로 정규화. positionStability/motionStationary fallback 대상으로 전환.
    expect(result.current.speedMps).toBeNull();
    expect(result.current.result?.station.name).toBe('강남');
  });

  it('lastKnown 거부 카운터는 FG 재진입마다 누적된다', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockGranted();
    mockLastKnownLocation(37.4980, 127.0277, { ageMs: MAX_LOCATION_AGE_MS + 1 });
    // FG 복귀 시 refresh()가 호출되어 getCurrentPositionAsync 정상 경로를 타도록 mock 설정.
    // 미설정 시 catch 분기로 우회되어 카운터 누적 로직 검증이 무의미해진다 (#543 리뷰).
    mockLocation(37.4980, 127.0277, { accuracy: 30 });

    renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    // AppState 'active' 재진입으로 startWatch 재호출
    await act(async () => {
      appStateCallback?.('background');
      appStateCallback?.('active');
    });
    await waitFor(() =>
      expect(Location.getLastKnownPositionAsync).toHaveBeenCalledTimes(2),
    );

    expect(logSpy).toHaveBeenLastCalledWith(
      '[useNearestStation]',
      'lastKnown rejected: stale',
      expect.objectContaining({ cumulativeStale: 2 }),
    );
    logSpy.mockRestore();
  });

  it('신선하고 정확한 캐시 위치는 사용한다', async () => {
    mockGranted();
    mockLastKnownLocation(37.4980, 127.0277, { ageMs: 5_000, accuracy: 30 });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.result?.station.name).toBe('강남');
  });

  it('watch 콜백 표시 게이트 초과(MAX_ACCURACY_M_DISPLAY 초과) 좌표는 setState하지 않고 locationUncertain=true', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    expect(result.current.locationUncertain).toBe(false);
    simulateGps(37.4980, 127.0277, { accuracy: MAX_ACCURACY_M_DISPLAY + 1 });

    // 표시 게이트 초과 → setState 차단 + uncertain 노출
    expect(result.current.result).toBeNull();
    expect(result.current.userLocation).toBeNull();
    expect(result.current.locationUncertain).toBe(true);
  });

  it('#1540 (S7) 표시 게이트 drop 시 gpsDropBuffer에 push (fusionDebugBuffer는 오염 X, speed 양수)', async () => {
    const { clearGpsDropEntries, getGpsDropEntries } =
      jest.requireActual('../../utils/gpsDropBuffer');
    const { clearFusionDebugEntries, getFusionDebugEntries } =
      jest.requireActual('../../utils/fusionDebugBuffer');
    clearGpsDropEntries();
    clearFusionDebugEntries();
    mockGranted();
    renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, {
      accuracy: MAX_ACCURACY_M_DISPLAY + 1,
      speed: 1.5,
    });

    const drops = getGpsDropEntries();
    expect(drops).toHaveLength(1);
    expect(drops[0].speedMps).toBe(1.5);
    expect(drops[0].dropReason).toBe('low-accuracy-display');
    // #1540 acceptance: fusionDebugBuffer는 gps-drop으로 오염되지 않는다.
    const fusionDrops = getFusionDebugEntries().filter(
      (e: { kind: string; event?: string }) => e.kind === 'gps' && e.event === 'gps-drop',
    );
    expect(fusionDrops).toHaveLength(0);
  });

  it('#1516 dedup: 직전 drop과 lat/lng/accuracy가 모두 동일하면 추가 push를 skip한다', async () => {
    const { clearGpsDropEntries, getGpsDropEntries } =
      jest.requireActual('../../utils/gpsDropBuffer');
    clearGpsDropEntries();
    mockGranted();
    renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    // 같은 fix 5회 — 1회만 push되어야 함
    for (let i = 0; i < 5; i += 1) {
      simulateGps(37.5500, 127.0500, { accuracy: 1414, speed: 0, timestamp: 1_700_000_000_000 });
    }

    const drops = getGpsDropEntries();
    expect(drops).toHaveLength(1);
    expect(drops[0].accuracyMeters).toBe(1414);
  });

  it('#1516 + #1540 (S7) 슬라이딩 rate limit: 1초 내 임계 초과 drop skip + 다음 push 시 summary 흡수', async () => {
    const { state, getGpsDropEntries, restore } = setupGpsDropFakeNow();
    try {
      renderHook(() => useNearestStation());
      await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

      // 같은 슬라이딩 윈도우 내 서로 다른 좌표 4건 (dedup gate 우회) — limit=2 이후는 skipped 누적.
      simulateGps(37.5500, 127.0500, { accuracy: 800, timestamp: state.fakeNow });
      simulateGps(37.5501, 127.0501, { accuracy: 801, timestamp: state.fakeNow });
      simulateGps(37.5502, 127.0502, { accuracy: 802, timestamp: state.fakeNow });
      simulateGps(37.5503, 127.0503, { accuracy: 803, timestamp: state.fakeNow });

      let drops = getGpsDropEntries();
      // limit=2 → 처음 2건만 push, 이후 2건은 skipped
      expect(drops).toHaveLength(2);

      // 1초 경과 후 다음 drop이 들어오면 슬라이딩 윈도우가 비워져 summary가 먼저 push됨.
      // speed를 null로 줘서 summary push의 isValidGpsSpeedMps false 분기 커버.
      state.fakeNow += 1_500;
      simulateGps(37.5504, 127.0504, { accuracy: 900, speed: null, timestamp: state.fakeNow });

      drops = getGpsDropEntries();
      // 2 (1st window) + 1 summary + 1 (new window) = 4
      expect(drops).toHaveLength(4);
      const summary = drops.find((d: { dropReason?: string }) =>
        d.dropReason?.startsWith('rate-limited:'),
      );
      expect(summary).toBeDefined();
      expect(summary?.dropReason).toBe('rate-limited:2');
      expect(summary?.speedMps).toBeNull();

      // 추가 윈도우: speed 양수로 summary push의 isValidGpsSpeedMps true 분기 커버.
      // dedup 우회 위해 좌표를 매번 다르게.
      simulateGps(37.5510, 127.0510, { accuracy: 800, speed: 1, timestamp: state.fakeNow });
      simulateGps(37.5511, 127.0511, { accuracy: 801, speed: 1, timestamp: state.fakeNow });
      simulateGps(37.5512, 127.0512, { accuracy: 802, speed: 1, timestamp: state.fakeNow });
      state.fakeNow += 1_500;
      simulateGps(37.5513, 127.0513, { accuracy: 900, speed: 3, timestamp: state.fakeNow });
      drops = getGpsDropEntries();
      const summary2 = drops.filter((d: { dropReason?: string }) =>
        d.dropReason?.startsWith('rate-limited:'),
      );
      expect(summary2.length).toBeGreaterThanOrEqual(2);
      expect(summary2[1].speedMps).toBe(3);
    } finally {
      restore();
    }
  });

  it('#1540 (S7) 슬라이딩 윈도우: 1.1초마다 한 건씩 도착해도 한도 정확히 적용 (fixed window trap 회귀 차단)', async () => {
    const { state, getGpsDropEntries, restore } = setupGpsDropFakeNow();
    try {
      renderHook(() => useNearestStation());
      await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

      // 1.1초 간격으로 6건 도착 — 슬라이딩 윈도우는 매번 1건만 유효, limit=2 미달이라 모두 push.
      // 이전 fixed window 구현은 windowStart>=1000ms 마다 reset되어 동일한 결과를 내지만,
      // 본 테스트는 sliding 동작이 회귀하지 않음을 박제한다.
      for (let i = 0; i < 6; i += 1) {
        simulateGps(37.6 + i * 0.001, 127 + i * 0.001, {
          accuracy: 800 + i,
          speed: 0,
          timestamp: state.fakeNow,
        });
        state.fakeNow += 1_100;
      }
      const drops = getGpsDropEntries();
      // 모두 윈도우 외부 → 6건 모두 push, summary 없음.
      expect(drops).toHaveLength(6);
      expect(drops.every((d: { dropReason: string }) => d.dropReason === 'low-accuracy-display')).toBe(
        true,
      );
    } finally {
      restore();
    }
  });

  it('#1540 (S7) summary가 limit 소진 시: 본 drop은 다음 윈도우로 미루고 skipped=1로 유지', async () => {
    const { state, getGpsDropEntries, restore } = setupGpsDropFakeNow();
    try {
      renderHook(() => useNearestStation());
      await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

      // t0: push 1건 → timestamps=[t0]
      simulateGps(37.7, 127, { accuracy: 800, timestamp: state.fakeNow });
      // t0+500: push 2번째 → timestamps=[t0, t0+500] (limit=2 도달)
      state.fakeNow += 500;
      simulateGps(37.7001, 127.0001, { accuracy: 801, timestamp: state.fakeNow });
      // t0+501: limit 도달 상태에서 1건 skip → skipped=1
      state.fakeNow += 1;
      simulateGps(37.7002, 127.0002, { accuracy: 802, timestamp: state.fakeNow });
      expect(getGpsDropEntries()).toHaveLength(2);

      // t0+1100: cutoff=t0+100 → t0 trim, t0+500 유지. timestamps=[t0+500] length=1<limit.
      // skipped=1이므로 summary push → timestamps=[t0+500, t0+1100] length=2=limit.
      // 본 drop은 미뤄지고 skipped=1로 재설정.
      state.fakeNow = 1_700_000_000_000 + 1_100;
      simulateGps(37.7003, 127.0003, { accuracy: 803, speed: 2, timestamp: state.fakeNow });
      const drops = getGpsDropEntries();
      // 2 (1st window pushes) + 1 summary = 3. 본 drop은 다음 윈도우로 미뤄짐.
      expect(drops).toHaveLength(3);
      const summary = drops[2];
      expect(summary.dropReason).toBe('rate-limited:1');
      expect(summary.speedMps).toBe(2);
    } finally {
      restore();
    }
  });

  it('#1516 locationUncertain bail-out: 이미 true면 추가 setState 없이 유지', async () => {
    mockGranted();
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.5500, 127.0500, { accuracy: MAX_ACCURACY_M_DISPLAY + 100 });
    expect(result.current.locationUncertain).toBe(true);

    // 동일 fix 반복해도 안정 — 단순 truthy assertion
    simulateGps(37.5500, 127.0500, { accuracy: MAX_ACCURACY_M_DISPLAY + 100 });
    simulateGps(37.5501, 127.0501, { accuracy: MAX_ACCURACY_M_DISPLAY + 200 });
    expect(result.current.locationUncertain).toBe(true);
  });

  it('jump gate(#527): 직전 fix 대비 비현실 점프는 setState 차단 + locationUncertain=true', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    // 첫 fix: 효창공원앞 — 명시적 timestamp로 prev 고정
    const t0 = 1_700_000_000_000;
    simulateGps(37.5390, 126.9610, { accuracy: 30, timestamp: t0 });
    await waitFor(() => expect(result.current.userLocation).not.toBeNull());
    const initialLoc = result.current.userLocation;

    // 두 번째 fix: 25km 떨어진 신내 — 8s 후 → 3125 m/s, 50 m/s 임계 초과
    simulateGps(37.6128, 127.0966, { accuracy: 30, timestamp: t0 + 8_000 });

    expect(result.current.userLocation).toEqual(initialLoc);
    expect(result.current.locationUncertain).toBe(true);
  });

  it('jump gate(#527): jump drop 후 정상 fix가 들어오면 locationUncertain=false로 복귀한다 (P1 회귀)', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    const t0 = 1_700_000_000_000;
    simulateGps(37.5390, 126.9610, { accuracy: 30, timestamp: t0 });
    await waitFor(() => expect(result.current.locationUncertain).toBe(false));

    simulateGps(37.6128, 127.0966, { accuracy: 30, timestamp: t0 + 8_000 });
    expect(result.current.locationUncertain).toBe(true);

    // 다음 정상 fix(직전 효창공원앞 근처)는 jump 통과 → uncertain 복귀
    simulateGps(37.5391, 126.9611, { accuracy: 30, timestamp: t0 + 16_000 });
    await waitFor(() => expect(result.current.locationUncertain).toBe(false));
  });

  it('uncertain 상태에서 정확한 좌표가 들어오면 locationUncertain=false로 복귀한다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, { accuracy: MAX_ACCURACY_M_DISPLAY + 1 });
    expect(result.current.locationUncertain).toBe(true);

    simulateGps(37.4980, 127.0277, { accuracy: 30 });
    await waitFor(() => expect(result.current.locationUncertain).toBe(false));
    expect(result.current.result?.station.name).toBe('강남');
  });

  it('watch 콜백 알람 게이트 초과지만 표시 게이트 통과 좌표는 setState한다 (지하 구간 가정)', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, { accuracy: MAX_ACCURACY_M + 1 });

    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.result?.station.name).toBe('강남');
    expect(result.current.accuracyMeters).toBe(MAX_ACCURACY_M + 1);
  });

  it('watch 콜백 accuracy가 null이면 통과한다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, { accuracy: null });

    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.result?.station.name).toBe('강남');
  });

  it('refresh 시 표시 게이트 초과 좌표는 setState하지 않고 locationUncertain=true', async () => {
    mockGranted();
    mockLocation(37.4980, 127.0277, { accuracy: MAX_ACCURACY_M_DISPLAY + 1 });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh();
    });

    expect(Location.getCurrentPositionAsync).toHaveBeenCalled();
    // 표시 게이트 초과 → result 갱신 안 됨 + uncertain 노출
    expect(result.current.result).toBeNull();
    expect(result.current.locationUncertain).toBe(true);
  });

  it('refresh 시 정확한 좌표가 들어오면 locationUncertain=false로 복귀한다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, { accuracy: MAX_ACCURACY_M_DISPLAY + 1 });
    expect(result.current.locationUncertain).toBe(true);

    mockLocation(37.4980, 127.0277, { accuracy: 30 });
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.locationUncertain).toBe(false);
    expect(result.current.result?.station.name).toBe('강남');
  });

  it('timestamp가 없는 캐시 위치는 무시한다', async () => {
    mockGranted();
    (Location.getLastKnownPositionAsync as jest.Mock).mockResolvedValue({
      coords: { latitude: 37.4980, longitude: 127.0277, accuracy: null },
      // timestamp 누락
    });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    expect(result.current.result).toBeNull();
  });

  it('1km 초과 거리의 위치는 findNearestStations가 null을 반환한다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    // 강원도 등 지하철 역과 멀리 떨어진 좌표
    simulateGps(38.5, 128.5, { accuracy: 30 });

    // MAX_STATION_DISTANCE_KM(1.0) 초과 → null
    expect(result.current.result).toBeNull();
  });
});

describe('useNearestStation — #711 BG_LAST_STATION hydrate', () => {
  // 공통 setup: granted + watch 마운트 — helper로 추출해 중복 ≤3% 유지 (SonarCloud)
  async function mountAndWaitWatch() {
    mockGranted();
    const view = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    return view;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    // clearAllMocks는 implementation을 리셋하지 않는다 — 이전 describe의 mockLocation 잔류로
    // refresh()가 강남역 좌표를 흘려보내 result가 오염되는 회귀를 방지.
    (Location.getCurrentPositionAsync as jest.Mock).mockReset();
    (Location.getCurrentPositionAsync as jest.Mock).mockRejectedValue(new Error('no-fix'));
    appStateCallback = null;
    watchCallback = null;
    mockNoLastKnownLocation();
    mockSubscription.remove.mockClear();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallback) => {
        watchCallback = callback;
        return mockSubscription;
      },
    );
    await AsyncStorage.clear();
  });

  it('FG 복귀 시 BG_LAST_STATION이 있으면 result를 임시 hydrate한다 (uncertain=true 유지)', async () => {
    // BG task가 적재한 가짜 데이터 — 강남역 fixture
    const bgPayload = {
      station: {
        id: 'gangnam-2',
        name: '강남',
        line: '2',
        lineColor: '#009246',
        lat: 37.498,
        lng: 127.028,
      },
      distanceKm: 0.1,
      timestamp: Date.now() - 10_000,
    };
    await AsyncStorage.setItem(BG_LAST_STATION_KEY, JSON.stringify(bgPayload));

    const { result } = await mountAndWaitWatch();
    // 초기 result는 null (fresh fix 아직 없음)
    expect(result.current.result).toBeNull();

    // FG 복귀 — refresh getCurrentPositionAsync는 deferred로 두어 hydrate가 먼저 관측되게 한다
    let resolveFresh: ((v: unknown) => void) | null = null;
    (Location.getCurrentPositionAsync as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => { resolveFresh = (v) => resolve(v); }),
    );

    act(() => { appStateCallback?.('background'); });
    await act(async () => { appStateCallback?.('active'); });

    // hydrate 적용 대기
    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.result?.station.name).toBe('강남');
    // fresh fix 미도착 — uncertain 유지
    expect(result.current.locationUncertain).toBe(true);

    // fresh fix가 들어오면 applyLocation이 uncertain=false로 복귀 + result는 fresh로 교체
    await act(async () => {
      resolveFresh?.({
        coords: { latitude: 37.498, longitude: 127.028, accuracy: 10 },
        timestamp: Date.now(),
      });
    });
    await waitFor(() => expect(result.current.locationUncertain).toBe(false));
    expect(result.current.result?.station.name).toBe('강남');
  });

  it('FG 복귀 시 BG_LAST_STATION이 없으면 (WhileInUse 사용자) 조용히 no-op', async () => {
    // key 없음 — graceful no-op
    const { result } = await mountAndWaitWatch();

    act(() => { appStateCallback?.('background'); });
    await act(async () => { appStateCallback?.('active'); });

    // hydrate되지 않음
    expect(result.current.result).toBeNull();
  });

  it('FG 복귀 시 손상된 BG_LAST_STATION JSON은 graceful no-op', async () => {
    await AsyncStorage.setItem(BG_LAST_STATION_KEY, 'not-json{{{');

    const { result } = await mountAndWaitWatch();
    act(() => { appStateCallback?.('background'); });
    await act(async () => { appStateCallback?.('active'); });

    // catch 분기로 흘러 result는 null 유지
    expect(result.current.result).toBeNull();
  });

  it('FG 복귀 시 BG_LAST_STATION 스키마가 잘못되면 graceful no-op', async () => {
    // station.id 누락 → 검증 실패
    await AsyncStorage.setItem(
      BG_LAST_STATION_KEY,
      JSON.stringify({ station: { name: '?' }, distanceKm: 0.1 }),
    );

    const { result } = await mountAndWaitWatch();
    act(() => { appStateCallback?.('background'); });
    await act(async () => { appStateCallback?.('active'); });

    expect(result.current.result).toBeNull();
  });

  it('FG 복귀 시 result가 이미 있으면 hydrate가 덮어쓰지 않는다 (race 가드)', async () => {
    const bgPayload = {
      station: {
        id: 'other',
        name: '시청',
        line: '1',
        lineColor: '#0052A4',
        lat: 37.565,
        lng: 126.977,
      },
      distanceKm: 0.5,
      timestamp: Date.now() - 10_000,
    };
    await AsyncStorage.setItem(BG_LAST_STATION_KEY, JSON.stringify(bgPayload));

    const { result } = await mountAndWaitWatch();
    // 먼저 fresh fix로 강남역 채워둠
    simulateGps(37.498, 127.028, { accuracy: 10 });
    await waitFor(() => expect(result.current.result?.station.name).toBe('강남'));

    act(() => { appStateCallback?.('background'); });
    await act(async () => { appStateCallback?.('active'); });

    // hydrate가 흘러도 prev ?? bg → 강남 유지
    await waitFor(() => expect(Location.getCurrentPositionAsync).toHaveBeenCalled());
    expect(result.current.result?.station.name).toBe('강남');
  });
});

describe('useNearestStation — #876 sticky station integration', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    appStateCallback = null;
    watchCallback = null;
    mockNoLastKnownLocation();
    mockSubscription.remove.mockClear();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallback) => {
        watchCallback = callback;
        return mockSubscription;
      },
    );
  });

  it('초기 source는 live (sticky 비활성)', async () => {
    mockGranted();
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    simulateGps(37.4980, 127.0277, { accuracy: 20 });
    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.source).toBe('live');
    expect(result.current.result?.station.name).toBe('강남');
    // #1486 (ADR-015 §2) — sticky 비활성 시 liveResult=result, stickyDisplayOnly=null.
    expect(result.current.liveResult?.station.name).toBe('강남');
    expect(result.current.stickyDisplayOnly).toBeNull();
  });

  it('AsyncStorage 미리 저장된 sticky lock 있고 GPS가 다른 역이면 result는 sticky 역으로 override', async () => {
    // 효창공원앞 lock 미리 저장(1분 전). GPS는 강남 좌표 → sticky override.
    const hyochang = { id: '6-019', name: '효창공원앞', line: '6', lineColor: '#cd7c2f',
      lat: 37.539252, lng: 126.961392 };
    await AsyncStorage.setItem(
      'subway-now:sticky-station',
      JSON.stringify({ station: hyochang, lockedAt: Date.now() - 60_000 }),
    );
    mockGranted();
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    simulateGps(37.4980, 127.0277, { accuracy: 100 }); // 강남, accuracy 나쁨 → sticky가 better-fix로 갱신 X
    await waitFor(() => expect(result.current.source).toBe('sticky'));
    expect(result.current.result?.station.name).toBe('효창공원앞');
    // distanceKm은 userLocation 기준 재계산 (효창 ↔ 강남 ≈ 10km+)
    expect(result.current.result?.distanceKm).toBeGreaterThan(5);
    // #1486 (ADR-015 §2) — sticky override 상황에서 liveResult/stickyDisplayOnly 분리 검증.
    // liveResult는 sticky 무시 GPS 최근접(강남) — fire path 입력.
    expect(result.current.liveResult?.station.name).toBe('강남');
    // stickyDisplayOnly는 표시 전용 sticky 정보(효창공원앞) — DebugModal/UI 추적.
    expect(result.current.stickyDisplayOnly?.name).toBe('효창공원앞');
  });

  // #876 — sticky.locked와 result.station이 같은 역이면 source='sticky'지만 result는 live 객체 그대로 반환.
  it('sticky lock과 GPS 결과가 같은 역이면 source=sticky + result는 live 그대로', async () => {
    // 강남 lock 미리 저장. GPS도 강남 좌표 → exposed memo의 same-station 분기 진입.
    const gangnam = { id: '2-022', name: '강남', line: '2', lineColor: '#009D3E',
      lat: 37.49799, lng: 127.027912 };
    await AsyncStorage.setItem(
      'subway-now:sticky-station',
      JSON.stringify({ station: gangnam, lockedAt: Date.now() - 60_000 }),
    );
    mockGranted();
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    simulateGps(37.4980, 127.0277, { accuracy: 20 });
    await waitFor(() => expect(result.current.result?.station.name).toBe('강남'));
    expect(result.current.source).toBe('sticky');
  });

  // #1317 — 지도탭 "현재위치" 명시 탭은 sticky를 비우고 live 위치를 노출.
  it('requestCurrentLocation 호출 시 sticky를 비우고 live 위치로 복귀한다', async () => {
    // 효창공원앞 lock 미리 저장. GPS는 강남 → 초기엔 sticky override.
    const hyochang = { id: '6-019', name: '효창공원앞', line: '6', lineColor: '#cd7c2f',
      lat: 37.539252, lng: 126.961392 };
    await AsyncStorage.setItem(
      'subway-now:sticky-station',
      JSON.stringify({ station: hyochang, lockedAt: Date.now() - 60_000 }),
    );
    mockGranted();
    mockLocation(37.4980, 127.0277, { accuracy: 100 }); // refresh가 받을 강남 좌표
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    simulateGps(37.4980, 127.0277, { accuracy: 100 });
    await waitFor(() => expect(result.current.source).toBe('sticky'));

    // "현재위치" 탭 → releaseLock + refresh. sticky가 비워져 live(강남)로 복귀.
    await act(async () => {
      await result.current.requestCurrentLocation();
    });
    await waitFor(() => expect(result.current.source).toBe('live'));
    expect(result.current.result?.station.name).toBe('강남');
    // refresh 경로로 fresh GPS도 요청됐다.
    expect(Location.getCurrentPositionAsync).toHaveBeenCalled();
  });
});

describe('useNearestStation — E2E mock mode', () => {
  beforeEach(() => {
    e2eState.isMock = true;
    jest.clearAllMocks();
  });

  afterEach(() => {
    e2eState.isMock = false;
  });

  it('권한 API를 호출하지 않고 즉시 강남역 fixture를 노출한다', async () => {
    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(Location.watchPositionAsync).not.toHaveBeenCalled();
    expect(Location.getLastKnownPositionAsync).not.toHaveBeenCalled();
    expect(result.current.permissionDenied).toBe(false);
    expect(result.current.locationUncertain).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.userLocation).toEqual({ lat: 37.49799, lng: 127.027912 });
    expect(result.current.accuracyMeters).toBe(10);
    expect(result.current.speedMps).toBe(0);
    expect(result.current.result?.station.name).toBe('강남');
  });

  it('refresh 호출 시에도 권한 API를 호출하지 않고 fixture 상태를 유지한다', async () => {
    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refresh();
    });

    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
    expect(result.current.result?.station.name).toBe('강남');
    expect(result.current.locationUncertain).toBe(false);
    expect(result.current.permissionDenied).toBe(false);
  });
});

describe('useNearestStation — #852 GPS state & lastFix', () => {
  // RN의 AppState.currentState는 plain property — defineProperty로 직접 덮어쓴다.
  const originalCurrentState = AppState.currentState;

  beforeEach(() => {
    jest.clearAllMocks();
    appStateCallback = null;
    watchCallback = null;
    mockNoLastKnownLocation();
    mockSubscription.remove.mockClear();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallback) => {
        watchCallback = callback;
        return mockSubscription;
      },
    );
    mockGranted();
    mockLocation(37.4979, 127.0276);
    // jest 환경에서 AppState.currentState가 'unknown'일 수 있어 명시적으로 'active' 고정.
    // 실제 UI hook은 마운트 시점이 FG라 'fg' 기본값과 일치.
    (AppState as { currentState: string }).currentState = 'active';
  });

  afterEach(() => {
    (AppState as { currentState: string }).currentState = originalCurrentState;
  });

  it('초기 마운트 시 gpsActive=fg, lastFixAtMs=null', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.gpsActive).toBe('fg');
    expect(result.current.lastFixAtMs).toBeNull();
  });

  it('신뢰 fix 채택 시 lastFixAtMs가 fix timestamp로 갱신된다', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(watchCallback).not.toBeNull());

    const fixTs = new Date(2026, 5, 4, 8, 42, 15).getTime();
    simulateGps(37.4979, 127.0276, { accuracy: 20, timestamp: fixTs });

    await waitFor(() => expect(result.current.lastFixAtMs).toBe(fixTs));
  });

  it('AppState background 전환 시 gpsActive=bg, lastFixAtMs는 BG 진입 직전 값 유지', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(watchCallback).not.toBeNull());

    const fixTs = new Date(2026, 5, 4, 8, 42, 15).getTime();
    simulateGps(37.4979, 127.0276, { accuracy: 20, timestamp: fixTs });
    await waitFor(() => expect(result.current.lastFixAtMs).toBe(fixTs));

    act(() => { appStateCallback?.('background'); });

    expect(result.current.gpsActive).toBe('bg');
    // BG에서는 watch가 정지되어 lastFixAtMs가 갱신되지 않음 — stale window 시각화 핵심.
    expect(result.current.lastFixAtMs).toBe(fixTs);
  });

  it('AppState inactive도 gpsActive=bg로 매핑 (watch 정지 상태와 일관)', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { appStateCallback?.('inactive'); });

    expect(result.current.gpsActive).toBe('bg');
  });

  it('AppState active 복귀 시 gpsActive=fg로 즉시 전환', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { appStateCallback?.('background'); });
    expect(result.current.gpsActive).toBe('bg');

    await act(async () => { appStateCallback?.('active'); });
    expect(result.current.gpsActive).toBe('fg');
  });

  it('jump gate drop된 fix는 lastFixAtMs를 갱신하지 않는다 (stale 시각 유지)', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(watchCallback).not.toBeNull());

    const validTs = new Date(2026, 5, 4, 8, 42, 15).getTime();
    simulateGps(37.4979, 127.0276, { accuracy: 20, timestamp: validTs });
    await waitFor(() => expect(result.current.lastFixAtMs).toBe(validTs));

    // 25km 점프 8s — isPlausibleJump fail → drop, lastFixAtMs 미갱신.
    const jumpTs = validTs + 8_000;
    simulateGps(37.7, 127.3, { accuracy: 20, timestamp: jumpTs });

    // 약간 기다려도 stale 시각 유지(jump drop은 setLocationUncertain만 호출).
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.lastFixAtMs).toBe(validTs);
  });
});

describe('useNearestStation — #903 Seam G barometer→sticky', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    appStateCallback = null;
    watchCallback = null;
    mockNoLastKnownLocation();
    mockSubscription.remove.mockClear();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallback) => {
        watchCallback = callback;
        return mockSubscription;
      },
    );
    mockGranted();
  });

  it.each([
    { label: '기본(미전달) → automotive=false, subsurface=false', input: undefined, expected: false },
    { label: 'barometerSubsurface=true → automotive=true, subsurface=true', input: true, expected: true },
    { label: 'barometerSubsurface=false → automotive=false (graceful)', input: false, expected: false },
  ])('$label', async ({ input, expected }) => {
    const spy = jest.spyOn(useStickyStationModule, 'useStickyStation');
    renderHook(() => useNearestStation(input === undefined ? {} : { barometerSubsurface: input }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    // D6 (#1212) — motion 입력에 subsurface(=barometerSubsurface mirror) + tripActive 추가.
    expect(lastCall[1]).toEqual({ automotive: expected, subsurface: expected, tripActive: false });
    spy.mockRestore();
  });

  // D6 (#1212) — tripActive 입력이 sticky motion에 전달되는지 검증.
  it.each([
    { label: 'tripActive=true 전달', input: true, expected: true },
    { label: 'tripActive=false 전달', input: false, expected: false },
  ])('$label', async ({ input, expected }) => {
    const spy = jest.spyOn(useStickyStationModule, 'useStickyStation');
    renderHook(() => useNearestStation({ tripActive: input }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    expect(lastCall[1]).toEqual(expect.objectContaining({ tripActive: expected }));
    spy.mockRestore();
  });
});

describe('useNearestStation — #1313 subsurface GPS throttle', () => {
  // 지상 기본값: High@2s. 지하 throttle: Balanced@12s (#2100 — #1983 High 통일에서 재전환.
  // #2074 품질 게이트가 지하 fix를 전량 폐기하는 게 확인돼 지하 accuracy를 다시 Balanced로 낮춘다).
  // 상수에서 가져와 매직넘버 회피.
  const SURFACE_OPTIONS = {
    accuracy: Location.Accuracy.High,
    distanceInterval: 0,
    timeInterval: FG_WATCH_SURFACE_TIME_INTERVAL_MS,
  };
  const SUBSURFACE_OPTIONS = {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 0,
    timeInterval: FG_WATCH_SUBSURFACE_TIME_INTERVAL_MS,
  };
  // RN의 AppState.currentState는 plain property — restart effect가 'active' 가드에 참조한다.
  const originalCurrentState = AppState.currentState;

  // 마지막 watchPositionAsync 호출의 options 인자.
  const lastWatchOptions = () => {
    const calls = (Location.watchPositionAsync as jest.Mock).mock.calls;
    return calls[calls.length - 1][0];
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    appStateCallback = null;
    watchCallback = null;
    mockNoLastKnownLocation();
    mockSubscription.remove.mockClear();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallback) => {
        watchCallback = callback;
        return mockSubscription;
      },
    );
    mockGranted();
    (AppState as { currentState: string }).currentState = 'active';
  });

  afterEach(() => {
    (AppState as { currentState: string }).currentState = originalCurrentState;
  });

  // 마운트 시 subsurface 값에 따른 초기 watch 옵션 — undefined/false는 절대 throttle하지 않는다(안전 기본값).
  // #2100: subsurface=true는 accuracy=Balanced@12s (#1983 High 통일에서 재전환 — 상세 근거는
  // useNearestStation.ts FG_WATCH_OPTIONS_SUBSURFACE 주석 참고).
  it.each([
    { label: 'subsurface 미전달(undefined) → High@2s', props: {}, expected: () => SURFACE_OPTIONS },
    { label: 'subsurface=false → High@2s', props: { barometerSubsurface: false }, expected: () => SURFACE_OPTIONS },
    { label: 'subsurface=true → Balanced@12s (#2100)', props: { barometerSubsurface: true }, expected: () => SUBSURFACE_OPTIONS },
  ])('마운트 $label', async ({ props, expected }) => {
    renderHook(() => useNearestStation(props));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    // 마운트 effect는 1회만 — restart effect가 중복 start하지 않는다.
    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(lastWatchOptions()).toEqual(expected());
  });

  it('subsurface false→true flip 시 watch를 teardown 후 Balanced@12s로 재시작한다 (#2100)', async () => {
    const { rerender } = renderHook(
      ({ sub }: { sub: boolean }) => useNearestStation({ barometerSubsurface: sub }),
      { initialProps: { sub: false } },
    );
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));
    expect(lastWatchOptions()).toEqual(SURFACE_OPTIONS);

    await act(async () => { rerender({ sub: true }); });

    // teardown(remove) 후 새 옵션으로 재시작 — 누수/중복 구독 없음.
    expect(mockSubscription.remove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(2));
    expect(lastWatchOptions()).toEqual(SUBSURFACE_OPTIONS);
  });

  it('subsurface true→false flip 시 watch를 teardown 후 High@2s로 되돌린다', async () => {
    const { rerender } = renderHook(
      ({ sub }: { sub: boolean }) => useNearestStation({ barometerSubsurface: sub }),
      { initialProps: { sub: true } },
    );
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));
    expect(lastWatchOptions()).toEqual(SUBSURFACE_OPTIONS);

    await act(async () => { rerender({ sub: false }); });

    expect(mockSubscription.remove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(2));
    expect(lastWatchOptions()).toEqual(SURFACE_OPTIONS);
  });

  it('warmup(undefined)→false 전이는 throttle boolean 불변이라 재시작하지 않는다 (no-op)', async () => {
    const { rerender } = renderHook(
      ({ sub }: { sub?: boolean }) => useNearestStation({ barometerSubsurface: sub }),
      { initialProps: { sub: undefined } },
    );
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));

    await act(async () => { rerender({ sub: false }); });

    // 둘 다 High@2s → 재시작 없음, teardown 없음.
    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(mockSubscription.remove).not.toHaveBeenCalled();
  });

  it('백그라운드 중 subsurface flip은 FG watch를 켜지 않는다 (active 가드)', async () => {
    const { rerender } = renderHook(
      ({ sub }: { sub: boolean }) => useNearestStation({ barometerSubsurface: sub }),
      { initialProps: { sub: false } },
    );
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));

    // 앱이 백그라운드인 동안 flip — restart effect는 'active' 가드에서 early return.
    (AppState as { currentState: string }).currentState = 'background';
    await act(async () => { rerender({ sub: true }); });

    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(mockSubscription.remove).not.toHaveBeenCalled();

    // FG 복귀 시 'active' 핸들러 refresh→startWatch가 throttledRef를 읽어 Balanced@12s로 반영.
    (AppState as { currentState: string }).currentState = 'active';
    await act(async () => { appStateCallback?.('active'); });
    await waitFor(() => expect(lastWatchOptions()).toEqual(SUBSURFACE_OPTIONS));
  });

  // #2100 — 지상은 accuracy=High, 지하(subsurface 확정)는 accuracy=Balanced로 갈린다.
  // 지상 accuracy가 실수로 Balanced로 떨어지는 회귀(#1983이 막으려던 문제)를 조기 차단하기 위해
  // accuracy 값 자체를 pin한다.
  it.each([
    { label: 'surface(subsurface=false)', props: { barometerSubsurface: false }, expectedAccuracy: () => Location.Accuracy.High },
    { label: 'subsurface(subsurface=true)', props: { barometerSubsurface: true }, expectedAccuracy: () => Location.Accuracy.Balanced },
  ])('#2100 $label 에서 watch accuracy가 pin된 값과 일치한다', async ({ props, expectedAccuracy }) => {
    renderHook(() => useNearestStation(props));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    expect(lastWatchOptions().accuracy).toBe(expectedAccuracy());
  });
});

// #2514 — boardingLock 활성 시 device GPS demote. backend가 realtimePosition으로 열차를
// GPS-독립적으로 추적하므로 lock 활성 중에는 device GPS 고정밀 추적이 불필요(발열/배터리 절감).
// lock 활성 전(undefined/false)은 기존 정확도(High@2s 또는 subsurface Balanced@12s)를 그대로
// 유지해야 한다 — origin-proximity/boarding-prompt 감지에 필요.
describe('useNearestStation — #2514 boardingLock 활성 GPS demote', () => {
  const SURFACE_OPTIONS = {
    accuracy: Location.Accuracy.High,
    distanceInterval: 0,
    timeInterval: FG_WATCH_SURFACE_TIME_INTERVAL_MS,
  };
  const SUBSURFACE_OPTIONS = {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 0,
    timeInterval: FG_WATCH_SUBSURFACE_TIME_INTERVAL_MS,
  };
  const LOCKED_OPTIONS = {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 0,
    timeInterval: FG_WATCH_LOCKED_TIME_INTERVAL_MS,
  };
  const originalCurrentState = AppState.currentState;

  const lastWatchOptions = () => {
    const calls = (Location.watchPositionAsync as jest.Mock).mock.calls;
    return calls[calls.length - 1][0];
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    appStateCallback = null;
    watchCallback = null;
    mockNoLastKnownLocation();
    mockSubscription.remove.mockClear();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallback) => {
        watchCallback = callback;
        return mockSubscription;
      },
    );
    mockGranted();
    (AppState as { currentState: string }).currentState = 'active';
  });

  afterEach(() => {
    (AppState as { currentState: string }).currentState = originalCurrentState;
  });

  it('lockActive 미전달(undefined) → 기존 지상 기본값(High@2s) 유지', async () => {
    renderHook(() => useNearestStation({}));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    expect(lastWatchOptions()).toEqual(SURFACE_OPTIONS);
  });

  it('lockActive=true → 마운트 즉시 Balanced/90s locked 옵션으로 시작한다', async () => {
    renderHook(() => useNearestStation({ lockActive: true }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(lastWatchOptions()).toEqual(LOCKED_OPTIONS);
  });

  it('lockActive false→true flip 시 watch를 teardown 후 locked 옵션으로 재시작한다', async () => {
    const { rerender } = renderHook(
      ({ locked }: { locked: boolean }) => useNearestStation({ lockActive: locked }),
      { initialProps: { locked: false } },
    );
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));
    expect(lastWatchOptions()).toEqual(SURFACE_OPTIONS);

    await act(async () => {
      rerender({ locked: true });
    });

    expect(mockSubscription.remove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(2));
    expect(lastWatchOptions()).toEqual(LOCKED_OPTIONS);
  });

  it('lockActive true→false flip 시 watch를 teardown 후 기존 정확도(High@2s)로 되돌린다', async () => {
    const { rerender } = renderHook(
      ({ locked }: { locked: boolean }) => useNearestStation({ lockActive: locked }),
      { initialProps: { locked: true } },
    );
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));
    expect(lastWatchOptions()).toEqual(LOCKED_OPTIONS);

    await act(async () => {
      rerender({ locked: false });
    });

    expect(mockSubscription.remove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(2));
    expect(lastWatchOptions()).toEqual(SURFACE_OPTIONS);
  });

  // lock 활성이면 지하(subsurface throttle) 여부와 무관하게 locked가 우선한다 — backend 추적이
  // GPS 정밀도 자체를 대체하므로 지하 확정 여부는 더 이상 의미 없다.
  it('lockActive=true + barometerSubsurface=true 조합에서도 locked가 우선한다(subsurface보다 강)', async () => {
    renderHook(() => useNearestStation({ lockActive: true, barometerSubsurface: true }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    expect(lastWatchOptions()).toEqual(LOCKED_OPTIONS);
  });

  it('lockActive=true 상태에서 barometerSubsurface만 바뀌어도 locked 옵션을 유지한다(재시작 없음)', async () => {
    const { rerender } = renderHook(
      ({ sub }: { sub: boolean }) => useNearestStation({ lockActive: true, barometerSubsurface: sub }),
      { initialProps: { sub: false } },
    );
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));
    expect(lastWatchOptions()).toEqual(LOCKED_OPTIONS);

    await act(async () => {
      rerender({ sub: true });
    });

    // throttled(subsurface) 값이 false→true로 바뀌었지만 locked가 이미 최우선이라 옵션 자체는
    // 그대로 — 다만 restart effect는 throttled 변화를 감지해 재시작할 수 있다(no-op 재시작 허용).
    expect(lastWatchOptions()).toEqual(LOCKED_OPTIONS);
  });

  it('백그라운드 중 lockActive flip은 FG watch를 켜지 않는다 (active 가드)', async () => {
    const { rerender } = renderHook(
      ({ locked }: { locked: boolean }) => useNearestStation({ lockActive: locked }),
      { initialProps: { locked: false } },
    );
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));

    (AppState as { currentState: string }).currentState = 'background';
    await act(async () => {
      rerender({ locked: true });
    });

    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(mockSubscription.remove).not.toHaveBeenCalled();

    (AppState as { currentState: string }).currentState = 'active';
    await act(async () => {
      appStateCallback?.('active');
    });
    await waitFor(() => expect(lastWatchOptions()).toEqual(LOCKED_OPTIONS));
  });
});

describe('useNearestStation — #2070 GPS 품질 게이트 (결정 tier 입력)', () => {
  // 지상 기본값: High@2s. 지하 throttle: Balanced@12s(#2100). #1313 describe와 동일 값 — 매직넘버
  // 회피 위해 상수에서 가져온다(#2070은 barometerSubsurface OR profileWatchDegraded로 트리거를 확장).
  const SURFACE_OPTIONS = {
    accuracy: Location.Accuracy.High,
    distanceInterval: 0,
    timeInterval: FG_WATCH_SURFACE_TIME_INTERVAL_MS,
  };
  const SUBSURFACE_OPTIONS = {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 0,
    timeInterval: FG_WATCH_SUBSURFACE_TIME_INTERVAL_MS,
  };
  const originalCurrentState = AppState.currentState;

  const lastWatchOptions = () => {
    const calls = (Location.watchPositionAsync as jest.Mock).mock.calls;
    return calls[calls.length - 1][0];
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    appStateCallback = null;
    watchCallback = null;
    mockNoLastKnownLocation();
    mockSubscription.remove.mockClear();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallback) => {
        watchCallback = callback;
        return mockSubscription;
      },
    );
    mockGranted();
    (AppState as { currentState: string }).currentState = 'active';
  });

  afterEach(() => {
    (AppState as { currentState: string }).currentState = originalCurrentState;
  });

  it('표시 게이트(250m)는 통과하지만 품질 게이트(100m) 미달 fix는 gps-quality-drop:accuracy를 남긴다', async () => {
    const { clearGpsDropEntries, getGpsDropEntries } =
      jest.requireActual('../../utils/gpsDropBuffer');
    clearGpsDropEntries();
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.498, 127.0277, { accuracy: 150 });

    // 표시/결과는 그대로 갱신 — 결정 tier 제외는 gpsQualityDegraded/gps-drop 로그로 별도 노출.
    expect(result.current.userLocation).not.toBeNull();
    const drops = getGpsDropEntries();
    expect(drops).toHaveLength(1);
    expect(drops[0].dropReason).toBe('gps-quality-drop:accuracy');
    // 콜드스타트(직전 통과 기록 없음) — false positive 방지로 아직 degraded=false.
    expect(result.current.gpsQualityDegraded).toBe(false);
  });

  it('accuracy는 통과하지만 fix가 15s 이상 오래되면 gps-quality-drop:stale', async () => {
    const { clearGpsDropEntries, getGpsDropEntries } =
      jest.requireActual('../../utils/gpsDropBuffer');
    clearGpsDropEntries();
    renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.498, 127.0277, { accuracy: 50, timestamp: Date.now() - 16_000 });

    const drops = getGpsDropEntries();
    expect(drops).toHaveLength(1);
    expect(drops[0].dropReason).toBe('gps-quality-drop:stale');
  });

  // #2076 결함2 — 급락(accuracy 1회성 급증) 단독은 더 이상 gpsQualityDegraded를 발동시키지
  // 않는다. 지상 urban canyon(고층빌딩 사이 multipath)에서 accuracy가 1회 튀어도 지하로
  // 오분류(inferEnvironment 우선순위 8 hint)되던 결함 차단.
  it('급락(50→180m) 1회 단독으로는 gpsQualityDegraded=false 유지 (#2076 결함2 — urban canyon 오탐 차단)', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.498, 127.0277, { accuracy: 50 });
    expect(result.current.gpsQualityDegraded).toBe(false);

    simulateGps(37.4981, 127.0278, { accuracy: 180 }); // 급락(130m > 100m 임계)
    expect(result.current.gpsQualityDegraded).toBe(false);
  });
});

describe('useNearestStation — #2076 GPS 품질 게이트 후속 (absence 독립 타이머 / hysteresis 해제)', () => {
  const originalCurrentState = AppState.currentState;

  const lastWatchOptionsAt = () => {
    const calls = (Location.watchPositionAsync as jest.Mock).mock.calls;
    return calls[calls.length - 1][0];
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    appStateCallback = null;
    watchCallback = null;
    mockNoLastKnownLocation();
    mockSubscription.remove.mockClear();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallback) => {
        watchCallback = callback;
        return mockSubscription;
      },
    );
    mockGranted();
    (AppState as { currentState: string }).currentState = 'active';
    jest.useFakeTimers();
  });

  afterEach(() => {
    (AppState as { currentState: string }).currentState = originalCurrentState;
    jest.useRealTimers();
  });

  // #2076 결함1 — 심부 지하: fix가 완전히 끊겨도(watch 콜백 자체가 호출되지 않아도) 독립
  // 타이머가 마지막 게이트 통과 fix 시각을 주기적으로 재평가해 absence 30s를 판정한다.
  it('fix 완전 중단 30s+ → absence 독립 타이머가 gpsQualityDegraded=true로 전이시킨다 (심부 지하)', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.498, 127.0277, { accuracy: 50 });
    expect(result.current.gpsQualityDegraded).toBe(false);

    // 이후 fix 없음(완전 유실) — 타이머만으로 30s+ 경과를 판정.
    act(() => {
      jest.advanceTimersByTime(40_000);
    });

    expect(result.current.gpsQualityDegraded).toBe(true);
  });

  // 표시 게이트(250m) drop fix도 품질 게이트 평가에는 공급돼야 hysteresis 카운터가 정확히
  // 리셋된다 — 표시(userLocation)는 이 fix로 갱신되지 않는다(표시 경로 불변).
  it('>250m fix는 표시(userLocation) 미갱신 + 품질 게이트 hysteresis 카운터를 리셋한다', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    // 최초 통과 fix로 lastPassAt 기준점을 세운다(콜드스타트에서는 absence 판정 자체가 보류된다).
    simulateGps(37.4979, 127.0276, { accuracy: 50 });
    expect(result.current.gpsQualityDegraded).toBe(false);
    // 연속 통과 카운터를 0으로 리셋(이후 hysteresis 카운트를 1부터 검증하기 위해).
    simulateGps(37.51, 127.05, { accuracy: 300 });

    // absence로 degraded=true 유도.
    act(() => {
      jest.advanceTimersByTime(40_000);
    });
    expect(result.current.gpsQualityDegraded).toBe(true);

    // 통과 fix 1회 — hysteresis 미충족(1/2), 아직 해제 안 됨.
    simulateGps(37.498, 127.0277, { accuracy: 50 });
    expect(result.current.gpsQualityDegraded).toBe(true);
    const locationAfterFirstPass = result.current.userLocation;

    // >250m fix — 표시 미갱신 + 연속 통과 카운터 리셋(hysteresis 처음부터 다시 세야 함).
    simulateGps(37.51, 127.05, { accuracy: 300 });
    expect(result.current.userLocation).toEqual(locationAfterFirstPass);
    expect(result.current.gpsQualityDegraded).toBe(true);

    // 리셋되었으므로 통과 fix 1회로는 아직 해제 안 됨.
    simulateGps(37.498, 127.0277, { accuracy: 50 });
    expect(result.current.gpsQualityDegraded).toBe(true);

    // 연속 2회째 통과 fix → 해제.
    simulateGps(37.4981, 127.0278, { accuracy: 50 });
    expect(result.current.gpsQualityDegraded).toBe(false);
  });

  it('hysteresis: 통과 fix 1회로는 해제 안 되고, 연속 2회째에 해제된다', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4979, 127.0276, { accuracy: 50 });
    // 연속 통과 카운터를 0으로 리셋(이후 hysteresis 카운트를 1부터 검증하기 위해).
    simulateGps(37.51, 127.05, { accuracy: 300 });

    act(() => {
      jest.advanceTimersByTime(40_000);
    });
    expect(result.current.gpsQualityDegraded).toBe(true);

    simulateGps(37.498, 127.0277, { accuracy: 50 });
    expect(result.current.gpsQualityDegraded).toBe(true);

    simulateGps(37.4981, 127.0278, { accuracy: 50 });
    expect(result.current.gpsQualityDegraded).toBe(false);
  });

  // #2100 — watch 프로파일 release는 eager(단 1회 통과 fix)라 공개 gpsQualityDegraded의 hysteresis
  // (연속 2회)보다 먼저 지상 프로파일로 원복된다. Balanced 지하 프로파일에서 hysteresis 2연속
  // 달성 자체가 지연되는 악순환을 끊기 위함(#2100 "선원복 후 fix 대기").
  it('degraded 발생(absence) 시 FG watch가 지하 프로파일(Balanced@12s)로 전환되고, 게이트 통과 fix 1회만으로 즉시 지상으로 원복된다', async () => {
    renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));
    expect(lastWatchOptionsAt()).toEqual({
      accuracy: Location.Accuracy.High,
      distanceInterval: 0,
      timeInterval: FG_WATCH_SURFACE_TIME_INTERVAL_MS,
    });

    simulateGps(37.4979, 127.0276, { accuracy: 50 });

    act(() => {
      jest.advanceTimersByTime(40_000);
    });

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(2));
    expect(lastWatchOptionsAt()).toEqual({
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 0,
      timeInterval: FG_WATCH_SUBSURFACE_TIME_INTERVAL_MS,
    });

    // 게이트 통과 fix 1회만으로 watch 프로파일은 즉시 원복된다(공개 gpsQualityDegraded는 아직
    // hysteresis 미충족이라 true로 남을 수 있음 — 별개 신호. 이 divergence(profile=High +
    // gpsQualityDegraded=true 동시 상태)는 아래 '#2100 divergence' 테스트에서 직접 assert한다).
    simulateGps(37.498, 127.0277, { accuracy: 50 });

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(3));
    expect(lastWatchOptionsAt()).toEqual({
      accuracy: Location.Accuracy.High,
      distanceInterval: 0,
      timeInterval: FG_WATCH_SURFACE_TIME_INTERVAL_MS,
    });
  });

  // #2100 divergence — watch 프로파일(eager 1회 release)과 공개 gpsQualityDegraded(hysteresis
  // 2연속 release)는 서로 다른 신호라 일시적으로 어긋날 수 있다: 게이트 통과 fix 1회만 들어온
  // 시점에는 watch가 이미 High로 선원복됐지만 gpsQualityDegraded는 아직 true(hysteresis 미충족)로
  // 남는다. inferEnvironment 등 gpsQualityDegraded 소비자가 이 시점에도 여전히 "품질 저하"로
  // 판정하는 것은 의도된 동작(품질 게이트/fusion 로직 불변 — #2100 "하지 말 것") — 두 신호가 같은
  // fix 이벤트에서 동시에 diverge할 수 있음을 회귀 방지용으로 고정한다.
  it('divergence: 게이트 통과 fix 1회 후 watch profile=High 이면서 공개 gpsQualityDegraded=true를 동시에 유지한다', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));

    simulateGps(37.4979, 127.0276, { accuracy: 50 });
    // 연속 통과 카운터를 0으로 리셋(이후 hysteresis 카운트를 1부터 검증하기 위해 — 다른 #2076
    // 테스트와 동일 패턴).
    simulateGps(37.51, 127.05, { accuracy: 300 });
    act(() => {
      jest.advanceTimersByTime(40_000);
    });
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(2));
    expect(result.current.gpsQualityDegraded).toBe(true);

    // 게이트 통과 fix 1회 — watch profile은 즉시 High로 원복되지만, gpsQualityDegraded는
    // hysteresis(연속 2회) 미충족이라 여전히 true.
    simulateGps(37.498, 127.0277, { accuracy: 50 });

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(3));
    expect(lastWatchOptionsAt()).toEqual({
      accuracy: Location.Accuracy.High,
      distanceInterval: 0,
      timeInterval: FG_WATCH_SURFACE_TIME_INTERVAL_MS,
    });
    expect(result.current.gpsQualityDegraded).toBe(true);
  });

  it('barometerSubsurface=true가 이미 활성이면 gpsQualityDegraded 변화만으로는 재시작하지 않는다 (이미 지하 프로파일)', async () => {
    const { rerender } = renderHook(
      ({ sub }: { sub: boolean }) => useNearestStation({ barometerSubsurface: sub }),
      { initialProps: { sub: true } },
    );
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));
    expect(lastWatchOptionsAt()).toEqual({
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 0,
      timeInterval: FG_WATCH_SUBSURFACE_TIME_INTERVAL_MS,
    });

    await act(async () => {
      rerender({ sub: true });
    });
    simulateGps(37.4979, 127.0276, { accuracy: 50 });
    act(() => {
      jest.advanceTimersByTime(40_000); // degraded=true여도 이미 subsurface 프로파일
    });

    // barometerSubsurface=true가 이미 throttle=true를 만들었으므로 추가 재시작 없음.
    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1);
  });
});

describe('useNearestStation — #1363 sticky input memo 안정성 (cascade 차단)', () => {
  // useStickyStation에 전달되는 fix/motion object가 inline literal이면 매 render 새 ref가 되어
  // sticky 평가 effect가 매 render 재실행 → 9시간 trip ~16만회 emit. useMemo로 안정화되면
  // 입력 값이 동일한 한 같은 reference를 유지해야 한다.
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    appStateCallback = null;
    watchCallback = null;
    mockNoLastKnownLocation();
    mockSubscription.remove.mockClear();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallback) => {
        watchCallback = callback;
        return mockSubscription;
      },
    );
    mockGranted();
  });

  it('inputs 값이 그대로(같은 값)면 sticky 입력 fix/motion reference가 유지된다', async () => {
    const spy = jest.spyOn(useStickyStationModule, 'useStickyStation');
    const { rerender } = renderHook(
      ({ sub, trip }: { sub: boolean; trip: boolean }) =>
        useNearestStation({ barometerSubsurface: sub, tripActive: trip }),
      { initialProps: { sub: false, trip: false } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());

    const initialCallCount = spy.mock.calls.length;
    const initialFixRef = spy.mock.calls[initialCallCount - 1][0];
    const initialMotionRef = spy.mock.calls[initialCallCount - 1][1];

    // 같은 inputs로 N번 rerender — memo 키가 안 바뀌므로 같은 ref여야 한다.
    for (let i = 0; i < 5; i += 1) {
      rerender({ sub: false, trip: false });
    }
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    expect(lastCall[0]).toBe(initialFixRef);
    expect(lastCall[1]).toBe(initialMotionRef);
    spy.mockRestore();
  });

  it('inputs 값이 바뀌면 motion ref가 새로 생성된다 (정상 갱신)', async () => {
    const spy = jest.spyOn(useStickyStationModule, 'useStickyStation');
    const { rerender } = renderHook(
      ({ sub }: { sub: boolean }) => useNearestStation({ barometerSubsurface: sub }),
      { initialProps: { sub: false } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const initialMotionRef = spy.mock.calls[spy.mock.calls.length - 1][1];

    // subsurface=true로 변경 → memo deps 변경 → 새 ref.
    rerender({ sub: true });
    const nextMotionRef = spy.mock.calls[spy.mock.calls.length - 1][1];
    expect(nextMotionRef).not.toBe(initialMotionRef);
    expect(nextMotionRef).toEqual({ automotive: true, subsurface: true, tripActive: false });
    spy.mockRestore();
  });
});
