/**
 * useStationPrescheduler (#918) — OS 사전 예약 "매역" 채널 owner hook 테스트.
 *
 * useSafetyNetScheduler와 대칭 정책(sleepMode/lock/currentHopIndex 게이트, cancel-only 전환,
 * identity 기반 재등록 skip, in-flight 취소, 언마운트 시 cancel 없음)을 동일 패턴으로 검증한다.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStationPrescheduler } from '../useStationPrescheduler';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import type { Station } from '../../../../shared/types/station';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));

const mockRegisterPrescheduledStationAlarms = jest.fn();
const mockCancelAllPrescheduledAlarms = jest.fn();
jest.mock('../../utils/stationPrescheduler', () => ({
  registerPrescheduledStationAlarms: (...args: unknown[]) =>
    mockRegisterPrescheduledStationAlarms(...args),
  cancelAllPrescheduledAlarms: (...args: unknown[]) => mockCancelAllPrescheduledAlarms(...args),
}));

jest.mock('../../utils/safetyNetScheduler', () => ({
  deviceLocalTripId: (tripStart: number) => `local-${tripStart}`,
}));

const mockGetTripStartedAt = jest.fn();
jest.mock('../../utils/tripStartStorage', () => ({
  getTripStartedAt: (...args: unknown[]) => mockGetTripStartedAt(...args),
}));

const mockErrorSpy = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockErrorSpy(...args),
  }),
}));

const mockAsyncGetItem = AsyncStorage.getItem as jest.Mock;

const TRIP_TOKEN = 'BACKEND-TOKEN';
const TRIP_START = 1_000_000;

function makeStation(id: string, name: string, line: Station['line']): Station {
  return { id, name, line, lineColor: '#000', lat: 0, lng: 0 } as Station;
}

const ARC: Station[] = [
  makeStation('a', 'A역', '2'),
  makeStation('b', 'B역', '2'),
  makeStation('c', 'C역', '2'),
];

function makeLock(overrides: Partial<BoardingLock> = {}): BoardingLock {
  return {
    destinationId: 'c',
    trainCode: 'TRAIN-1',
    boardingStationId: 'a',
    boardingLine: '2',
    boardedAt: TRIP_START,
    expectedDurationMs: 300_000,
    ...overrides,
  } as BoardingLock;
}

describe('useStationPrescheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSettingsStore.setState({ sleepMode: false });
    mockAsyncGetItem.mockResolvedValue(TRIP_TOKEN);
    mockGetTripStartedAt.mockResolvedValue(TRIP_START);
    mockRegisterPrescheduledStationAlarms.mockResolvedValue({ scheduled: 2 });
    mockCancelAllPrescheduledAlarms.mockResolvedValue(undefined);
  });

  it('lock이 null이면(lockless) 등록하지 않는다', async () => {
    renderHook(() =>
      useStationPrescheduler({ arcStations: ARC, currentHopIndex: 0, lock: null }),
    );
    await waitFor(() => {
      expect(mockRegisterPrescheduledStationAlarms).not.toHaveBeenCalled();
    });
    expect(mockCancelAllPrescheduledAlarms).not.toHaveBeenCalled();
  });

  it('sleepMode ON이면 등록하지 않는다(safetyNetScheduler 전담)', async () => {
    useSettingsStore.setState({ sleepMode: true });
    renderHook(() =>
      useStationPrescheduler({ arcStations: ARC, currentHopIndex: 0, lock: makeLock() }),
    );
    await waitFor(() => {
      expect(mockRegisterPrescheduledStationAlarms).not.toHaveBeenCalled();
    });
  });

  it('currentHopIndex가 null이면 등록하지 않는다', async () => {
    renderHook(() =>
      useStationPrescheduler({ arcStations: ARC, currentHopIndex: null, lock: makeLock() }),
    );
    await waitFor(() => {
      expect(mockRegisterPrescheduledStationAlarms).not.toHaveBeenCalled();
    });
  });

  it('arcStations.length가 2 미만이면 등록하지 않는다', async () => {
    renderHook(() =>
      useStationPrescheduler({
        arcStations: [ARC[0]],
        currentHopIndex: 0,
        lock: makeLock(),
      }),
    );
    await waitFor(() => {
      expect(mockRegisterPrescheduledStationAlarms).not.toHaveBeenCalled();
    });
  });

  it('currentHopIndex가 arc 마지막 인덱스 이상이면 등록하지 않는다', async () => {
    renderHook(() =>
      useStationPrescheduler({
        arcStations: ARC,
        currentHopIndex: ARC.length - 1,
        lock: makeLock(),
      }),
    );
    await waitFor(() => {
      expect(mockRegisterPrescheduledStationAlarms).not.toHaveBeenCalled();
    });
  });

  it('게이트 off로 전환 시 이전 등록이 있으면 cancel-only 수행', async () => {
    const { rerender } = renderHook(
      ({ lock }: { lock: BoardingLock | null }) =>
        useStationPrescheduler({ arcStations: ARC, currentHopIndex: 0, lock }),
      { initialProps: { lock: makeLock() as BoardingLock | null } },
    );
    await waitFor(() => expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(1));

    rerender({ lock: null });

    await waitFor(() => expect(mockCancelAllPrescheduledAlarms).toHaveBeenCalledWith(TRIP_TOKEN));
  });

  it('게이트 off 전환 시 이전 등록이 없으면 cancel을 호출하지 않는다', async () => {
    renderHook(() => useStationPrescheduler({ arcStations: ARC, currentHopIndex: 0, lock: null }));
    await waitFor(() => {
      expect(mockRegisterPrescheduledStationAlarms).not.toHaveBeenCalled();
    });
    expect(mockCancelAllPrescheduledAlarms).not.toHaveBeenCalled();
  });

  it('tripStart가 없으면 이번 cycle을 skip하고 직전 등록을 유지한다', async () => {
    mockGetTripStartedAt.mockResolvedValue(null);
    renderHook(() => useStationPrescheduler({ arcStations: ARC, currentHopIndex: 0, lock: makeLock() }));
    await waitFor(() => {
      expect(mockGetTripStartedAt).toHaveBeenCalled();
    });
    expect(mockRegisterPrescheduledStationAlarms).not.toHaveBeenCalled();
  });

  it('backend tripToken이 없으면 deviceLocalTripId로 대체한다', async () => {
    mockAsyncGetItem.mockResolvedValue(null);
    renderHook(() => useStationPrescheduler({ arcStations: ARC, currentHopIndex: 0, lock: makeLock() }));
    await waitFor(() => {
      expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledWith(
        expect.objectContaining({ tripToken: `local-${TRIP_START}` }),
      );
    });
  });

  it('lock 활성 + sleepMode OFF + 유효 hopIndex면 backend tripToken으로 등록한다', async () => {
    renderHook(() => useStationPrescheduler({ arcStations: ARC, currentHopIndex: 0, lock: makeLock() }));
    await waitFor(() => {
      expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledWith({
        tripToken: TRIP_TOKEN,
        arcStations: ARC,
        currentIdx: 0,
      });
    });
  });

  it('같은 tripToken+hopIndex+arcLen identity면 재등록하지 않는다', async () => {
    const { rerender } = renderHook(
      ({ currentHopIndex }: { currentHopIndex: number }) =>
        useStationPrescheduler({ arcStations: ARC, currentHopIndex, lock: makeLock() }),
      { initialProps: { currentHopIndex: 0 } },
    );
    await waitFor(() => expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(1));

    rerender({ currentHopIndex: 0 });
    await waitFor(() => {
      // identity 불변이므로 추가 호출 없음(effect는 재실행되지만 registeredIdentityRef가 동일해 조기 반환).
      expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(1);
    });
  });

  it('currentHopIndex가 바뀌면 이전 예약을 cancel한 뒤 새 앵커로 재등록한다', async () => {
    const { rerender } = renderHook(
      ({ currentHopIndex }: { currentHopIndex: number }) =>
        useStationPrescheduler({ arcStations: ARC, currentHopIndex, lock: makeLock() }),
      { initialProps: { currentHopIndex: 0 } },
    );
    await waitFor(() => expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(1));

    rerender({ currentHopIndex: 1 });

    await waitFor(() => expect(mockCancelAllPrescheduledAlarms).toHaveBeenCalledWith(TRIP_TOKEN));
    await waitFor(() => expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(2));
    expect(mockRegisterPrescheduledStationAlarms).toHaveBeenLastCalledWith({
      tripToken: TRIP_TOKEN,
      arcStations: ARC,
      currentIdx: 1,
    });
  });

  it('effect 재실행 중 이전 in-flight 호출 결과는 최신 토큰과 다르면 상태를 갱신하지 않는다', async () => {
    let resolveFirst!: (value: { scheduled: number }) => void;
    mockRegisterPrescheduledStationAlarms
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ scheduled: 1 });

    const { rerender } = renderHook(
      ({ currentHopIndex }: { currentHopIndex: number }) =>
        useStationPrescheduler({ arcStations: ARC, currentHopIndex, lock: makeLock() }),
      { initialProps: { currentHopIndex: 0 } },
    );
    // 첫 effect가 register 호출까지 도달(in-flight 상태로 멈춤)한 것을 확인한 뒤에 currentHopIndex를
    // 바꿔야 두 번째 effect가 "직전 등록 존재"로 판정해 cancel + 재등록 경로를 탄다. 이 대기 없이
    // 바로 rerender하면 첫 effect의 Promise.all이 아직 안 끝나 myToken 검사에서 조기 return되어
    // register 자체가 호출되지 않는다.
    await waitFor(() => expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(1));

    // 첫 effect가 in-flight인 상태에서 currentHopIndex를 바꿔 두 번째 effect를 트리거.
    rerender({ currentHopIndex: 1 });
    await waitFor(() => expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(2));

    // 첫 호출(stale)을 뒤늦게 resolve — inFlightTokenRef 불일치로 무시되어야 한다.
    act(() => {
      resolveFirst({ scheduled: 999 });
    });

    await waitFor(() => {
      expect(mockErrorSpy).not.toHaveBeenCalled();
    });
  });

  it('Promise.all(tripToken/tripStart 조회) 완료 시점에 이미 stale해졌으면 조기 return한다', async () => {
    let resolveTripStart!: (value: number) => void;
    mockGetTripStartedAt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTripStart = resolve;
        }),
    );

    const { rerender } = renderHook(
      ({ currentHopIndex }: { currentHopIndex: number }) =>
        useStationPrescheduler({ arcStations: ARC, currentHopIndex, lock: makeLock() }),
      { initialProps: { currentHopIndex: 0 } },
    );

    // 첫 effect가 tripStart 조회(Promise.all)에서 멈춘 상태 그대로 두 번째 effect를 트리거.
    rerender({ currentHopIndex: 1 });
    await waitFor(() => expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(1));

    // 첫 effect(stale)의 tripStart 조회를 뒤늦게 resolve — line84 조기 return으로 nextIdentity
    // 계산/cancel/register 어느 것도 다시 실행되지 않아야 한다(호출 수 그대로 1).
    act(() => {
      resolveTripStart(TRIP_START);
    });

    await waitFor(() => {
      expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(1);
    });
  });

  it('cancelAllPrescheduledAlarms 완료 시점에 이미 stale해졌으면 register를 호출하지 않는다', async () => {
    // arcLen=4(마지막 인덱스 3)라야 hopIndex 0/1/2 모두 유효한 currentHopIndex다 — ARC(길이 3)를
    // 쓰면 hopIndex=2가 arc 끝(gatedOff)이 되어 이 테스트가 검증하려는 경로(정상 재등록)를 못 탄다.
    const LONG_ARC: Station[] = [
      ...ARC,
      makeStation('d', 'D역', '2'),
    ];
    let resolveStaleCancel!: () => void;
    mockCancelAllPrescheduledAlarms
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveStaleCancel = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    const { rerender } = renderHook(
      ({ currentHopIndex }: { currentHopIndex: number }) =>
        useStationPrescheduler({ arcStations: LONG_ARC, currentHopIndex, lock: makeLock() }),
      { initialProps: { currentHopIndex: 0 } },
    );
    // 최초 등록 완료 — registeredIdentityRef가 채워져야 다음 변경이 cancel 경로를 탄다.
    await waitFor(() => expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(1));

    // hopIndex 1로 변경 — nextIdentity가 달라져 cancelAllPrescheduledAlarms 호출(pending으로 멈춤).
    rerender({ currentHopIndex: 1 });
    await waitFor(() => expect(mockCancelAllPrescheduledAlarms).toHaveBeenCalledTimes(1));

    // 그 cancel이 끝나기 전에 hopIndex 2로 다시 변경 — 새 effect가 myToken을 선점하고 정상 완주.
    rerender({ currentHopIndex: 2 });
    await waitFor(() => expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(2));

    // stale(hopIndex 1) cancel을 뒤늦게 resolve — line98 조기 return으로 register가 추가 호출되지
    // 않아야 한다(호출 수 그대로 2).
    act(() => {
      resolveStaleCancel();
    });

    await waitFor(() => {
      expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(2);
    });
  });

  it('예외 발생 시 logger.error로 catch되어 전파되지 않는다', async () => {
    mockRegisterPrescheduledStationAlarms.mockRejectedValueOnce(new Error('schedule fail'));
    renderHook(() => useStationPrescheduler({ arcStations: ARC, currentHopIndex: 0, lock: makeLock() }));
    await waitFor(() => {
      expect(mockErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('stationPrescheduler 전환 실패'),
        expect.any(Error),
      );
    });
  });

  it('sleepMode 토글이 dependency에 포함되어 즉시 재실행된다', async () => {
    const { rerender } = renderHook(
      () => useStationPrescheduler({ arcStations: ARC, currentHopIndex: 0, lock: makeLock() }),
    );
    await waitFor(() => expect(mockRegisterPrescheduledStationAlarms).toHaveBeenCalledTimes(1));

    act(() => {
      useSettingsStore.setState({ sleepMode: true });
    });
    rerender({});

    await waitFor(() => expect(mockCancelAllPrescheduledAlarms).toHaveBeenCalledWith(TRIP_TOKEN));
  });
});
