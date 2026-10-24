/**
 * #2660 — FG watch 구독 고아(orphan) 회귀 가드.
 *
 * 배경: `startWatch`는 `await Location.watchPositionAsync(...)` 앞뒤로 비동기 창을 갖는데, 그
 * 사이에 다른 `startWatch`(프로파일 flip / AppState active → refresh / effect 재실행)나
 * `stopWatch`(BG 전환 / unmount)가 끼어들 수 있다. 기존 코드는 결과 구독을 무조건
 * `subscriptionRef.current`에 덮어썼기 때문에 먼저 시작된 구독의 핸들이 유실돼 **remove되지 않는
 * 고아 watcher**가 남았다. 고아는 앱 수명 내내 콜백을 쏘고 재시작마다 누적되어 fix 콜백 빈도가
 * 배수로 뛴다(#2594 실측: 이동 중 16.65/s, 최소 간격 11ms).
 *
 * 검증:
 *   1. startWatch가 겹쳐도 살아남는 구독은 1개 — 나머지는 remove된다.
 *   2. await 중 unmount(stopWatch)되면 뒤늦게 resolve된 구독도 remove된다(BG GPS 잔류 차단).
 *   3. 추월당한 stale 호출의 실패가 현재 세대의 error/loading을 오염시키지 않는다.
 *   4. userLocation은 매 fix마다 새 참조로 갱신된다 — 참조 고정(동일값 bail-out)을 시도했다가
 *      `usePositionStability`의 시간창 샘플링을 굶기는 것이 확인돼 되돌린 결정을 고정한다.
 */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNearestStation } from '../useNearestStation';

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

type WatchLocation = {
  coords: { latitude: number; longitude: number; speed?: number | null; accuracy?: number | null };
  timestamp?: number;
};

/** 생성된 구독들 — 각각 remove 스파이를 따로 갖는다(어느 것이 고아로 남는지 식별). */
let subscriptions: { remove: jest.Mock }[] = [];
let watchCallbacks: Array<(location: WatchLocation) => void> = [];
/** watchPositionAsync resolve를 테스트가 직접 제어하기 위한 deferred 큐. */
let pendingResolvers: Array<() => void> = [];

function simulateGps(index: number, lat: number, lng: number, accuracy = 10) {
  act(() => {
    watchCallbacks[index]?.({
      coords: { latitude: lat, longitude: lng, accuracy },
      timestamp: Date.now(),
    });
  });
}

