/**
 * #3191 PR-0 (측정 정화) — observer(DebugModal) 인스턴스의 useNearestStation은 gps-drop / gps-fix
 * 측정 버퍼(gpsDropBuffer · fusionDebugBuffer)에 기록하지 않는다. primary는 그대로 기록한다.
 * 기록점: pushGpsDropEntry 3곳(gps-quality-drop / rate-limited summary / low-accuracy-display),
 * pushFusionDebugEntry 1곳(gps-fix).
 */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNearestStation } from '../useNearestStation';
import { getGpsDropEntries, clearGpsDropEntries } from '../../utils/gpsDropBuffer';
import { getFusionDebugEntries, clearFusionDebugEntries } from '../../utils/fusionDebugBuffer';

jest.mock('expo-location');

jest.mock('../../../../shared/constants/e2e', () => ({
  get IS_E2E_MOCK() {
    return false;
  },
  E2E_MOCK_LOCATION: {
    latitude: 37.49799,
    longitude: 127.027912,
    accuracyMeters: 10,
    speedMps: 0,
  },
}));

jest.spyOn(AppState, 'addEventListener').mockImplementation(
  () => ({ remove: jest.fn() }) as unknown as ReturnType<typeof AppState.addEventListener>,
);

const mockSubscription = { remove: jest.fn() };
type WatchLocation = {
  coords: { latitude: number; longitude: number; speed?: number | null; accuracy?: number | null };
  timestamp?: number;
};
// 인스턴스별 watch 콜백을 분리 보관 — 두 hook을 동시에 마운트하는 테스트(4번)에서
// 각각의 watch 콜백을 독립적으로 트리거해야 한다.
const watchCallbacks: Array<(location: WatchLocation) => void> = [];

const mockGranted = () => {
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({
    status: 'granted',
  });
};

function simulateGps(
  index: number,
  lat: number,
  lng: number,
  opts: { accuracy?: number | null; timestamp?: number } = {},
) {
  act(() => {
    watchCallbacks[index]?.({
      coords: { latitude: lat, longitude: lng, accuracy: opts.accuracy ?? null },
      timestamp: opts.timestamp ?? Date.now(),
    });
  });
}

describe('useNearestStation — observer 측정 격리 (#3191 PR-0)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    watchCallbacks.length = 0;
    clearGpsDropEntries();
    clearFusionDebugEntries();
    (Location.getLastKnownPositionAsync as jest.Mock).mockResolvedValue(null);
    mockGranted();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallbacks[number]) => {
        watchCallbacks.push(callback);
        return mockSubscription;
      },
    );
  });

  const dropReasons = () => getGpsDropEntries().map((e) => e.dropReason);
  const gpsFixLogs = () => getFusionDebugEntries().filter((e) => e.kind === 'gps');

  it('primary — 표시 게이트 drop fix(accuracy 9999)가 low-accuracy-display로 기록된다 (유효성)', async () => {
    renderHook(() => useNearestStation({ instrumentationRole: 'primary' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    simulateGps(0, 37.498, 127.0277, { accuracy: 9999 });
    expect(dropReasons()).toContain('low-accuracy-display');
  });

  it('observer — low-accuracy-display gps-drop push 0', async () => {
    renderHook(() => useNearestStation({ instrumentationRole: 'observer' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    simulateGps(0, 37.498, 127.0277, { accuracy: 9999 });
    expect(getGpsDropEntries()).toHaveLength(0);
  });

  it('primary — 같은 초 다발 drop 시 rate-limited summary가 기록된다 (유효성)', async () => {
    renderHook(() => useNearestStation({ instrumentationRole: 'primary' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    for (let i = 0; i < 12; i += 1) {
      simulateGps(0, 37.498 + i * 0.001, 127.0277, { accuracy: 9999 });
    }
    expect(dropReasons().some((r) => r.startsWith('rate-limited:'))).toBe(false);
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 5_000);
    simulateGps(0, 37.6, 127.0277, { accuracy: 9999 });
    jest.useRealTimers();
    expect(dropReasons().some((r) => r.startsWith('rate-limited:'))).toBe(true);
  });

  it('observer — 다발 drop(rate-limit 경로)에서도 push 0', async () => {
    renderHook(() => useNearestStation({ instrumentationRole: 'observer' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    for (let i = 0; i < 12; i += 1) {
      simulateGps(0, 37.498 + i * 0.001, 127.0277, { accuracy: 9999 });
    }
    jest.useFakeTimers();
    jest.setSystemTime(Date.now() + 5_000);
    simulateGps(0, 37.6, 127.0277, { accuracy: 9999 });
    jest.useRealTimers();
    expect(getGpsDropEntries()).toHaveLength(0);
  });

  it('primary — 품질 게이트 미달 fix(accuracy 150)가 gps-quality-drop으로 기록된다 (유효성)', async () => {
    renderHook(() => useNearestStation({ instrumentationRole: 'primary' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    simulateGps(0, 37.498, 127.0277, { accuracy: 150 });
    expect(dropReasons().some((r) => r.startsWith('gps-quality-drop:'))).toBe(true);
  });

  it('observer — gps-quality-drop push 0', async () => {
    renderHook(() => useNearestStation({ instrumentationRole: 'observer' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    simulateGps(0, 37.498, 127.0277, { accuracy: 150 });
    expect(getGpsDropEntries()).toHaveLength(0);
  });

  it('primary — 역 변화 fix가 Fusion log gps-fix로 기록된다 (유효성)', async () => {
    renderHook(() => useNearestStation({ instrumentationRole: 'primary' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    simulateGps(0, 37.498, 127.0277, { accuracy: 10 });
    expect(gpsFixLogs().length).toBeGreaterThan(0);
  });

  it('observer — Fusion log gps-fix push 0', async () => {
    renderHook(() => useNearestStation({ instrumentationRole: 'observer' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());
    simulateGps(0, 37.498, 127.0277, { accuracy: 10 });
    expect(gpsFixLogs()).toHaveLength(0);
  });
});
