import { renderHook, act, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { AppState } from 'react-native';
import { useNearestStation } from '../useNearestStation';
import * as findNearestStationModule from '../../utils/findNearestStation';
import { MAX_ACCURACY_M, MAX_ACCURACY_M_DISPLAY, MAX_LOCATION_AGE_MS } from '../../constants/location';

jest.mock('expo-location');

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
  opts: { speed?: number | null; accuracy?: number | null } = {},
) => {
  act(() => {
    watchCallback?.({
      coords: {
        latitude: lat,
        longitude: lng,
        speed: opts.speed ?? null,
        accuracy: opts.accuracy ?? null,
      },
      timestamp: Date.now(),
    });
  });
};

describe('useNearestStation', () => {
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

  it('watchPositionAsync에 BestForNavigation·distanceInterval:0·timeInterval:2000을 전달한다', async () => {
    mockGranted();

    renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    expect(Location.watchPositionAsync).toHaveBeenCalledWith(
      {
        accuracy: Location.Accuracy.BestForNavigation,
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

    // 이후 null 반환
    const spy = jest.spyOn(findNearestStationModule, 'findNearestStations').mockReturnValue(null);
    simulateGps(37.0, 127.0);

    await waitFor(() => expect(result.current.result).toBeNull());
    expect(result.current.variants).toEqual([]);

    spy.mockRestore();
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

  it('stale 캐시 위치(MAX_LOCATION_AGE_MS 초과)는 무시하고 watch만 시작한다', async () => {
    mockGranted();
    mockLastKnownLocation(37.4980, 127.0277, { ageMs: MAX_LOCATION_AGE_MS + 1 });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    // stale 캐시는 무시 → result는 null 유지 (watch 콜백 전까지)
    expect(result.current.result).toBeNull();
  });

  it('저정확도 캐시 위치(MAX_ACCURACY_M 초과)는 무시한다', async () => {
    mockGranted();
    mockLastKnownLocation(37.4980, 127.0277, { accuracy: MAX_ACCURACY_M + 1 });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    expect(result.current.result).toBeNull();
  });

  it('신선하고 정확한 캐시 위치는 사용한다', async () => {
    mockGranted();
    mockLastKnownLocation(37.4980, 127.0277, { ageMs: 5_000, accuracy: 30 });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.result?.station.name).toBe('강남');
  });

  it('watch 콜백 표시 게이트 초과(MAX_ACCURACY_M_DISPLAY 초과) 좌표는 setState하지 않는다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, { accuracy: MAX_ACCURACY_M_DISPLAY + 1 });

    // 표시 게이트 초과 → setState 차단
    expect(result.current.result).toBeNull();
    expect(result.current.userLocation).toBeNull();
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

  it('refresh 시 표시 게이트 초과 좌표는 setState하지 않는다', async () => {
    mockGranted();
    mockLocation(37.4980, 127.0277, { accuracy: MAX_ACCURACY_M_DISPLAY + 1 });

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh();
    });

    expect(Location.getCurrentPositionAsync).toHaveBeenCalled();
    // 표시 게이트 초과 → result 갱신 안 됨
    expect(result.current.result).toBeNull();
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
