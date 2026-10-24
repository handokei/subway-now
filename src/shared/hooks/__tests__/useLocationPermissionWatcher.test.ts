import { renderHook, act, waitFor } from '@testing-library/react-native';

const mockGetForeground = jest.fn();
const mockGetBackground = jest.fn();

jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: (...args: unknown[]) => mockGetForeground(...args),
  getBackgroundPermissionsAsync: (...args: unknown[]) => mockGetBackground(...args),
}));

const mockAddEventListener = jest.fn();
const mockRemove = jest.fn();

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (...args: unknown[]) => mockAddEventListener(...args),
  },
}));

import {
  classifyPermissionChange,
  useLocationPermissionWatcher,
  type LocationPermissionChange,
} from '../useLocationPermissionWatcher';

type AppStateListener = (s: 'active' | 'background' | 'inactive') => void;

function captureAppStateListener(): AppStateListener {
  const last = mockAddEventListener.mock.calls.at(-1);
  if (!last) throw new Error('AppState.addEventListener not called');
  return last[1] as AppStateListener;
}

/**
 * SonarCloud duplication 회피용 helper.
 * setState 큐를 안정화하기 위해 두 cycle을 흘려보낸다.
 * 여러 테스트에서 동일하게 반복되던 act+Promise 블록을 한 곳으로 모은다.
 */
async function flushTwoCycles() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** AppState 'active' 진입을 트리거하고 setState 큐를 비운다. */
async function triggerAppStateActive() {
  const listener = captureAppStateListener();
  await act(async () => {
    listener('active');
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockGetForeground.mockReset();
  mockGetBackground.mockReset();
  mockAddEventListener.mockReset();
  mockRemove.mockReset();
  mockAddEventListener.mockReturnValue({ remove: mockRemove });
  mockGetForeground.mockResolvedValue({ status: 'granted' });
  mockGetBackground.mockResolvedValue({ status: 'granted' });
});

describe('classifyPermissionChange', () => {
  it.each<[string, Parameters<typeof classifyPermissionChange>[0], Parameters<typeof classifyPermissionChange>[1], LocationPermissionChange]>([
    ['unknown(prev) 관여', 'unknown', 'granted-always', 'none'],
    ['unknown(next) 관여', 'granted-always', 'unknown', 'none'],
    ['같은 always', 'granted-always', 'granted-always', 'none'],
    ['같은 denied', 'denied', 'denied', 'none'],
    ['always → denied', 'granted-always', 'denied', 'revoked'],
    ['whileinuse → denied', 'granted-whileinuse', 'denied', 'revoked'],
    ['always → whileinuse (downgrade)', 'granted-always', 'granted-whileinuse', 'downgraded'],
    ['상향 whileinuse → always', 'granted-whileinuse', 'granted-always', 'none'],
    ['denied → always 상향', 'denied', 'granted-always', 'none'],
    ['denied → whileinuse 상향', 'denied', 'granted-whileinuse', 'none'],
  ])('%s', (_, prev, next, expected) => {
    expect(classifyPermissionChange(prev, next)).toBe(expected);
  });
});

describe('useLocationPermissionWatcher', () => {
  it('마운트 시 권한을 조회하고 status를 반영한다 (granted-always)', async () => {
    const { result } = renderHook(() => useLocationPermissionWatcher());
    expect(result.current.status).toBe('unknown');
    await waitFor(() => expect(result.current.status).toBe('granted-always'));
    expect(result.current.change).toBe('none');
  });

  it('FG denied면 status=denied', async () => {
    mockGetForeground.mockResolvedValue({ status: 'denied' });
    const { result } = renderHook(() => useLocationPermissionWatcher());
    await waitFor(() => expect(result.current.status).toBe('denied'));
    // BG는 조회하지 않는다 (FG denied 시점에 short-circuit).
    expect(mockGetBackground).not.toHaveBeenCalled();
  });

  it('FG granted + BG denied면 status=granted-whileinuse', async () => {
    mockGetBackground.mockResolvedValue({ status: 'denied' });
    const { result } = renderHook(() => useLocationPermissionWatcher());
    await waitFor(() => expect(result.current.status).toBe('granted-whileinuse'));
  });

  it('FG 조회 예외 시 status=unknown 유지', async () => {
    mockGetForeground.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useLocationPermissionWatcher());
    await flushTwoCycles();
    expect(result.current.status).toBe('unknown');
    expect(result.current.change).toBe('none');
  });

  it.each<[LocationPermissionChange, 'denied' | 'granted', LocationPermissionChange]>([
    ['revoked', 'denied', 'revoked'],
    ['downgraded', 'granted', 'downgraded'],
  ])('AppState active 진입 시 %s 감지', async (label, nextFgOrBg, expected) => {
    const { result } = renderHook(() => useLocationPermissionWatcher());
    await waitFor(() => expect(result.current.status).toBe('granted-always'));

    // revoked: FG를 denied로 / downgraded: BG를 denied로 (FG는 granted 유지)
    if (label === 'revoked') {
      mockGetForeground.mockResolvedValue({ status: nextFgOrBg });
    } else {
      mockGetBackground.mockResolvedValue({ status: 'denied' });
    }
    await triggerAppStateActive();
    expect(result.current.change).toBe(expected);
    expect(result.current.status).toBe(label === 'revoked' ? 'denied' : 'granted-whileinuse');
  });

  it('AppState background/inactive 진입은 재조회하지 않는다', async () => {
    renderHook(() => useLocationPermissionWatcher());
    await waitFor(() => expect(mockGetForeground).toHaveBeenCalledTimes(1));

    const listener = captureAppStateListener();
    await act(async () => {
      listener('background');
      listener('inactive');
      await Promise.resolve();
    });
    expect(mockGetForeground).toHaveBeenCalledTimes(1);
  });

  it('acknowledge 호출 시 change가 none으로 리셋된다', async () => {
    const { result } = renderHook(() => useLocationPermissionWatcher());
    await waitFor(() => expect(result.current.status).toBe('granted-always'));

    mockGetForeground.mockResolvedValue({ status: 'denied' });
    await triggerAppStateActive();
    expect(result.current.change).toBe('revoked');

    act(() => result.current.acknowledge());
    expect(result.current.change).toBe('none');
  });

  it('unmount 시 구독을 해제하고 늦은 비동기 결과가 setState를 호출하지 않는다', async () => {
    let resolveFg: ((value: { status: string }) => void) | null = null;
    mockGetForeground.mockReturnValue(
      new Promise<{ status: string }>((resolve) => {
        resolveFg = resolve;
      }),
    );
    const { unmount } = renderHook(() => useLocationPermissionWatcher());
    unmount();
    expect(mockRemove).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFg?.({ status: 'granted' });
      await Promise.resolve();
      await Promise.resolve();
    });
    // setState 호출이 일어났다면 unmount 후 React 경고가 뜨지만, cancelled 가드로 차단.
    // 직접 검증은 어렵지만 unmount 후 throw가 없음을 확인.
  });
});
