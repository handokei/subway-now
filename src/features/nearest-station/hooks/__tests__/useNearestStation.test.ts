import { renderHook, act, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNearestStation } from '../useNearestStation';
import * as useStickyStationModule from '../useStickyStation';
import * as findNearestStationModule from '../../utils/findNearestStation';
import { MAX_ACCURACY_M, MAX_ACCURACY_M_DISPLAY, MAX_LOCATION_AGE_MS } from '../../../../shared/constants/location';
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

  it('watchPositionAsync에 High·distanceInterval:0·timeInterval:2000을 전달한다', async () => {
    mockGranted();

    renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    expect(Location.watchPositionAsync).toHaveBeenCalledWith(
      {
        accuracy: Location.Accuracy.High,
        distanceInterval: 0,
        timeInterval: 2000,
      },
      expect.any(Function),
    );
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

    expect(result.current.result?.station.name).toBe('교대');
    expect(result.current.variants.length).toBeGreaterThan(1);
    expect(result.current.variants.every((v) => v.name === '교대')).toBe(true);
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

  it('표시 게이트 drop 시 fusion debug buffer에 gps-drop 엔트리를 push (speed 양수 분기)', async () => {
    const { pushFusionDebugEntry: _p, clearFusionDebugEntries, getFusionDebugEntries } =
      jest.requireActual('../../utils/fusionDebugBuffer');
    void _p;
    clearFusionDebugEntries();
    mockGranted();
    renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, {
      accuracy: MAX_ACCURACY_M_DISPLAY + 1,
      speed: 1.5,
    });

    const entries = getFusionDebugEntries();
    const drop = entries.find(
      (e: { kind: string; event?: string }) => e.kind === 'gps' && e.event === 'gps-drop',
    );
    expect(drop).toBeDefined();
    expect(drop.speedMps).toBe(1.5);
    expect(drop.dropReason).toBe('low-accuracy-display');
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
