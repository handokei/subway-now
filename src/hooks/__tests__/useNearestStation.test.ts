import { renderHook, act, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { AppState } from 'react-native';
import { useNearestStation } from '../useNearestStation';

jest.mock('expo-location');

const mockRemove = jest.fn();
let appStateCallback: ((state: string) => void) | null = null;
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  appStateCallback = listener as (state: string) => void;
  return { remove: mockRemove } as unknown as ReturnType<typeof AppState.addEventListener>;
});

const mockSubscription = { remove: jest.fn() };
let watchCallback: ((location: { coords: { latitude: number; longitude: number } }) => void) | null = null;

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

const simulateGps = (lat: number, lng: number) => {
  act(() => {
    watchCallback?.({ coords: { latitude: lat, longitude: lng } });
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
});
