/* eslint-disable import/no-restricted-paths --
 * Cross-feature test: useTripBoundAlarmScheduler 본체가 orchestrator(file-level disable).
 * 동일 패턴으로 routeFixtures import. ADR Phase 5 (#890).
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { useTripBoundAlarmScheduler } from '../useTripBoundAlarmScheduler';
import type { ScheduledTripBoundAlarm } from '../../utils/tripBoundScheduler';
import {
  cancelTripBoundAlarms,
  prescheduleStationAlerts,
} from '../../utils/tripBoundScheduler';
import { getTripStartedAt } from '../../utils/tripStartStorage';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import { makeDirectRoute, makeTransferRoute } from '../../../../testUtils/routeFixtures';

jest.mock('../../utils/tripBoundScheduler', () => {
  const actual = jest.requireActual('../../utils/tripBoundScheduler');
  return {
    ...actual,
    prescheduleStationAlerts: jest.fn(),
    cancelTripBoundAlarms: jest.fn(),
  };
});

jest.mock('../../utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn(),
}));

const mockLoggerError = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  }),
}));

const mockedPreschedule = prescheduleStationAlerts as jest.MockedFunction<
  typeof prescheduleStationAlerts
>;
const mockedCancel = cancelTripBoundAlarms as jest.MockedFunction<typeof cancelTripBoundAlarms>;
const mockedGetTripStartedAt = getTripStartedAt as jest.MockedFunction<typeof getTripStartedAt>;

type Props = Parameters<typeof useTripBoundAlarmScheduler>[0];
function renderScheduler(initialProps: Props) {
  return renderHook((props: Props) => useTripBoundAlarmScheduler(props), { initialProps });
}
async function awaitFirstSchedule() {
  await waitFor(() => expect(mockedPreschedule).toHaveBeenCalledTimes(1));
}

const route = makeDirectRoute(2, '2');
const lockA: BoardingLock = {
  destinationId: 'd',
  trainCode: 'A',
  boardingStationId: 's',
  boardingLine: '2',
  boardedAt: 1_000,
  expectedDurationMs: 60_000,
};
const lockB: BoardingLock = { ...lockA, trainCode: 'B', boardedAt: 2_000 };

beforeEach(() => {
  jest.clearAllMocks();
  mockedPreschedule.mockResolvedValue([]);
  mockedCancel.mockResolvedValue(undefined);
  // 기본은 tripStart 없음 — lock 없는 케이스에서 사전 예약 skip이 유지된다.
  mockedGetTripStartedAt.mockResolvedValue(null);
});

describe('useTripBoundAlarmScheduler', () => {
  it('lock=null + route 있어도 cancel/preschedule 둘 다 호출 안 함 (초기 마운트)', async () => {
    renderHook(() =>
      useTripBoundAlarmScheduler({ lock: null, route, destinationName: '강남' }),
    );
    // 한 tick 후에도 호출 없음 — prev/next 모두 null로 early return.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedPreschedule).not.toHaveBeenCalled();
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('lock + route + destination 모두 활성 → preschedule 1회 호출', async () => {
    renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    const call = mockedPreschedule.mock.calls[0][0];
    expect(call.startTime).toBe(lockA.boardedAt);
    // direct route 2 stops → 단일 destination waypoint.
    expect(call.routeStops).toEqual([{ stationName: '강남', alarmType: 'destination' }]);
    expect(call.estimatedHopTimesMs.length).toBe(1);
    // 초기 마운트는 prev=null → cancel skip.
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('null → lock 진입 시 preschedule 호출 (cancel 없음)', async () => {
    const { rerender } = renderScheduler({ lock: null, route, destinationName: '강남' });
    rerender({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('lock 교체(A → B) 시 cancel → 재예약', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: lockB, route, destinationName: '강남' });
    await waitFor(() => {
      expect(mockedCancel).toHaveBeenCalledTimes(1);
      expect(mockedPreschedule).toHaveBeenCalledTimes(2);
    });
    const lastCall = mockedPreschedule.mock.calls[1][0];
    expect(lastCall.startTime).toBe(lockB.boardedAt);
  });

  it('destination=null 전환 시 cancel 호출 (preschedule 추가 없음)', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: lockA, route, destinationName: null });
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledTimes(1));
    expect(mockedPreschedule).toHaveBeenCalledTimes(1);
  });

  it('lock=null 전환 시 cancel 호출', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: null, route, destinationName: '강남' });
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledTimes(1));
    expect(mockedPreschedule).toHaveBeenCalledTimes(1);
  });

  it('같은 trainCode + 같은 route signature 재렌더는 no-op', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: { ...lockA }, route, destinationName: '강남' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedPreschedule).toHaveBeenCalledTimes(1);
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('route signature 변경(같은 trainCode) → cancel 후 재예약', async () => {
    const altRoute = makeTransferRoute({
      transferName: '교대',
      fromLine: '2',
      toLine: '3',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: lockA, route: altRoute, destinationName: '강남' });
    await waitFor(() => {
      expect(mockedCancel).toHaveBeenCalledTimes(1);
      expect(mockedPreschedule).toHaveBeenCalledTimes(2);
    });
    const lastCall = mockedPreschedule.mock.calls[1][0];
    // transfer route → 2 stops (transfer + destination).
    expect(lastCall.routeStops.map((s) => s.stationName)).toEqual(['교대', '강남']);
  });

  it('lock 있어도 route=null이면 preschedule skip (초기 마운트)', async () => {
    renderScheduler({ lock: lockA, route: null, destinationName: '강남' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedPreschedule).not.toHaveBeenCalled();
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('preschedule 실패는 logger.error로 기록 (throw 안 함)', async () => {
    mockedPreschedule.mockRejectedValueOnce(new Error('boom'));
    renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => {
      expect(mockLoggerError).toHaveBeenCalledWith(
        'tripBoundScheduler 전환 실패:',
        expect.any(Error),
      );
    });
  });

  it('cold restart: lock 먼저 들어오고 route 늦게 로드돼도 1회 preschedule 보장', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route: null, destinationName: '강남' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedPreschedule).not.toHaveBeenCalled();
    rerender({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('lock release 후 같은 trainCode 재진입 시 다시 preschedule', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: null, route, destinationName: '강남' });
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledTimes(1));
    rerender({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => expect(mockedPreschedule).toHaveBeenCalledTimes(2));
  });

  // cancel await 중 새 effect가 token을 bump하면 stale run은 cancel 직후 early return해야 한다.
  it('stale completion 가드: cancel await 중 새 effect fire 시 stale run이 preschedule을 호출하지 않음', async () => {
    let resolveCancelB: (() => void) | null = null;
    // 첫 run(A): cancel 없음(prev 없음) + 정상 preschedule.
    mockedPreschedule.mockResolvedValueOnce([]);
    // 두 번째 run(B): cancel을 지연 → 그 사이 lockC로 token bump.
    mockedCancel.mockImplementationOnce(
      () => new Promise<void>((res) => { resolveCancelB = () => res(); }),
    );
    // 세 번째 run(C): 정상 cancel + preschedule.
    mockedCancel.mockResolvedValueOnce(undefined);
    mockedPreschedule.mockResolvedValueOnce([]);

    const lockC: BoardingLock = { ...lockA, trainCode: 'C', boardedAt: 3_000 };
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => expect(mockedPreschedule).toHaveBeenCalledTimes(1));

    // run B 시작 → cancel pending.
    rerender({ lock: lockB, route, destinationName: '강남' });
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledTimes(1));

    // token bump → run C 시작 (이전 token=B는 이제 stale).
    rerender({ lock: lockC, route, destinationName: '강남' });
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockedPreschedule).toHaveBeenCalledTimes(2));

    // 이제 run B의 cancel을 늦게 resolve — stale 가드(line 77)가 발동해 추가 preschedule 호출 없어야 함.
    if (resolveCancelB) (resolveCancelB as () => void)();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedPreschedule).toHaveBeenCalledTimes(2);
  });

  // async race 가드: 이전 run이 await에서 멈춰있는 동안 새 lock으로 effect가 다시 fire되면
  // stale run은 ref를 업데이트하지 말아야 한다 (self code-review #3).
  it('stale completion 가드: 빠른 lock swap 시 stale run의 ref update 차단', async () => {
    let resolveA: ((v: ScheduledTripBoundAlarm[]) => void) | null = null;
    mockedPreschedule.mockImplementationOnce(
      () => new Promise<ScheduledTripBoundAlarm[]>((res) => { resolveA = res; }),
    );
    mockedPreschedule.mockResolvedValueOnce([]);
    mockedPreschedule.mockResolvedValueOnce([]);

    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => expect(mockedPreschedule).toHaveBeenCalledTimes(1));
    rerender({ lock: lockB, route, destinationName: '강남' });
    await waitFor(() => expect(mockedPreschedule).toHaveBeenCalledTimes(2));
    // run-A의 preschedule을 늦게 resolve — stale token이라 ref 업데이트 차단.
    if (resolveA) (resolveA as (v: ScheduledTripBoundAlarm[]) => void)([]);
    await new Promise((r) => setTimeout(r, 0));
    // lockA 재진입 시 새 preschedule trigger (ref가 stale에 의해 lockA로 잘못 set되지 않았음 확인).
    rerender({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => expect(mockedPreschedule).toHaveBeenCalledTimes(3));
  });

  // -------- PR1: lockless 사전 예약 --------

  it('lockless: lock=null + route + destination + tripStart 있으면 startTime=tripStart로 preschedule', async () => {
    mockedGetTripStartedAt.mockResolvedValue(5_000);
    renderScheduler({ lock: null, route, destinationName: '강남' });
    await awaitFirstSchedule();
    const call = mockedPreschedule.mock.calls[0][0];
    expect(call.startTime).toBe(5_000);
    expect(call.routeStops).toEqual([{ stationName: '강남', alarmType: 'destination' }]);
    // 초기 마운트 — prev 없으니 cancel 호출 없음.
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('lockless 후 같은 tripStart로 lock 도착 시 재예약하지 않음 (signature dedup)', async () => {
    mockedGetTripStartedAt.mockResolvedValue(1_000);
    const { rerender } = renderScheduler({ lock: null, route, destinationName: '강남' });
    await awaitFirstSchedule();
    // lock의 boardedAt이 tripStart와 동일 → identity ts:1000 유지 → no-op.
    rerender({ lock: lockA, route, destinationName: '강남' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedPreschedule).toHaveBeenCalledTimes(1);
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('lockless 예약 후 destination clear 시 cancel', async () => {
    mockedGetTripStartedAt.mockResolvedValue(5_000);
    const { rerender } = renderScheduler({ lock: null, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: null, route, destinationName: null });
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledTimes(1));
    expect(mockedPreschedule).toHaveBeenCalledTimes(1);
  });

  it('lockless: tripStart 없으면 schedule skip (cold restart pre-destination)', async () => {
    mockedGetTripStartedAt.mockResolvedValue(null);
    renderScheduler({ lock: null, route, destinationName: '강남' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedPreschedule).not.toHaveBeenCalled();
    expect(mockedCancel).not.toHaveBeenCalled();
  });
});

