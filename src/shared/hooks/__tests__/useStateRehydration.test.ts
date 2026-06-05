import { renderHook, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useStateRehydration } from '../useStateRehydration';
import { useDestinationStore } from '../../../features/route/store/useDestinationStore';
import { useBoardingLockStore } from '../../../features/alarm/store/useBoardingLockStore';

const mockGetSentinel = jest.fn();
const mockClearSentinel = jest.fn();
jest.mock('../../../features/alarm/utils/tripEndedSentinel', () => ({
  getTripEndedSentinel: (...args: unknown[]) => mockGetSentinel(...args),
  clearTripEndedSentinel: (...args: unknown[]) => mockClearSentinel(...args),
  setTripEndedSentinel: jest.fn(),
}));

// destination store cross-feature import는 storage helper 안에서 일어나므로 spy로 충분.
// useDestinationStore.getState()를 그대로 사용한다 (실제 store)

const mockSetDestination = jest.fn();
const mockLoadDestination = jest.fn();
const mockLoadCustomOrigin = jest.fn();
const mockLoadTripOrigin = jest.fn();

const mockReleaseLock = jest.fn();
const mockLoadLock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSentinel.mockResolvedValue(null);
  mockClearSentinel.mockResolvedValue(undefined);
  mockSetDestination.mockReturnValue(undefined);
  mockLoadDestination.mockResolvedValue(undefined);
  mockLoadCustomOrigin.mockResolvedValue(undefined);
  mockLoadTripOrigin.mockResolvedValue(undefined);
  mockReleaseLock.mockResolvedValue(undefined);
  mockLoadLock.mockResolvedValue(undefined);
  jest.spyOn(useDestinationStore, 'getState').mockReturnValue({
    setDestination: mockSetDestination,
    loadDestination: mockLoadDestination,
    loadCustomOrigin: mockLoadCustomOrigin,
    loadTripOrigin: mockLoadTripOrigin,
  } as unknown as ReturnType<typeof useDestinationStore.getState>);
  jest.spyOn(useBoardingLockStore, 'getState').mockReturnValue({
    releaseLock: mockReleaseLock,
    loadLock: mockLoadLock,
  } as unknown as ReturnType<typeof useBoardingLockStore.getState>);
});

function mockAppState(): {
  emit: (state: AppStateStatus) => void;
  remove: jest.Mock;
} {
  const remove = jest.fn();
  let handler: ((state: AppStateStatus) => void) | null = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, h) => {
    if (event === 'change') handler = h as typeof handler;
    return { remove } as ReturnType<typeof AppState.addEventListener>;
  });
  return {
    emit: (state) => handler?.(state),
    remove,
  };
}

describe('useStateRehydration', () => {
  it('마운트 시 destination/customOrigin/tripOrigin/lock load 모두 호출', async () => {
    mockAppState();
    renderHook(() => useStateRehydration());
    await waitFor(() => {
      expect(mockLoadDestination).toHaveBeenCalled();
      expect(mockLoadCustomOrigin).toHaveBeenCalled();
      expect(mockLoadTripOrigin).toHaveBeenCalled();
      expect(mockLoadLock).toHaveBeenCalled();
    });
  });

  it('sentinel 없음 — store reset 호출 안 함', async () => {
    mockGetSentinel.mockResolvedValue(null);
    mockAppState();
    renderHook(() => useStateRehydration());
    await waitFor(() => expect(mockLoadDestination).toHaveBeenCalled());
    expect(mockSetDestination).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
    expect(mockClearSentinel).not.toHaveBeenCalled();
  });

  it('sentinel 있음 — setDestination(null) + releaseLock + sentinel clear', async () => {
    mockGetSentinel.mockResolvedValue(1_700_000_000_000);
    mockAppState();
    renderHook(() => useStateRehydration());
    await waitFor(() => expect(mockClearSentinel).toHaveBeenCalled());
    expect(mockSetDestination).toHaveBeenCalledWith(null);
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  it("AppState 'active' 진입 시 재실행", async () => {
    const app = mockAppState();
    renderHook(() => useStateRehydration());
    await waitFor(() => expect(mockLoadDestination).toHaveBeenCalledTimes(1));

    app.emit('active');
    await waitFor(() => expect(mockLoadDestination).toHaveBeenCalledTimes(2));
  });

  it("AppState 비'active'는 무시", async () => {
    const app = mockAppState();
    renderHook(() => useStateRehydration());
    await waitFor(() => expect(mockLoadDestination).toHaveBeenCalledTimes(1));

    app.emit('background');
    app.emit('inactive');
    // 마운트 1회 외 추가 호출 없음
    expect(mockLoadDestination).toHaveBeenCalledTimes(1);
  });

  it('unmount 시 AppState listener remove', () => {
    const app = mockAppState();
    const { unmount } = renderHook(() => useStateRehydration());
    unmount();
    expect(app.remove).toHaveBeenCalled();
  });

  it('active 진입에서도 sentinel 있으면 reset 호출', async () => {
    const app = mockAppState();
    mockGetSentinel.mockResolvedValueOnce(null);
    renderHook(() => useStateRehydration());
    await waitFor(() => expect(mockLoadDestination).toHaveBeenCalled());
    expect(mockSetDestination).not.toHaveBeenCalled();

    mockGetSentinel.mockResolvedValueOnce(1_700_000_000_001);
    app.emit('active');
    await waitFor(() => expect(mockSetDestination).toHaveBeenCalledWith(null));
    expect(mockReleaseLock).toHaveBeenCalled();
  });
});
