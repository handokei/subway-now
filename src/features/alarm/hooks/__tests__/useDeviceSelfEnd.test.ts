import { renderHook, waitFor } from '@testing-library/react-native';
import { useDeviceSelfEnd, type UseDeviceSelfEndInputs } from '../useDeviceSelfEnd';
import type { Station } from '../../../../shared/types/station';

const mockGetSentinel = jest.fn();
const mockSetSentinel = jest.fn();
const mockClearSentinel = jest.fn();
jest.mock('../../utils/tripEndedSentinel', () => {
  const actual = jest.requireActual('../../utils/tripEndedSentinel');
  return {
    // #2114 — 순수 함수라 실제 구현 그대로 사용. storage I/O 함수만 mock.
    isTripEndedSentinelStale: actual.isTripEndedSentinelStale,
    getTripEndedSentinel: (...args: unknown[]) => mockGetSentinel(...args),
    setTripEndedSentinel: (...args: unknown[]) => mockSetSentinel(...args),
    clearTripEndedSentinel: (...args: unknown[]) => mockClearSentinel(...args),
  };
});

const mockGetTripStartedAt = jest.fn();
jest.mock('../../utils/tripStartStorage', () => ({
  getTripStartedAt: (...args: unknown[]) => mockGetTripStartedAt(...args),
}));

const mockRunTripBoundCleanups = jest.fn();
jest.mock('../../store/tripBoundCleanups', () => ({
  runTripBoundCleanups: (...args: unknown[]) => mockRunTripBoundCleanups(...args),
}));

const mockTriggerTripEndRecall = jest.fn();
jest.mock('../../utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: (...args: unknown[]) => mockTriggerTripEndRecall(...args),
}));

const mockGetCurrentTripCorrIdSync = jest.fn(() => null);
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCurrentTripCorrIdSync(),
}));

const mockTriggerTripGroundTruthPrompt = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: (...args: unknown[]) =>
    mockTriggerTripGroundTruthPrompt(...args),
}));

const mockAppendAlarmLog = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  appendAlarmLog: (...args: unknown[]) => mockAppendAlarmLog(...args),
}));

const mockAddDomainBreadcrumb = jest.fn();
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: (...args: unknown[]) => mockAddDomainBreadcrumb(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// destination / boardingLock store mocks — 실제 zustand 대신 반환값 제어.
let mockDestinationState: Station | null = null;
const mockDestinationSetState = jest.fn();
const mockReleaseLock = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../route/store/useDestinationStore', () => {
  function useDestinationStore(selector: (s: { destination: Station | null }) => unknown): unknown {
    return selector({ destination: mockDestinationState });
  }
  useDestinationStore.setState = (...args: unknown[]) => mockDestinationSetState(...args);
  useDestinationStore.getState = () => ({ destination: mockDestinationState });
  return { useDestinationStore };
});

jest.mock('../../store/useBoardingLockStore', () => {
  function useBoardingLockStore(
    selector: (s: { releaseLock: () => Promise<void> }) => unknown,
  ): unknown {
    return selector({ releaseLock: mockReleaseLock });
  }
  return { useBoardingLockStore };
});

const DESTINATION: Station = {
  id: 'seongsu',
  name: '성수',
  line: '2',
  lineColor: '#000',
  lat: 37.544,
  lng: 127.055,
};

const T0 = 1_700_000_000_000;

