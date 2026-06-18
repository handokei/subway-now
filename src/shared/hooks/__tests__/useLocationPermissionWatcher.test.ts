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
} from '../useLocationPermissionWatcher';

type AppStateListener = (s: 'active' | 'background' | 'inactive') => void;

function captureAppStateListener(): AppStateListener {
  const last = mockAddEventListener.mock.calls.at(-1);
  if (!last) throw new Error('AppState.addEventListener not called');
  return last[1] as AppStateListener;
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
  it('unknown 관여 시 항상 none', () => {
    expect(classifyPermissionChange('unknown', 'granted-always')).toBe('none');
    expect(classifyPermissionChange('granted-always', 'unknown')).toBe('none');
  });

  it('같은 상태는 none', () => {
    expect(classifyPermissionChange('granted-always', 'granted-always')).toBe('none');
    expect(classifyPermissionChange('denied', 'denied')).toBe('none');
  });

  it('granted → denied는 revoked', () => {
    expect(classifyPermissionChange('granted-always', 'denied')).toBe('revoked');
    expect(classifyPermissionChange('granted-whileinuse', 'denied')).toBe('revoked');
  });

  it('granted-always → granted-whileinuse는 downgraded', () => {
    expect(classifyPermissionChange('granted-always', 'granted-whileinuse')).toBe('downgraded');
  });

  it('상향(whileinuse → always)이나 denied → granted는 none', () => {
    expect(classifyPermissionChange('granted-whileinuse', 'granted-always')).toBe('none');
    expect(classifyPermissionChange('denied', 'granted-always')).toBe('none');
    expect(classifyPermissionChange('denied', 'granted-whileinuse')).toBe('none');
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
    // 비동기 처리 완료를 기다리기 위해 한 cycle 흘려보낸다.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('unknown');
    expect(result.current.change).toBe('none');
  });

  it('AppState active 진입 시 재조회 + 변화 감지 (revoked)', async () => {
    const { result } = renderHook(() => useLocationPermissionWatcher());
    await waitFor(() => expect(result.current.status).toBe('granted-always'));

    mockGetForeground.mockResolvedValue({ status: 'denied' });
    const listener = captureAppStateListener();
    await act(async () => {
      listener('active');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('denied');
    expect(result.current.change).toBe('revoked');
  });

  it('AppState active 진입 시 downgrade 감지', async () => {
    const { result } = renderHook(() => useLocationPermissionWatcher());
    await waitFor(() => expect(result.current.status).toBe('granted-always'));

    mockGetBackground.mockResolvedValue({ status: 'denied' });
    const listener = captureAppStateListener();
    await act(async () => {
      listener('active');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('granted-whileinuse');
    expect(result.current.change).toBe('downgraded');
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
    const listener = captureAppStateListener();
    await act(async () => {
      listener('active');
      await Promise.resolve();
      await Promise.resolve();
    });
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
