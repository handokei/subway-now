/* eslint-disable import/no-restricted-paths --
 * Cross-feature test: useTripBoundAlarmScheduler 본체가 orchestrator(file-level disable).
 * 동일 패턴으로 routeFixtures import. ADR Phase 5 (#890).
 */
import { AppState, type NativeEventSubscription } from 'react-native';
import { renderHook, waitFor } from '@testing-library/react-native';
import { useTripBoundAlarmScheduler, resolveBoardingStation } from '../useTripBoundAlarmScheduler';
import type { ScheduledTripBoundAlarm } from '../../utils/tripBoundScheduler';
import {
  cancelTripBoundAlarms,
  prescheduleStationAlerts,
  setRegisteredTripRouteSig,
  topUpTripBoundWindow,
} from '../../utils/tripBoundScheduler';
import { getTripStartedAt } from '../../utils/tripStartStorage';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import { makeDirectRoute, makeTransferRoute } from '../../../../testUtils/routeFixtures';
import { captureAppStateListener } from '../../testHelpers/tripBoundTestFactory';

jest.mock('../../utils/tripBoundScheduler', () => {
  const actual = jest.requireActual('../../utils/tripBoundScheduler');
  return {
    ...actual,
    prescheduleStationAlerts: jest.fn(),
    cancelTripBoundAlarms: jest.fn(),
    setRegisteredTripRouteSig: jest.fn(),
    topUpTripBoundWindow: jest.fn(),
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
const mockedSetSig = setRegisteredTripRouteSig as jest.MockedFunction<
  typeof setRegisteredTripRouteSig
>;
const mockedTopUp = topUpTripBoundWindow as jest.MockedFunction<typeof topUpTripBoundWindow>;

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
  mockedSetSig.mockResolvedValue(undefined);
  mockedTopUp.mockResolvedValue({ cancelled: 0, scheduled: 0 });
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

  // -------- PR2 (#918 A3, #729 흡수): fire-time 재검증을 위한 route sig 영속화 --------

  it('PR2: preschedule 성공 직후 현재 route sig를 storage에 영속화한다', async () => {
    renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    await waitFor(() => expect(mockedSetSig).toHaveBeenCalledTimes(1));
    // sig는 string 형식(boardingLockScheduler.routeSignature 결과) — 비어 있지 않음.
    expect(typeof mockedSetSig.mock.calls[0][0]).toBe('string');
    expect(mockedSetSig.mock.calls[0][0].length).toBeGreaterThan(0);
  });

  it('PR2: schedule skip 케이스(예: destination=null)에서는 sig 영속화하지 않음', async () => {
    renderScheduler({ lock: lockA, route, destinationName: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSetSig).not.toHaveBeenCalled();
  });

  it('PR2: route signature 변경 시 새 sig가 다시 영속화된다', async () => {
    const altRoute = makeTransferRoute({
      transferName: '교대',
      fromLine: '2',
      toLine: '3',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    await waitFor(() => expect(mockedSetSig).toHaveBeenCalledTimes(1));
    const firstSig = mockedSetSig.mock.calls[0][0];

    rerender({ lock: lockA, route: altRoute, destinationName: '강남' });
    await waitFor(() => expect(mockedSetSig).toHaveBeenCalledTimes(2));
    expect(mockedSetSig.mock.calls[1][0]).not.toBe(firstSig);
  });

  // -------- PR3 (#918 A3): rolling window 64 cap --------

  const transferRouteForTopUp = makeTransferRoute({
    transferName: '교대',
    fromLine: '2',
    toLine: '3',
    stopsToTransfer: 2,
    stopsFromTransfer: 3,
  });

  it('PR3: 초기 preschedule 호출 시 windowSize=TRIPBOUND_WINDOW_SIZE 전달', async () => {
    renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    const call = mockedPreschedule.mock.calls[0][0];
    expect(call.windowSize).toBeGreaterThan(0);
  });

  it('PR3: currentStationName=null이면 top-up skip', async () => {
    renderScheduler({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: null,
    });
    await awaitFirstSchedule();
    expect(mockedTopUp).not.toHaveBeenCalled();
  });

  it('PR3: 초기 마운트 + 매칭 currentStationName이 들어오면 top-up 1회 호출', async () => {
    const { rerender } = renderScheduler({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: null,
    });
    await awaitFirstSchedule();
    rerender({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: '교대',
    });
    await waitFor(() => expect(mockedTopUp).toHaveBeenCalledTimes(1));
    const arg = mockedTopUp.mock.calls[0][0];
    expect(arg.passedStationName).toBe('교대');
    expect(arg.windowSize).toBeGreaterThan(0);
    expect(arg.routeStops.map((s) => s.stationName)).toEqual(['교대', '강남']);
  });

  it('PR3: 같은 currentStationName으로 rerender 시 effect deps 안 바뀌어 추가 호출 없음', async () => {
    const { rerender } = renderScheduler({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: '교대',
    });
    await awaitFirstSchedule();
    await waitFor(() => expect(mockedTopUp).toHaveBeenCalledTimes(1));
    rerender({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: '교대',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedTopUp).toHaveBeenCalledTimes(1);
  });

  it('PR3: matching 안 되는 currentStationName은 no-op', async () => {
    const { rerender } = renderScheduler({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: null,
    });
    await awaitFirstSchedule();
    rerender({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: '관계없는역',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedTopUp).not.toHaveBeenCalled();
  });

  it('PR3: scheduledStops 없는 상태(스케줄 skip)에서 currentStationName 변경은 no-op', async () => {
    renderScheduler({
      lock: null,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: '교대',
    });
    // tripStart=null + lock=null → preschedule skip → scheduledStopsRef=null → top-up skip.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedTopUp).not.toHaveBeenCalled();
  });

  it('PR3: lock 교체로 identity 변경 시 top-up 가드 reset → 같은 currentStation에 대해 다시 호출', async () => {
    const { rerender } = renderScheduler({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: '교대',
    });
    await awaitFirstSchedule();
    await waitFor(() => expect(mockedTopUp).toHaveBeenCalledTimes(1));
    // 새 lock 진입 → ref reset.
    rerender({
      lock: lockB,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: '교대',
    });
    await waitFor(() => expect(mockedPreschedule).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockedTopUp).toHaveBeenCalledTimes(2));
  });

  it('PR3: top-up 실패는 logger.error 기록 (throw 없음)', async () => {
    mockedTopUp.mockRejectedValueOnce(new Error('topup-fail'));
    renderScheduler({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: '교대',
    });
    await awaitFirstSchedule();
    await waitFor(() => {
      expect(mockLoggerError).toHaveBeenCalledWith(
        'topUpTripBoundWindow 실패:',
        expect.any(Error),
      );
    });
  });

  // -------- PR3: AppState 'active' resume top-up --------

  it('PR3: AppState active 진입 + 직전 top-up stop 있으면 top-up 재호출', async () => {
    const appState = captureAppStateListener();
    renderScheduler({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: '교대',
    });
    await awaitFirstSchedule();
    await waitFor(() => expect(mockedTopUp).toHaveBeenCalledTimes(1));

    appState.fire('active');
    await waitFor(() => expect(mockedTopUp).toHaveBeenCalledTimes(2));
    appState.restore();
  });

  it('PR3: AppState background 진입은 top-up trigger 안 함', async () => {
    const appState = captureAppStateListener();
    renderScheduler({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: '교대',
    });
    await awaitFirstSchedule();
    await waitFor(() => expect(mockedTopUp).toHaveBeenCalledTimes(1));

    appState.fire('background');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedTopUp).toHaveBeenCalledTimes(1);
    appState.restore();
  });

  it('PR3: AppState active 진입 시 scheduledStops/lastToppedUp 없으면 skip', async () => {
    const appState = captureAppStateListener();
    // currentStationName 없음 → top-up 안 일어남 → lastToppedUp=null → FG resume skip.
    renderScheduler({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
    });
    await awaitFirstSchedule();

    appState.fire('active');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedTopUp).not.toHaveBeenCalled();
    appState.restore();
  });

  it('PR3: AppState active 진입 + top-up 실패는 logger.error 기록', async () => {
    const appState = captureAppStateListener();
    renderScheduler({
      lock: lockA,
      route: transferRouteForTopUp,
      destinationName: '강남',
      currentStationName: '교대',
    });
    await awaitFirstSchedule();
    await waitFor(() => expect(mockedTopUp).toHaveBeenCalledTimes(1));

    mockedTopUp.mockRejectedValueOnce(new Error('resume-fail'));
    appState.fire('active');
    await waitFor(() => {
      expect(mockLoggerError).toHaveBeenCalledWith(
        'FG resume top-up 실패:',
        expect.any(Error),
      );
    });
    appState.restore();
  });

  it('PR3: unmount 시 AppState subscription remove 호출', async () => {
    const remove = jest.fn();
    const sub: NativeEventSubscription = { remove };
    const spy = jest.spyOn(AppState, 'addEventListener').mockReturnValue(sub);
    const { unmount } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    unmount();
    expect(remove).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// #1389 — resolveBoardingStation helper. lock=null / 매핑 실패 / 매핑 성공 3분기.
describe('resolveBoardingStation (#1389)', () => {
  // helper는 getStationById를 stationRoute에서 import — 실제 stations.json 데이터 조회.

  it('lock === null → null 반환 (lockless / 컨텍스트 부재)', () => {
    expect(resolveBoardingStation(null)).toBeNull();
  });

  it('lock 있으나 boardingStationId가 stations.json에 없음 → null (graceful)', () => {
    const lock: BoardingLock = {
      destinationId: 'dest-1',
      trainCode: 'T-1',
      boardingStationId: 'non-existent-id',
      boardingLine: '2',
      boardedAt: 1_750_000_000_000,
      expectedDurationMs: 600_000,
    };
    expect(resolveBoardingStation(lock)).toBeNull();
  });

  it('lock + getStationById 매핑 성공 → { stationName, line } 반환', () => {
    // stations.json에 존재하는 id를 사용 — '1-001' (소요산, line 1).
    const lock: BoardingLock = {
      destinationId: 'dest-1',
      trainCode: 'T-1',
      boardingStationId: '1-001',
      boardingLine: '1',
      boardedAt: 1_750_000_000_000,
      expectedDurationMs: 600_000,
    };
    const result = resolveBoardingStation(lock);
    expect(result).toEqual({ stationName: '소요산', line: '1' });
  });
});