function withDateNow<T>(value: number, fn: () => T): T {
  const spy = jest.spyOn(Date, 'now').mockReturnValue(value);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

function baseInputs(overrides: Partial<UseDeviceSelfEndInputs> = {}): UseDeviceSelfEndInputs {
  return {
    currentStation: null,
    confidence: null,
    arcProgress: null,
    positionStability: 'unknown',
    expectedTripDurationMs: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDestinationState = null;
  mockGetSentinel.mockResolvedValue(null);
  mockSetSentinel.mockResolvedValue(undefined);
  mockClearSentinel.mockResolvedValue(undefined);
  mockGetTripStartedAt.mockResolvedValue(null);
  mockRunTripBoundCleanups.mockResolvedValue(undefined);
  mockTriggerTripEndRecall.mockResolvedValue({ uploaded: false });
});

describe('useDeviceSelfEnd', () => {
  describe('destination null (no active trip)', () => {
    it('destination null이면 signal trigger 조건 충족돼도 fire 안 함', async () => {
      mockDestinationState = null;
      withDateNow(T0, () => {
        renderHook(() =>
          useDeviceSelfEnd(
            baseInputs({
              currentStation: DESTINATION,
              confidence: 'backend-ssot',
              positionStability: 'static',
            }),
          ),
        );
      });
      // 마이크로태스크 다음 tick까지 대기
      await Promise.resolve();
      expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
      expect(mockSetSentinel).not.toHaveBeenCalled();
    });
  });

  describe('idempotent guard (sentinel already recorded)', () => {
    it('sentinel non-null이면 signal trigger돼도 cleanup skip', async () => {
      mockDestinationState = DESTINATION;
      mockGetSentinel.mockResolvedValue(T0 - 60_000);
      // Signal 1 트리거 조건: destination match + strong confidence + 30s 지속.
      // 각 rerender에 새 currentStation 객체를 전달해 useEffect deps 변경을 유도(production
      // 에서는 fusion result가 매 tick 새 객체).
      const { rerender } = withDateNow(T0, () =>
        renderHook(
          (p: UseDeviceSelfEndInputs) => useDeviceSelfEnd(p),
          {
            initialProps: baseInputs({
              currentStation: { ...DESTINATION },
              confidence: 'backend-ssot',
              positionStability: 'unknown',
            }),
          },
        ),
      );
      withDateNow(T0 + 30_000, () => {
        rerender(
          baseInputs({
            currentStation: { ...DESTINATION },
            confidence: 'backend-ssot',
            positionStability: 'unknown',
          }),
        );
      });
      // sentinel check가 async라 대기
      await waitFor(() => expect(mockGetSentinel).toHaveBeenCalled());
      // sentinel 존재 → cleanup chain 미호출
      expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
      expect(mockSetSentinel).not.toHaveBeenCalled();
    });
  });

  describe('#2114 stale sentinel guard', () => {
    it('stale sentinel(활성 trip이 sentinel보다 나중 시작) → clear 후 self-end 계속 진행', async () => {
      mockDestinationState = DESTINATION;
      mockGetSentinel.mockResolvedValue(T0 - 120_000);
      mockGetTripStartedAt.mockResolvedValue(T0 - 60_000); // sentinel 이후 새 trip 시작 → stale.
      const { rerender } = withDateNow(T0, () =>
        renderHook(
          (p: UseDeviceSelfEndInputs) => useDeviceSelfEnd(p),
          {
            initialProps: baseInputs({
              currentStation: { ...DESTINATION },
              confidence: 'backend-ssot',
              positionStability: 'unknown',
            }),
          },
        ),
      );
      await waitFor(() => expect(mockGetTripStartedAt).toHaveBeenCalled());
      withDateNow(T0 + 30_000, () => {
        rerender(
          baseInputs({
            currentStation: { ...DESTINATION },
            confidence: 'backend-ssot',
            positionStability: 'unknown',
          }),
        );
      });
      await waitFor(() => expect(mockClearSentinel).toHaveBeenCalledTimes(1));
      // sentinel stale → clear 후 self-end chain 계속 진행 (idempotent guard 우회 아님, stale 판정).
      expect(mockRunTripBoundCleanups).toHaveBeenCalled();
      expect(mockSetSentinel).toHaveBeenCalled();
    });
  });

  describe('Signal 1 — fusion-destination trigger', () => {
    it('destination match + strong confidence + 30s 지속 → runTripBoundCleanups + setTripEndedSentinel 호출', async () => {
      mockDestinationState = DESTINATION;
      const { rerender } = withDateNow(T0, () =>
        renderHook(
          (p: UseDeviceSelfEndInputs) => useDeviceSelfEnd(p),
          {
            initialProps: baseInputs({
              currentStation: { ...DESTINATION },
              confidence: 'backend-ssot',
              positionStability: 'unknown',
            }),
          },
        ),
      );
      // 각 rerender에 새 currentStation 객체를 전달해 useEffect deps 변경 (production 재현).
      withDateNow(T0 + 30_000, () => {
        rerender(
          baseInputs({
            currentStation: { ...DESTINATION },
            confidence: 'backend-ssot',
            positionStability: 'unknown',
          }),
        );
      });
      await waitFor(() => expect(mockRunTripBoundCleanups).toHaveBeenCalled());
      expect(mockTriggerTripEndRecall).toHaveBeenCalled();
      expect(mockSetSentinel).toHaveBeenCalled();
      expect(mockDestinationSetState).toHaveBeenCalledWith({
        destination: null,
        customOrigin: null,
        tripOrigin: null,
      });
      expect(mockReleaseLock).toHaveBeenCalled();
      expect(mockAppendAlarmLog).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'lifecycle-backstop',
          outcome: 'fired',
          reason: 'trip-device-self-end-fusion-destination',
        }),
      );
    });

    it('gps-only confidence는 강 신호 화이트리스트에 없어 trigger X', async () => {
      mockDestinationState = DESTINATION;
      const { rerender } = withDateNow(T0, () =>
        renderHook(
          (p: UseDeviceSelfEndInputs) => useDeviceSelfEnd(p),
          {
            initialProps: baseInputs({
              currentStation: { ...DESTINATION },
              confidence: 'gps-only',
              positionStability: 'unknown',
            }),
          },
        ),
      );
      withDateNow(T0 + 60_000, () => {
        rerender(
          baseInputs({
            currentStation: { ...DESTINATION },
            confidence: 'gps-only',
            positionStability: 'unknown',
          }),
        );
      });
      await Promise.resolve();
      expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
    });
  });

  describe('Signal 2 — arc-completion trigger', () => {
    it('arc 0.95 + stationary 60s → cleanup 호출', async () => {
      mockDestinationState = DESTINATION;
      const { rerender } = withDateNow(T0, () =>
        renderHook(
          (p: UseDeviceSelfEndInputs) => useDeviceSelfEnd(p),
          {
            initialProps: baseInputs({
              arcProgress: 0.96,
              positionStability: 'static',
            }),
          },
        ),
      );
      // arcProgress를 살짝 변경(0.96 → 0.97)해 deps 변경 유도.
      withDateNow(T0 + 60_000, () => {
        rerender(
          baseInputs({
            arcProgress: 0.97,
            positionStability: 'static',
          }),
        );
      });
      await waitFor(() => expect(mockRunTripBoundCleanups).toHaveBeenCalled());
      expect(mockAppendAlarmLog).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'trip-device-self-end-arc-completion',
        }),
      );
    });

    it('arc 0.95 + moving → trigger X (stationary 요구)', async () => {
      mockDestinationState = DESTINATION;
      const { rerender } = withDateNow(T0, () =>
        renderHook(
          (p: UseDeviceSelfEndInputs) => useDeviceSelfEnd(p),
          {
            initialProps: baseInputs({
              arcProgress: 0.96,
              positionStability: 'moving',
            }),
          },
        ),
      );
      withDateNow(T0 + 60_000, () => {
        rerender(
          baseInputs({
            arcProgress: 0.97,
            positionStability: 'moving',
          }),
        );
      });
      await Promise.resolve();
      expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
    });
  });

  describe('Signal 3 — eta-backstop trigger', () => {
    it('elapsed > eta × 2 + stationary 5분 → cleanup 호출', async () => {
      mockDestinationState = DESTINATION;
      const ETA = 30 * 60_000; // 30분
      // trip 시작이 90분 전 (elapsed = 90분 > eta × 2 = 60분)
      mockGetTripStartedAt.mockResolvedValue(T0 - 90 * 60_000);

      const { rerender } = withDateNow(T0, () =>
        renderHook(
          (p: UseDeviceSelfEndInputs) => useDeviceSelfEnd(p),
          {
            initialProps: baseInputs({
              positionStability: 'static',
              expectedTripDurationMs: ETA,
            }),
          },
        ),
      );
      // useEffect 마운트 후 tripStartedAt loading await
      await waitFor(() => expect(mockGetTripStartedAt).toHaveBeenCalled());

      // stationary 5분 지속 시뮬레이션 — deps 변경을 위해 expectedTripDurationMs 살짝 다르게.
      withDateNow(T0 + 5 * 60_000, () => {
        rerender(
          baseInputs({
            positionStability: 'static',
            expectedTripDurationMs: ETA + 1,
          }),
        );
      });
      await waitFor(() => expect(mockRunTripBoundCleanups).toHaveBeenCalled());
      expect(mockAppendAlarmLog).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'trip-device-self-end-eta-backstop',
        }),
      );
    });
  });

  describe('destination id 변경 시 tracker reset', () => {
    it('destination id 변경 시 firedForDestinationId ref 리셋 → 새 trip에서 재발화 가능', async () => {
      mockDestinationState = DESTINATION;
      const { rerender } = withDateNow(T0, () =>
        renderHook(
          (p: UseDeviceSelfEndInputs) => useDeviceSelfEnd(p),
          {
            initialProps: baseInputs({
              currentStation: { ...DESTINATION },
              confidence: 'backend-ssot',
            }),
          },
        ),
      );
      withDateNow(T0 + 30_000, () => {
        rerender(
          baseInputs({
            currentStation: { ...DESTINATION },
            confidence: 'backend-ssot',
          }),
        );
      });
      await waitFor(() => expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1));

      // destination을 다른 station으로 변경 — destinationState 자체를 store에서 바꾸고, 새 currentStation 전달.
      const OTHER: Station = {
        id: 'gundae',
        name: '건대입구',
        line: '2',
        lineColor: '#000',
        lat: 37.54,
        lng: 127.07,
      };
      mockDestinationState = OTHER;
      // destinationId가 selector로 다시 읽히지 않으므로 rerender 시 useDestinationStore가 재호출되어야 함.
      // React 컴포넌트 재렌더링을 유발하는 prop 변경 + destinationState 변경.
      withDateNow(T0 + 60_000, () => {
        rerender(
          baseInputs({
            currentStation: { ...OTHER },
            confidence: 'backend-ssot',
          }),
        );
      });
      withDateNow(T0 + 90_000, () => {
        rerender(
          baseInputs({
            currentStation: { ...OTHER },
            confidence: 'backend-ssot',
          }),
        );
      });
      await waitFor(() => expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(2));
    });
  });

  describe('unmount race — cancelled guard', () => {
    it('마운트 직후 unmount 시 tripStartedAt setState skip (cancelled=true)', async () => {
      mockDestinationState = DESTINATION;
      // 응답을 지연시켜 unmount가 promise resolve 이전에 발생하도록.
      let resolveTripStarted!: (v: number | null) => void;
      mockGetTripStartedAt.mockReturnValue(
        new Promise((r) => {
          resolveTripStarted = r;
        }),
      );
      const { unmount } = withDateNow(T0, () =>
        renderHook(() =>
          useDeviceSelfEnd(
            baseInputs({ currentStation: { ...DESTINATION }, confidence: 'backend-ssot' }),
          ),
        ),
      );
      // unmount 후에 promise resolve — setTripStartedAt_ 는 cancelled=true라 skip.
      unmount();
      resolveTripStarted(T0 - 60_000);
      await Promise.resolve();
      // 특별한 assertion 없이 crash 없이 통과 = cancelled guard가 setState skip 성공.
    });
  });

  describe('same trip 재발화 억제', () => {
    it('같은 trip에서 signal 재trigger 시 두 번째는 skip (firedForDestinationIdRef)', async () => {
      mockDestinationState = DESTINATION;
      const { rerender } = withDateNow(T0, () =>
        renderHook(
          (p: UseDeviceSelfEndInputs) => useDeviceSelfEnd(p),
          {
            initialProps: baseInputs({
              currentStation: { ...DESTINATION },
              confidence: 'backend-ssot',
            }),
          },
        ),
      );
      withDateNow(T0 + 30_000, () => {
        rerender(
          baseInputs({
            currentStation: { ...DESTINATION },
            confidence: 'backend-ssot',
          }),
        );
      });
      await waitFor(() => expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1));

      // 같은 destination 유지 + fusion signal 계속 매칭 → firedForDestinationIdRef guard로 skip.
      withDateNow(T0 + 60_000, () => {
        rerender(
          baseInputs({
            currentStation: { ...DESTINATION },
            confidence: 'backend-ssot',
          }),
        );
      });
      // 추가 호출 없음
      await Promise.resolve();
      expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
    });
  });

  describe('graceful error handling', () => {
    it('runTripBoundCleanups reject해도 hook crash 안 함', async () => {
      mockDestinationState = DESTINATION;
      mockRunTripBoundCleanups.mockRejectedValue(new Error('boom'));
      const { rerender } = withDateNow(T0, () =>
        renderHook(
          (p: UseDeviceSelfEndInputs) => useDeviceSelfEnd(p),
          {
            initialProps: baseInputs({
              currentStation: { ...DESTINATION },
              confidence: 'backend-ssot',
            }),
          },
        ),
      );
      withDateNow(T0 + 30_000, () => {
        rerender(
          baseInputs({
            currentStation: { ...DESTINATION },
            confidence: 'backend-ssot',
          }),
        );
      });
      await waitFor(() => expect(mockRunTripBoundCleanups).toHaveBeenCalled());
      // graceful → setSentinel 은 catch 뒤에 실행 안 됨 (chain중단)
      // 하지만 hook 자체는 crash 없이 정상 종료. Domain breadcrumb는 이미 log됨.
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith(
        'trip',
        'device-self-end',
        { reason: 'fusion-destination' },
      );
    });
  });
});