describe('useNearestStation — watch 구독 세대 가드 (#2660)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    subscriptions = [];
    watchCallbacks = [];
    pendingResolvers = [];
    (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'granted',
    });
    (Location.getLastKnownPositionAsync as jest.Mock).mockResolvedValue(null);
    (Location.getCurrentPositionAsync as jest.Mock).mockResolvedValue({
      coords: { latitude: 37.498, longitude: 127.0277, accuracy: 10, speed: 0 },
      timestamp: Date.now(),
    });
    (Location.watchPositionAsync as jest.Mock).mockImplementation(
      (_options: unknown, callback: (location: WatchLocation) => void) => {
        watchCallbacks.push(callback);
        const subscription = { remove: jest.fn() };
        subscriptions.push(subscription);
        return new Promise((resolve) => {
          pendingResolvers.push(() => resolve(subscription));
        });
      },
    );
  });

  it('startWatch가 겹쳐 resolve돼도 고아 구독이 남지 않는다 (살아남는 건 1개)', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(pendingResolvers).toHaveLength(1));

    // 마운트 구독이 아직 resolve되지 않은 상태에서 두 번째 startWatch(수동 refresh)가 시작된다.
    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(pendingResolvers).toHaveLength(2));

    // 순서를 뒤집어 resolve — 먼저 시작된 쪽이 나중에 resolve되는 최악 케이스.
    await act(async () => {
      pendingResolvers[1]();
      pendingResolvers[0]();
      await Promise.resolve();
    });

    const removed = subscriptions.filter((s) => s.remove.mock.calls.length > 0);
    expect(removed).toHaveLength(subscriptions.length - 1);
  });

  it('await 중 unmount되면 뒤늦게 resolve된 구독도 remove된다 (BG GPS 잔류 차단)', async () => {
    const { unmount } = renderHook(() => useNearestStation());
    await waitFor(() => expect(pendingResolvers).toHaveLength(1));

    unmount();
    await act(async () => {
      pendingResolvers[0]();
      await Promise.resolve();
    });

    expect(subscriptions[0].remove).toHaveBeenCalled();
  });

  it('추월당한 stale 호출이 실패해도 현재 세대의 error/loading을 덮어쓰지 않는다 (리뷰 P2)', async () => {
    let rejectFirst: (() => void) | null = null;
    (Location.watchPositionAsync as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = () => reject(new Error('watch failed'));
        }),
    );
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(rejectFirst).not.toBeNull());

    // 첫 호출이 아직 매달려 있는 동안 두 번째 startWatch가 시작돼 세대를 올린다.
    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(pendingResolvers).toHaveLength(1));
    await act(async () => {
      pendingResolvers[0]();
      await Promise.resolve();
    });

    await act(async () => {
      rejectFirst?.();
      await Promise.resolve();
    });

    expect(result.current.error).toBeNull();
  });

  // #2667 — 포커스되지 않은 탭(예: MapScreen)이 앱 수명 내내 두 번째 watch를 돌리지 않도록.
  describe('enabled 게이트 (#2667)', () => {
    // jest 환경의 AppState.currentState는 'unknown'일 수 있어 재시작 경로가 active 가드에
    // 걸린다 — 기존 watch 프로파일 테스트와 동일하게 'active'로 고정한다.
    const originalCurrentState = AppState.currentState;
    beforeEach(() => {
      (AppState as { currentState: string }).currentState = 'active';
    });
    afterEach(() => {
      (AppState as { currentState: string }).currentState = originalCurrentState;
    });

    it('enabled=false로 마운트하면 watch 자체를 시작하지 않는다', async () => {
      renderHook(() => useNearestStation({ enabled: false }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(Location.watchPositionAsync).not.toHaveBeenCalled();
    });

    it('true→false 전이에서 구독을 끊고, false→true에서 다시 시작한다', async () => {
      const { rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) => useNearestStation({ enabled }),
        { initialProps: { enabled: true } },
      );
      await waitFor(() => expect(pendingResolvers).toHaveLength(1));
      await act(async () => {
        pendingResolvers[0]();
        await Promise.resolve();
      });

      rerender({ enabled: false });
      expect(subscriptions[0].remove).toHaveBeenCalled();

      rerender({ enabled: true });
      await waitFor(() => expect(pendingResolvers).toHaveLength(2));
    });

    it('백그라운드 중 false→true 전이는 FG watch를 켜지 않는다 (active 가드, 기존 규약과 동일)', async () => {
      const { rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) => useNearestStation({ enabled }),
        { initialProps: { enabled: true } },
      );
      await waitFor(() => expect(pendingResolvers).toHaveLength(1));

      rerender({ enabled: false });
      (AppState as { currentState: string }).currentState = 'background';
      rerender({ enabled: true });
      await act(async () => {
        await Promise.resolve();
      });

      expect(pendingResolvers).toHaveLength(1);
    });
  });

  it('userLocation은 매 fix마다 갱신된다 — 시간창 소비자(usePositionStability)의 샘플을 굶기지 않는다', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(pendingResolvers).toHaveLength(1));
    await act(async () => {
      pendingResolvers[0]();
      await Promise.resolve();
    });

    simulateGps(0, 37.498, 127.0277);
    const first = result.current.userLocation;
    expect(first).not.toBeNull();

    // 완전히 동일한 좌표라도 새 참조여야 한다. 참조를 고정하면 `usePositionStability`의
    // `useEffect([userLocation])`가 재실행되지 않아 정지 사용자에게 샘플이 끊긴다(리뷰 P1).
    simulateGps(0, 37.498, 127.0277);
    expect(result.current.userLocation).not.toBe(first);
    expect(result.current.userLocation).toEqual(first);
  });
});
