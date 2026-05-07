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

describe('useNearestStation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    appStateCallback = null;
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

  it('환승역 감지 시 isTransfer가 true이고 variants가 반환된다', async () => {
    mockGranted();
    // 교대역 좌표 (2호선/3호선 환승역)
    mockLocation(37.493961, 127.014667);

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.result?.station.name).toBe('교대');
    expect(result.current.variants.length).toBeGreaterThan(1);
    expect(result.current.variants.every((v) => v.name === '교대')).toBe(true);
  });

  it('일반역 감지 시 variants가 1개이다', async () => {
    mockGranted();
    // 소요산역 좌표 (1호선 단독역)
    mockLocation(37.9481, 127.061034);

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.result?.station.name).toBe('소요산');
    expect(result.current.variants).toHaveLength(1);
  });

  it('권한 거부 시 variants가 빈 배열이다', async () => {
    mockDenied();

    const { result } = renderHook(() => useNearestStation());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.variants).toEqual([]);
  });

});

