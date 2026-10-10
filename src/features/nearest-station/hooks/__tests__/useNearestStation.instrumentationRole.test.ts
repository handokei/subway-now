/**
 * #2594 (PR #2639 리뷰 P1) — GPS fix 계측(recordGpsFixArrival) 인스턴스 태깅 회귀 가드.
 *
 * 배경: DebugModal이 표시용으로 자체 useFusedNearestStation(→useNearestStation) 인스턴스를
 * 추가 마운트한다(HomeScreen의 'primary' 인스턴스와 별개). reevalInstrumentation이
 * module-level singleton이라 태깅 없이는 두 인스턴스의 watch 콜백이 모두 recordGpsFixArrival을
 * 호출해 계측값이 실제의 약 2배로 관측되는 회귀가 있었다(리뷰에서 발견).
 *
 * 검증:
 *   1. instrumentationRole 미전달(default) → recordGpsFixArrival 호출 (기존 동작, 'primary').
 *   2. instrumentationRole='primary' 명시 → 호출.
 *   3. instrumentationRole='observer' → 호출 skip (표시 게이트 통과 fix든 drop fix든 무관).
 *   4. 두 인스턴스를 동시에 마운트해도('primary' + 'observer') recordGpsFixArrival 호출
 *      횟수가 'primary' 인스턴스 발화 횟수와 정확히 같음(이중 카운트 없음) — 리뷰가 요구한
 *      "이중 마운트 상태에서 수치가 분리되는지" 테스트로 고정.
 */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNearestStation } from '../useNearestStation';
import { recordGpsFixArrival } from '../../utils/reevalInstrumentation';

jest.mock('expo-location');
jest.mock('../../utils/reevalInstrumentation', () => ({
  recordGpsFixArrival: jest.fn(),
}));

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

describe('useNearestStation — 계측 인스턴스 태깅 (#2594 PR #2639 리뷰 P1)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    watchCallbacks.length = 0;
    (Location.getLastKnownPositionAsync as jest.Mock).mockResolvedValue(null);
    mockGranted();
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      async (_options: unknown, callback: typeof watchCallbacks[number]) => {
        watchCallbacks.push(callback);
        return mockSubscription;
      },
    );
  });

  it('instrumentationRole 미전달(default) — GPS fix 콜백마다 recordGpsFixArrival 호출', async () => {
    renderHook(() => useNearestStation());
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(0, 37.498, 127.0277);

    expect(recordGpsFixArrival).toHaveBeenCalledTimes(1);
  });

  it("instrumentationRole='primary' 명시 — recordGpsFixArrival 호출", async () => {
    renderHook(() => useNearestStation({ instrumentationRole: 'primary' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(0, 37.498, 127.0277);
    simulateGps(0, 37.499, 127.0278);

    expect(recordGpsFixArrival).toHaveBeenCalledTimes(2);
  });

  it("instrumentationRole='observer' — recordGpsFixArrival 호출 skip (게이트 통과 fix)", async () => {
    renderHook(() => useNearestStation({ instrumentationRole: 'observer' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    simulateGps(0, 37.498, 127.0277);

    expect(recordGpsFixArrival).not.toHaveBeenCalled();
  });

  it("instrumentationRole='observer' — 표시 게이트에서 drop되는 fix(저정확도)도 skip", async () => {
    renderHook(() => useNearestStation({ instrumentationRole: 'observer' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalled());

    // MAX_ACCURACY_M_DISPLAY(250m)를 초과하는 accuracy — 표시 게이트에서 drop되는 경로.
    simulateGps(0, 37.498, 127.0277, { accuracy: 9999 });

    expect(recordGpsFixArrival).not.toHaveBeenCalled();
  });

  it("동시 마운트('primary' + 'observer') — recordGpsFixArrival 호출 횟수가 'primary' 발화 수와 정확히 일치 (이중 카운트 없음)", async () => {
    // #2594 P1 핵심 회귀 재현 시나리오: DebugModal('observer')이 HomeScreen('primary')과
    // 동시에 useNearestStation을 마운트한 상태를 시뮬레이션.
    renderHook(() => useNearestStation({ instrumentationRole: 'primary' }));
    renderHook(() => useNearestStation({ instrumentationRole: 'observer' }));
    await waitFor(() => expect(Location.watchPositionAsync).toHaveBeenCalledTimes(2));
    expect(watchCallbacks).toHaveLength(2);

    // 두 인스턴스가 각각 자기 GPS fix를 수신(실제로는 동일 CoreLocation 소스를 공유하지만
    // React 레벨에서는 독립 watch 구독이므로 콜백도 독립적으로 트리거된다).
    simulateGps(0, 37.498, 127.0277); // primary 인스턴스
    simulateGps(1, 37.499, 127.0278); // observer 인스턴스

    // 두 인스턴스 모두 fix를 받았지만(watch 콜백 2회 트리거), record는 primary 몫 1건만.
    expect(recordGpsFixArrival).toHaveBeenCalledTimes(1);
  });
});
