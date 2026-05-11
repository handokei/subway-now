import { renderHook, act, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { AppState } from 'react-native';
import { useNearestStation } from '../useNearestStation';
import * as findNearestStationModule from '../../utils/findNearestStation';

jest.mock('expo-location');

const mockRemove = jest.fn();
let appStateCallback: ((state: string) => void) | null = null;
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  appStateCallback = listener as (state: string) => void;
  return { remove: mockRemove } as unknown as ReturnType<typeof AppState.addEventListener>;
});

const mockSubscription = { remove: jest.fn() };
let watchCallback: ((location: { coords: { latitude: number; longitude: number; speed?: number | null } }) => void) | null = null;

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

const mockLastKnownLocation = (lat: number, lng: number) => {
  (Location.getLastKnownPositionAsync as jest.Mock).mockResolvedValue({
    coords: { latitude: lat, longitude: lng },
  });
};

const mockNoLastKnownLocation = () => {
  (Location.getLastKnownPositionAsync as jest.Mock).mockResolvedValue(null);
};

const mockLocation = (lat: number, lng: number) => {
  (Location.getCurrentPositionAsync as jest.Mock).mockResolvedValue({
    coords: { latitude: lat, longitude: lng },
  });
};

const simulateGps = (lat: number, lng: number, speed: number | null = null) => {
  act(() => {
    watchCallback?.({ coords: { latitude: lat, longitude: lng, speed } });
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

    simulateGps(37.4980, 127.0277, 15.5);

    await waitFor(() => expect(result.current.speedMps).toBe(15.5));
  });

  it('GPS speed가 음수면 speedMps를 null로 정규화한다', async () => {
    mockGranted();
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, -1);

    await waitFor(() => expect(result.current.speedMps).toBeNull());
  });

  it('GPS speed가 null이면 speedMps도 null이다', async () => {
    mockGranted();
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277, null);

    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.speedMps).toBeNull();
  });

  it('500m 초과 거리에서도 가장 가까운 역을 반환한다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.5200, 127.0000);

    await waitFor(() => expect(result.current.result).not.toBeNull());

    expect(result.current.result?.distanceKm).toBeGreaterThan(0.5);
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

  it('watchPositionAsync에 accuracy: High, distanceInterval: 10을 전달한다', async () => {
    mockGranted();

    renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    expect(Location.watchPositionAsync).toHaveBeenCalledWith(
      { accuracy: Location.Accuracy.High, distanceInterval: 10 },
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

  it('같은 역 좌표 반복 시 setState는 최초 1회만 호출된다', async () => {
    mockGranted();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(37.4980, 127.0277);

    await waitFor(() => expect(result.current.result?.station.name).toBe('강남'));

    const firstLocation = result.current.userLocation;

    // 같은 좌표로 다시 콜백 (거리 변화 <10m)
    simulateGps(37.4980, 127.0277);

    // userLocation이 변경되지 않아야 함
    expect(result.current.userLocation).toBe(firstLocation);
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
});
