/**
 * #2832 — useTripDeathForegroundBackstop 회귀 가드.
 *
 * Root: FG station-passed 발사 경로에 trip-ended lifecycle 게이트가 없고, 기존 pull-death
 * backstop(`checkTripDeathByPull`)은 BG(silent-push / bg-location-tick)에만 배선돼 있어
 * backend에서 'user-delete'로 트립이 삭제돼도 FG는 이를 감지하지 못해 destination이 안 지워지고
 * zombie station-passed 알림이 계속 발사된다.
 *
 * 시나리오:
 *   1. AppState active + 활성 트립(ACTIVE_TRIP_KEY 존재) → FG tick마다
 *      checkTripDeathByPull(getBackendUrl(), 'fg-tick') 호출.
 *   2. ACTIVE_TRIP_KEY 없음 → checkTripDeathByPull 미호출.
 *   3. AppState background → checkTripDeathByPull 미호출.
 *   4. getBackendUrl() null(미설정) → checkTripDeathByPull 미호출.
 */

import { renderHook, act } from '@testing-library/react-native';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';

const mockCheckTripDeathByPull = jest.fn();
const mockGetBackendUrl = jest.fn();
jest.mock('../../utils/tripDeathPullBackstop', () => ({
  checkTripDeathByPull: (...args: unknown[]) => mockCheckTripDeathByPull(...args),
  getBackendUrl: () => mockGetBackendUrl(),
}));

import {
  useTripDeathForegroundBackstop,
  TRIP_DEATH_FG_BACKSTOP_POLL_INTERVAL_MS,
} from '../useTripDeathForegroundBackstop';

describe('useTripDeathForegroundBackstop', () => {
  let removeListenerMock: jest.Mock;
  let appStateCallback: ((state: string) => void) | null;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    removeListenerMock = jest.fn();
    appStateCallback = null;
    mockGetBackendUrl.mockReturnValue('https://backend.example.com');
    mockCheckTripDeathByPull.mockResolvedValue('alive');
    await AsyncStorage.clear();

    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, cb) => {
      appStateCallback = cb as (state: string) => void;
      return { remove: removeListenerMock };
    });
    // AppState.currentState는 기본적으로 'active'로 취급 (테스트 별도 override).
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('시나리오 1: AppState active + 활성 트립 → checkTripDeathByPull(baseUrl, "fg-tick") 호출', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-token-1');

    renderHook(() => useTripDeathForegroundBackstop());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockCheckTripDeathByPull).toHaveBeenCalledWith(
      'https://backend.example.com',
      'fg-tick',
    );
  });

  it('시나리오 2: ACTIVE_TRIP_KEY 없음 → checkTripDeathByPull 미호출', async () => {
    renderHook(() => useTripDeathForegroundBackstop());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockCheckTripDeathByPull).not.toHaveBeenCalled();
  });

  it('시나리오 3: AppState background → checkTripDeathByPull 미호출', async () => {
    Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-token-1');

    renderHook(() => useTripDeathForegroundBackstop());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockCheckTripDeathByPull).not.toHaveBeenCalled();
  });

  it('시나리오 4: getBackendUrl() null → checkTripDeathByPull 미호출', async () => {
    mockGetBackendUrl.mockReturnValue(null);
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-token-1');

    renderHook(() => useTripDeathForegroundBackstop());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockCheckTripDeathByPull).not.toHaveBeenCalled();
  });

  it('backend "active" 응답 → cleanup 동작 없음 (checkTripDeathByPull 내부가 담당, wiring만 검증)', async () => {
    mockCheckTripDeathByPull.mockResolvedValue('alive');
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-token-1');

    renderHook(() => useTripDeathForegroundBackstop());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockCheckTripDeathByPull).toHaveBeenCalledTimes(1);
  });

  it('AppState background→active 전환 시 재호출', async () => {
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-token-1');

    renderHook(() => useTripDeathForegroundBackstop());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockCheckTripDeathByPull).toHaveBeenCalledTimes(1);

    act(() => {
      appStateCallback?.('active');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockCheckTripDeathByPull).toHaveBeenCalledTimes(2);
  });

  it('AppState background 전환 이벤트는 재호출 유발하지 않음', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-token-1');

    renderHook(() => useTripDeathForegroundBackstop());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockCheckTripDeathByPull).toHaveBeenCalledTimes(1);

    act(() => {
      appStateCallback?.('background');
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockCheckTripDeathByPull).toHaveBeenCalledTimes(1);
  });

  it('checkTripDeathByPull throw해도 graceful (unmount 없이 정상 진행)', async () => {
    mockCheckTripDeathByPull.mockRejectedValue(new Error('network fail'));
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-token-1');

    const { unmount } = renderHook(() => useTripDeathForegroundBackstop());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockCheckTripDeathByPull).toHaveBeenCalled();
    unmount();
  });

  it('FG 30s interval tick마다 재호출', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-token-1');

    renderHook(() => useTripDeathForegroundBackstop());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockCheckTripDeathByPull).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(TRIP_DEATH_FG_BACKSTOP_POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(mockCheckTripDeathByPull).toHaveBeenCalledTimes(2);
  });

  it('unmount 시 interval/listener cleanup', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-token-1');

    const { unmount } = renderHook(() => useTripDeathForegroundBackstop());
    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    expect(removeListenerMock).toHaveBeenCalled();
  });
});
