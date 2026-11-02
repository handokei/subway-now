/**
 * #3036 PR-3a — 마지막 채택 fix의 출처(live / last-known). 등록 스냅샷(promptGeoContext.originFixSource)의
 * 입력이다. cold-start getLastKnownPositionAsync로 hydrate된 좌표는 OS 캐시라 "지금 위치"가 아닐 수 있어
 * backend가 도보시간 계산에서 제외할 수 있도록 출처를 분리한다.
 */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { useNearestStation } from '../useNearestStation';

jest.mock('expo-location');

type WatchLocation = {
  coords: { latitude: number; longitude: number; speed?: number | null; accuracy?: number | null };
  timestamp: number;
};
let watchCallback: ((location: WatchLocation) => void) | null = null;

const YONGMASAN = { lat: 37.5741, lng: 127.0942 };

function setup(lastKnown: { ageMs: number; accuracy: number } | null) {
  jest.clearAllMocks();
  watchCallback = null;
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Location.getCurrentPositionAsync as jest.Mock).mockImplementation(() => new Promise(() => {}));
  (Location.getLastKnownPositionAsync as jest.Mock).mockResolvedValue(
    lastKnown
      ? {
          coords: { latitude: YONGMASAN.lat, longitude: YONGMASAN.lng, accuracy: lastKnown.accuracy },
          timestamp: Date.now() - lastKnown.ageMs,
        }
      : null,
  );
  (Location.watchPositionAsync as jest.Mock).mockImplementation(async (_o: unknown, cb: typeof watchCallback) => {
    watchCallback = cb;
    return { remove: jest.fn() };
  });
}

function liveFix(timestamp: number) {
  act(() => {
    watchCallback?.({
      coords: { latitude: YONGMASAN.lat, longitude: YONGMASAN.lng, speed: null, accuracy: 10 },
      timestamp,
    });
  });
}

describe('useNearestStation — lastFixSource (#3036 PR-3a)', () => {
  it('fix가 한 번도 없으면 null', async () => {
    setup(null);
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    expect(result.current.lastFixSource).toBeNull();
  });

  it('cold-start last-known으로 hydrate된 fix -> gps-last-known', async () => {
    setup({ ageMs: 20_000, accuracy: 30 });
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(result.current.lastFixAtMs).not.toBeNull());
    expect(result.current.lastFixSource).toBe('gps-last-known');
  });

  it('이후 FG watch live fix가 채택되면 gps-live로 돌아온다', async () => {
    setup({ ageMs: 20_000, accuracy: 30 });
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(result.current.lastFixSource).toBe('gps-last-known'));
    await waitFor(() => expect(watchCallback).not.toBeNull());
    liveFix(Date.now() + 1_000);
    expect(result.current.lastFixSource).toBe('gps-live');
  });

  it('live fix만 있으면 gps-live', async () => {
    setup(null);
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(watchCallback).not.toBeNull());
    liveFix(Date.now());
    expect(result.current.lastFixSource).toBe('gps-live');
  });
});
