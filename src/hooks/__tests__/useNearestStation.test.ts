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

const mockLocation = (lat: number, lng: number) => {
  (Location.getCurrentPositionAsync as jest.Mock).mockResolvedValue({
    coords: { latitude: lat, longitude: lng },
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

describe('useNearestStation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    appStateCallback = null;
    mockNoLastKnownLocation();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('위치 권한 거부 시 permissionDenied가 true이고 loading이 false이다', async () => {
    mockDenied();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.permissionDenied).toBe(true);
    expect(result.current.result).toBeNull();
  });

  it('500m 이내에 역이 있으면 해당 역을 반환한다', async () => {
    mockGranted();
    mockLocation(37.4980, 127.0277);

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.result).not.toBeNull();
    expect(result.current.result?.station.name).toBe('강남');
    expect(result.current.permissionDenied).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.userLocation).toEqual({ lat: 37.4980, lng: 127.0277 });
  });

  it('위치 권한 거부 시 userLocation이 null이다', async () => {
    mockDenied();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.userLocation).toBeNull();
  });

  it('500m 초과 거리에서도 가장 가까운 역을 반환한다', async () => {
    mockGranted();
    mockLocation(37.5200, 127.0000);

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.result).not.toBeNull();
    expect(result.current.result?.distanceKm).toBeGreaterThan(0.5);
  });

  it('위치 획득 실패 시 error가 설정된다', async () => {
    mockGranted();
    (Location.getCurrentPositionAsync as jest.Mock).mockRejectedValue(
      new Error('GPS 오류')
    );

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('위치를 가져오는 데 실패했습니다.');
  });

  it('refresh 호출 시 위치를 다시 가져온다', async () => {
    mockGranted();
    mockLocation(37.4980, 127.0277);

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refresh();
    });

    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(2);
  });

  it('30초 인터벌 후 자동으로 위치를 갱신한다', async () => {
    mockGranted();
    mockLocation(37.4980, 127.0277);

    renderHook(() => useNearestStation());

    await waitFor(() =>
      expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1)
    );

    act(() => {
      jest.advanceTimersByTime(30_000);
    });

    await waitFor(() =>
      expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(2)
    );
  });

  it('언마운트 시 interval이 정리된다', async () => {
    mockGranted();
    mockLocation(37.4980, 127.0277);

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const { result, unmount } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('백그라운드 전환 시 폴링을 중지한다', async () => {
    mockGranted();
    mockLocation(37.4980, 127.0277);

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1));

    act(() => { appStateCallback?.('background'); });
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('포그라운드 복귀 시 폴링을 재개한다', async () => {
    mockGranted();
    mockLocation(37.4980, 127.0277);

    renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1));

    act(() => { appStateCallback?.('background'); });
    act(() => { appStateCallback?.('active'); });
    await waitFor(() => expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(2));
  });

  it('언마운트 시 AppState 리스너를 해제한다', async () => {
    mockGranted();
    mockLocation(37.4980, 127.0277);

    const { result, unmount } = renderHook(() => useNearestStation());
    await waitFor(() => expect(result.current.loading).toBe(false));

    unmount();
    expect(mockRemove).toHaveBeenCalled();
  });

  it('캐시된 위치가 있으면 즉시 loading이 false가 된다', async () => {
    mockGranted();
    mockLastKnownLocation(37.4980, 127.0277);
    mockLocation(37.4980, 127.0277);

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(Location.getLastKnownPositionAsync).toHaveBeenCalled();
    expect(result.current.result).not.toBeNull();
    expect(result.current.result?.station.name).toBe('강남');
  });

  it('첫 호출은 Balanced accuracy, 이후 호출은 High accuracy를 사용한다', async () => {
    mockGranted();
    mockNoLastKnownLocation();
    mockLocation(37.4980, 127.0277);

    renderHook(() => useNearestStation());

    await waitFor(() =>
      expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1)
    );

    expect(Location.getCurrentPositionAsync).toHaveBeenCalledWith({
      accuracy: Location.Accuracy.Balanced,
    });

    act(() => {
      jest.advanceTimersByTime(30_000);
    });

    await waitFor(() =>
      expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(2)
    );

    expect(Location.getCurrentPositionAsync).toHaveBeenLastCalledWith({
      accuracy: Location.Accuracy.High,
    });
  });

  it('캐시된 위치가 없으면 getCurrentPositionAsync 결과를 기다린다', async () => {
    mockGranted();
    mockNoLastKnownLocation();
    mockLocation(37.4980, 127.0277);

    const { result } = renderHook(() => useNearestStation());

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(Location.getLastKnownPositionAsync).toHaveBeenCalled();
    expect(result.current.result?.station.name).toBe('강남');
  });

});

