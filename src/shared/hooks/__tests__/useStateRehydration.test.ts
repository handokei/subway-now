/* eslint-disable import/no-restricted-paths --
 * useStateRehydration은 cross-feature orchestrator로 본체에서 동일 disable 옵트인이
 * 적용되어 있다 (src/shared/hooks/useStateRehydration.ts 헤더 주석 참조). 본 테스트는
 * 해당 orchestrator를 검증하므로 동일 store에 대한 jest.spyOn이 필수. CLAUDE.md
 * "본질적 cross-feature orchestrator는 파일 헤더의 eslint-disable import/no-restricted-paths
 * 주석으로 명시 옵트인한다" 규칙에 따라 동일 옵트인 적용.
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useStateRehydration } from '../useStateRehydration';
import { useDestinationStore } from '../../../features/route/store/useDestinationStore';
import { useBoardingLockStore } from '../../../features/alarm/store/useBoardingLockStore';

const mockGetSentinel = jest.fn();
const mockClearSentinel = jest.fn();
const mockSetSentinel = jest.fn();
jest.mock('../../../features/alarm/utils/tripEndedSentinel', () => ({
  getTripEndedSentinel: (...args: unknown[]) => mockGetSentinel(...args),
  clearTripEndedSentinel: (...args: unknown[]) => mockClearSentinel(...args),
  setTripEndedSentinel: (...args: unknown[]) => mockSetSentinel(...args),
}));

const mockGetTripStartedAt = jest.fn();
const mockTripLifecyclePhase = jest.fn();
jest.mock('../../../features/alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: (...args: unknown[]) => mockGetTripStartedAt(...args),
  tripLifecyclePhase: (...args: unknown[]) => mockTripLifecyclePhase(...args),
}));

const mockAppendAlarmLog = jest.fn();
jest.mock('../../../features/alarm/utils/alarmLog', () => ({
  appendAlarmLog: (...args: unknown[]) => mockAppendAlarmLog(...args),
}));

const mockReadBackendSsotMirror = jest.fn();
const mockClearBackendSsotMirror = jest.fn();
jest.mock('../../../features/alarm/utils/backendSsotMirror', () => ({
  readBackendSsotMirror: (...args: unknown[]) => mockReadBackendSsotMirror(...args),
  clearBackendSsotMirror: (...args: unknown[]) => mockClearBackendSsotMirror(...args),
}));

const mockAddDomainBreadcrumb = jest.fn();
jest.mock('../../infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: (...args: unknown[]) => mockAddDomainBreadcrumb(...args),
}));

const mockRunTripBoundCleanups = jest.fn();
jest.mock('../../../features/alarm/store/tripBoundCleanups', () => ({
  runTripBoundCleanups: (...args: unknown[]) => mockRunTripBoundCleanups(...args),
}));

// destination store cross-feature import는 storage helper 안에서 일어나므로 spy로 충분.
// useDestinationStore.getState()를 그대로 사용한다 (실제 store)

const mockSetDestination = jest.fn();
const mockLoadDestination = jest.fn();
const mockLoadCustomOrigin = jest.fn();
const mockLoadTripOrigin = jest.fn();
const mockSetState = jest.fn();

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
  mockRunTripBoundCleanups.mockResolvedValue(undefined);
  mockSetSentinel.mockResolvedValue(undefined);
  // 기본은 trip 미존재(none) — 기존 테스트들이 backstop 영향 받지 않도록.
  mockGetTripStartedAt.mockResolvedValue(null);
  mockTripLifecyclePhase.mockReturnValue('none');
  // 기본 mirror 미존재 — 기존 테스트들이 mirror backstop 영향 받지 않도록.
  mockReadBackendSsotMirror.mockResolvedValue(null);
  mockClearBackendSsotMirror.mockResolvedValue(undefined);
  jest.spyOn(useDestinationStore, 'getState').mockReturnValue({
    setDestination: mockSetDestination,
    loadDestination: mockLoadDestination,
    loadCustomOrigin: mockLoadCustomOrigin,
    loadTripOrigin: mockLoadTripOrigin,
  } as unknown as ReturnType<typeof useDestinationStore.getState>);
  jest.spyOn(useDestinationStore, 'setState').mockImplementation((...args: unknown[]) => {
    mockSetState(...args);
  });
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

  it('sentinel 없음 — cleanup/store reset/lock release 모두 호출 안 함 (회귀 0)', async () => {
    mockGetSentinel.mockResolvedValue(null);
    mockAppState();
    renderHook(() => useStateRehydration());
    await waitFor(() => expect(mockLoadDestination).toHaveBeenCalled());
    expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
    expect(mockSetState).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
    expect(mockClearSentinel).not.toHaveBeenCalled();
    expect(mockAddDomainBreadcrumb).not.toHaveBeenCalledWith(
      'trip',
      'end',
      expect.anything(),
    );
  });

  it('sentinel 있음 — runTripBoundCleanups 직접 호출 + setState로 메모리 reset + breadcrumb + releaseLock + sentinel clear', async () => {
    mockGetSentinel.mockResolvedValue(1_700_000_000_000);
    mockAppState();
    renderHook(() => useStateRehydration());
    await waitFor(() => expect(mockClearSentinel).toHaveBeenCalled());
    // #1351 R2: setDestination(null)이 아니라 runTripBoundCleanups 직접 호출.
    expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
    expect(mockSetDestination).not.toHaveBeenCalled();
    // 메모리 store는 setState로 atomic reset.
    expect(mockSetState).toHaveBeenCalledWith({
      destination: null,
      customOrigin: null,
      tripOrigin: null,
    });
    expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('trip', 'end', {
      reason: 'sentinel-rehydration',
    });
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  it('sentinel 있음 + prev destination null (isSwitch=false) — cleanup 정상 실행 (R2 핵심 회귀)', async () => {
    // 이전 동작: setDestination(null)을 호출하면 store의 isSwitch가 false라서 cleanup chain이
    // 실행되지 않았음. 새 동작은 runTripBoundCleanups를 직접 호출하므로 prev 상태 무관 cleanup 보장.
    mockGetSentinel.mockResolvedValue(1_700_000_000_001);
    // destination=null 기본 상태 (prev=null) 시뮬레이션 — 기본 mockReturnValue는 setDestination만
    // 갖고 있어 prev 조회 불가하지만, runTripBoundCleanups가 store에 의존하지 않고 호출되는지가 핵심.
    mockAppState();
    renderHook(() => useStateRehydration());
    await waitFor(() => expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1));
    expect(mockSetState).toHaveBeenCalledWith({
      destination: null,
      customOrigin: null,
      tripOrigin: null,
    });
  });

  it("AppState 'active' 진입 시 재실행", async () => {
    const app = mockAppState();
    renderHook(() => useStateRehydration());
    await waitFor(() => expect(mockLoadDestination).toHaveBeenCalledTimes(1));

    app.emit('active');
    await waitFor(() => expect(mockLoadDestination).toHaveBeenCalledTimes(2));
  });

  it("AppState 비'active'는 rehydrate 트리거 무시", async () => {
    const app = mockAppState();
    renderHook(() => useStateRehydration());
    await waitFor(() => expect(mockLoadDestination).toHaveBeenCalledTimes(1));

    app.emit('background');
    app.emit('inactive');
    // 마운트 1회 외 추가 rehydrate 호출 없음
    expect(mockLoadDestination).toHaveBeenCalledTimes(1);
  });

  describe('lifecycle breadcrumb', () => {
    async function emitAppState(state: AppStateStatus): Promise<void> {
      const app = mockAppState();
      renderHook(() => useStateRehydration());
      await waitFor(() => expect(mockLoadDestination).toHaveBeenCalled());
      mockAddDomainBreadcrumb.mockClear();
      app.emit(state);
    }

    it.each([
      ['active' as const],
      ['background' as const],
    ])("'%s' 진입 시 lifecycle 카테고리 breadcrumb", async (state) => {
      await emitAppState(state);
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('lifecycle', state);
    });

    it("기타 상태('inactive')는 breadcrumb 추가 안 함", async () => {
      await emitAppState('inactive');
      expect(mockAddDomainBreadcrumb).not.toHaveBeenCalled();
    });
  });

  it('unmount 시 AppState listener remove', () => {
    const app = mockAppState();
    const { unmount } = renderHook(() => useStateRehydration());
    unmount();
    expect(app.remove).toHaveBeenCalled();
  });

  describe('#1573 (T10) lifecycle backstop', () => {
    it("startedAt=null — backstop early return (회귀 0)", async () => {
      mockGetTripStartedAt.mockResolvedValue(null);
      mockAppState();
      renderHook(() => useStateRehydration());
      await waitFor(() => expect(mockLoadDestination).toHaveBeenCalled());
      expect(mockAppendAlarmLog).not.toHaveBeenCalled();
      expect(mockSetSentinel).not.toHaveBeenCalled();
      expect(mockTripLifecyclePhase).not.toHaveBeenCalled();
    });

    it("phase='normal' — backstop 아무 동작 안 함", async () => {
      mockGetTripStartedAt.mockResolvedValue(Date.now() - 60_000);
      mockTripLifecyclePhase.mockReturnValue('normal');
      mockAppState();
      renderHook(() => useStateRehydration());
      await waitFor(() => expect(mockLoadDestination).toHaveBeenCalled());
      expect(mockAppendAlarmLog).not.toHaveBeenCalled();
      expect(mockSetSentinel).not.toHaveBeenCalled();
      expect(mockReleaseLock).not.toHaveBeenCalled();
    });

    it("phase='silence' (6h~9h) — alarmLog suppressed 적재 + 강제 종료 안 함", async () => {
      mockGetTripStartedAt.mockResolvedValue(1_000_000);
      mockTripLifecyclePhase.mockReturnValue('silence');
      mockAppState();
      renderHook(() => useStateRehydration());
      await waitFor(() =>
        expect(mockAppendAlarmLog).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'lifecycle-backstop',
            outcome: 'suppressed',
            reason: 'trip-lifecycle-silence',
          }),
        ),
      );
      // silence에서는 force-end 시퀀스 (setState/releaseLock/setSentinel) 호출 금지.
      expect(mockSetState).not.toHaveBeenCalled();
      expect(mockReleaseLock).not.toHaveBeenCalled();
      expect(mockSetSentinel).not.toHaveBeenCalled();
    });

    it("phase='force-end' (9h+) — runTripBoundCleanups + setState reset + releaseLock + sentinel + alarmLog fired", async () => {
      mockGetTripStartedAt.mockResolvedValue(1_000_000);
      mockTripLifecyclePhase.mockReturnValue('force-end');
      mockAppState();
      renderHook(() => useStateRehydration());
      await waitFor(() => expect(mockSetSentinel).toHaveBeenCalled());
      expect(mockAppendAlarmLog).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'lifecycle-backstop',
          outcome: 'fired',
          reason: 'trip-lifecycle-force-ended',
        }),
      );
      expect(mockRunTripBoundCleanups).toHaveBeenCalled();
      expect(mockSetState).toHaveBeenCalledWith({
        destination: null,
        customOrigin: null,
        tripOrigin: null,
      });
      expect(mockReleaseLock).toHaveBeenCalled();
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('trip', 'end', {
        reason: 'lifecycle-9h-force-end',
      });
    });

    it("backstop 실패는 graceful (다음 launch 영향 X)", async () => {
      mockGetTripStartedAt.mockRejectedValue(new Error('io'));
      mockAppState();
      // throw가 새지 않아 hook 자체는 정상 마운트.
      expect(() => renderHook(() => useStateRehydration())).not.toThrow();
      await waitFor(() => expect(mockLoadDestination).toHaveBeenCalled());
    });
  });

  describe('#1598 stale Backend SSoT mirror boot clear', () => {
    it('active trip 없음 + mirror 잔존 — clearBackendSsotMirror 호출 (2026-06-20 dump 회귀)', async () => {
      mockGetTripStartedAt.mockResolvedValue(null);
      mockReadBackendSsotMirror.mockResolvedValue({
        currentStationId: '건대입구',
        motionState: 'unknown',
        lastAdvanceEvidence: 'arrival-prior',
        lastAdvanceAt: 1_700_000_000_000,
        passedStations: [],
        receivedAt: 1_700_000_000_000,
      });
      mockAppState();
      renderHook(() => useStateRehydration());
      await waitFor(() => expect(mockClearBackendSsotMirror).toHaveBeenCalledTimes(1));
    });

    it('active trip 있음 — mirror 그대로 (clear 호출 안 함)', async () => {
      mockGetTripStartedAt.mockResolvedValue(1_000_000);
      mockTripLifecyclePhase.mockReturnValue('normal');
      mockReadBackendSsotMirror.mockResolvedValue({
        currentStationId: '건대입구',
        motionState: 'moving',
        lastAdvanceEvidence: 'arrival',
        lastAdvanceAt: 1_700_000_000_000,
        passedStations: [],
        receivedAt: 1_700_000_000_000,
      });
      mockAppState();
      renderHook(() => useStateRehydration());
      await waitFor(() => expect(mockLoadDestination).toHaveBeenCalled());
      expect(mockClearBackendSsotMirror).not.toHaveBeenCalled();
    });

    it('active trip 없음 + mirror 부재 — read만 하고 clear 호출 안 함', async () => {
      mockGetTripStartedAt.mockResolvedValue(null);
      mockReadBackendSsotMirror.mockResolvedValue(null);
      mockAppState();
      renderHook(() => useStateRehydration());
      await waitFor(() => expect(mockReadBackendSsotMirror).toHaveBeenCalled());
      expect(mockClearBackendSsotMirror).not.toHaveBeenCalled();
    });

    it('mirror read 실패는 graceful (throw 없음)', async () => {
      mockGetTripStartedAt.mockResolvedValue(null);
      mockReadBackendSsotMirror.mockRejectedValue(new Error('io'));
      mockAppState();
      expect(() => renderHook(() => useStateRehydration())).not.toThrow();
      await waitFor(() => expect(mockLoadDestination).toHaveBeenCalled());
    });
  });

  it('active 진입에서도 sentinel 있으면 cleanup + setState reset 호출', async () => {
    const app = mockAppState();
    mockGetSentinel.mockResolvedValueOnce(null);
    renderHook(() => useStateRehydration());
    await waitFor(() => expect(mockLoadDestination).toHaveBeenCalled());
    expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
    expect(mockSetState).not.toHaveBeenCalled();

    mockGetSentinel.mockResolvedValueOnce(1_700_000_000_001);
    app.emit('active');
    await waitFor(() => expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1));
    expect(mockSetState).toHaveBeenCalledWith({
      destination: null,
      customOrigin: null,
      tripOrigin: null,
    });
    expect(mockReleaseLock).toHaveBeenCalled();
  });
});
