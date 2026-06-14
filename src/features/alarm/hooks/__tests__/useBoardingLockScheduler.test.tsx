/* eslint-disable import/no-restricted-paths --
 * Cross-feature test: useBoardingLockScheduler 본체가 orchestrator(file-level disable). settings
 * store(sleepMode) 분기 검증을 위해 같은 import 사용. ADR Phase 5 (#890).
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { useBoardingLockScheduler } from '../useBoardingLockScheduler';
import {
  cancelAllHopsForLock,
  scheduleHopsForLock,
} from '../../utils/boardingLockScheduler';
import { clearFiredAlarms } from '../../utils/notificationState';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import { makeDirectRoute, makeTransferRoute } from '../../../../testUtils/routeFixtures';

const mockSetRegisteredBlRouteSig = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/boardingLockScheduler', () => {
  const actual = jest.requireActual('../../utils/boardingLockScheduler');
  return {
    scheduleHopsForLock: jest.fn(),
    cancelAllHopsForLock: jest.fn(),
    // routeSignature는 실제 구현을 그대로 사용 — hook이 이 결과로 변경 감지를 하므로
    // mocking하면 트레이드가 의미를 잃는다.
    routeSignature: actual.routeSignature,
    // #1282: sig 영속화 함수는 storage side-effect가 없는 no-op으로 격리.
    setRegisteredBlRouteSig: (...args: unknown[]) => mockSetRegisteredBlRouteSig(...args),
  };
});
jest.mock('../../utils/notificationState', () => ({
  // #1282: route-sig 변경 시 firedAlarms 클리어 호출을 격리.
  clearFiredAlarms: jest.fn().mockResolvedValue(undefined),
}));
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  }),
}));

const mockedSchedule = scheduleHopsForLock as jest.MockedFunction<typeof scheduleHopsForLock>;
const mockedCancel = cancelAllHopsForLock as jest.MockedFunction<typeof cancelAllHopsForLock>;
const mockedClearFiredAlarms = clearFiredAlarms as jest.MockedFunction<typeof clearFiredAlarms>;

type SchedulerProps = Parameters<typeof useBoardingLockScheduler>[0];

function renderScheduler(initialProps: SchedulerProps) {
  return renderHook((props: SchedulerProps) => useBoardingLockScheduler(props), { initialProps });
}

async function awaitFirstSchedule() {
  await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(1));
}

const lockA: BoardingLock = {
  destinationId: 'd',
  trainCode: 'A',
  boardingStationId: 's',
  boardingLine: '2',
  boardedAt: 1,
  expectedDurationMs: 1000,
};
const lockB: BoardingLock = { ...lockA, trainCode: 'B' };
const route = makeDirectRoute(2, '2');

beforeEach(() => {
  jest.clearAllMocks();
  mockedSchedule.mockResolvedValue([]);
  mockedCancel.mockResolvedValue(undefined);
  useSettingsStore.setState({ sleepMode: false });
});

describe('useBoardingLockScheduler', () => {
  it('초기 마운트 시 lock=null이면 cancel/schedule 둘 다 호출 안 함', async () => {
    renderHook(() =>
      useBoardingLockScheduler({ lock: null, route, destinationName: '강남' }),
    );
    await waitFor(() => {
      expect(mockedCancel).not.toHaveBeenCalled();
      expect(mockedSchedule).not.toHaveBeenCalled();
    });
  });

  it('초기 마운트 시 lock 있으면 schedule만 호출', async () => {
    renderHook(() =>
      useBoardingLockScheduler({ lock: lockA, route, destinationName: '강남' }),
    );
    await waitFor(() => {
      expect(mockedSchedule).toHaveBeenCalledWith({
        lock: lockA,
        route,
        destinationName: '강남',
        sleepMode: false,
      });
      expect(mockedCancel).not.toHaveBeenCalled();
    });
  });

  it('lock 신규 생성(null → A): schedule만', async () => {
    const { rerender } = renderScheduler({ lock: null, route, destinationName: '강남' });
    rerender({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => {
      expect(mockedSchedule).toHaveBeenCalledTimes(1);
      expect(mockedCancel).not.toHaveBeenCalled();
    });
  });

  it('lock 교체(A → B): A cancel 후 B schedule', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: lockB, route, destinationName: '강남' });
    await waitFor(() => {
      expect(mockedCancel).toHaveBeenCalledWith(lockA);
      expect(mockedSchedule).toHaveBeenCalledTimes(2);
      expect(mockedSchedule).toHaveBeenLastCalledWith({
        lock: lockB,
        route,
        destinationName: '강남',
        sleepMode: false,
      });
    });
  });

  it('lock 해제(A → null): cancel만, schedule 추가 없음', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: null, route, destinationName: '강남' });
    await waitFor(() => {
      expect(mockedCancel).toHaveBeenCalledWith(lockA);
    });
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
  });

  it('같은 trainCode로 객체만 갱신되면 재호출 안 함', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: { ...lockA }, route, destinationName: '강남' });
    // wait one tick
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('lock 있지만 route 또는 destinationName 미상이면 cancel만 호출 (이전 lock 있을 때)', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: lockB, route: null, destinationName: '강남' });
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledWith(lockA));
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
  });

  it('scheduleHopsForLock 실패는 logger.error로 기록되고 throw 없음', async () => {
    mockedSchedule.mockRejectedValueOnce(new Error('boom'));
    renderHook(() =>
      useBoardingLockScheduler({ lock: lockA, route, destinationName: '강남' }),
    );
    await waitFor(() => {
      expect(mockLoggerError).toHaveBeenCalledWith('scheduler 전환 실패:', expect.any(Error));
    });
  });

  it('lock 있지만 destinationName=null이면 schedule 호출 안 함', async () => {
    renderHook(() =>
      useBoardingLockScheduler({ lock: lockA, route, destinationName: null }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('#632 sleepMode=true 상태에서 schedule에 sleepMode=true 전달', async () => {
    useSettingsStore.setState({ sleepMode: true });
    renderHook(() =>
      useBoardingLockScheduler({ lock: lockA, route, destinationName: '강남' }),
    );
    await waitFor(() => {
      expect(mockedSchedule).toHaveBeenCalledWith({
        lock: lockA,
        route,
        destinationName: '강남',
        sleepMode: true,
      });
    });
  });

  it('#632 sleepMode 토글은 effect를 재실행시키지 않는다 (ref capture)', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    useSettingsStore.setState({ sleepMode: true });
    rerender({ lock: lockA, route, destinationName: '강남' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
  });

  // #709 cold restart 회귀: lock 복원이 route보다 먼저 들어오면 같은 trainCode로 두 번째
  // effect가 돌면서 early-return 되어 영구히 schedule 되지 않는 문제. 사전 예약 알람이
  // 살아 있지 않으면 잠금화면/Focus 발사가 통째로 누락된다.
  it('#709 cold restart: lock 먼저 복원되고 route 늦게 로드돼도 schedule 1회 보장', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route: null, destinationName: '강남' });
    // 1차: lock 있지만 route=null → schedule 호출 안 됨이 정상
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSchedule).not.toHaveBeenCalled();
    // 2차: route 로드 (같은 trainCode 유지) → 이제는 schedule 1회 호출되어야 함
    rerender({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => {
      expect(mockedSchedule).toHaveBeenCalledTimes(1);
      expect(mockedSchedule).toHaveBeenCalledWith({
        lock: lockA,
        route,
        destinationName: '강남',
        sleepMode: false,
      });
    });
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('#709 cold restart: destinationName 늦게 들어와도 schedule 1회 보장', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: null as string | null });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSchedule).not.toHaveBeenCalled();
    rerender({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => {
      expect(mockedSchedule).toHaveBeenCalledTimes(1);
    });
  });

  it('#709 schedule 성공 후 동일 props 재렌더는 중복 호출 없음', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: lockA, route, destinationName: '강남' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
  });

  // #708 같은 trainCode 안에서 route/destination이 바뀌면 사전 예약된 hop이 stale 상태가 된다.
  // signature 비교로 cancel → reschedule을 강제한다.
  it('#708 같은 trainCode + route 구조 변경 시 cancel 후 reschedule', async () => {
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
      expect(mockedCancel).toHaveBeenCalledWith(lockA);
      expect(mockedSchedule).toHaveBeenCalledTimes(2);
      expect(mockedSchedule).toHaveBeenLastCalledWith({
        lock: lockA,
        route: altRoute,
        destinationName: '강남',
        sleepMode: false,
      });
    });
  });

  it('#708 같은 trainCode + destinationName 변경 시 cancel 후 reschedule', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: lockA, route, destinationName: '잠실' });
    await waitFor(() => {
      expect(mockedCancel).toHaveBeenCalledWith(lockA);
      expect(mockedSchedule).toHaveBeenCalledTimes(2);
    });
  });

  it('#708 route signature 동일 (객체만 새로 생성) → 재예약 없음', async () => {
    const sameShape = makeDirectRoute(2, '2');
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: lockA, route: sameShape, destinationName: '강남' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('#709 lock release 후 같은 trainCode로 재진입하면 다시 schedule 한다', async () => {
    const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
    await awaitFirstSchedule();
    rerender({ lock: null, route, destinationName: '강남' });
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledWith(lockA));
    rerender({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(2));
  });

  // #756 transition trace log — stale `bl:` 알람 누수 진단. effect 진입부에서 prev/next
  // trainCode + sigPrev/sigNext + decision flags를 한 줄 logger.info로 노출.
  // USB Console.app으로 trip 전환 시퀀스를 실시간 추적 가능.
  describe('#756 transition trace log', () => {
    it('lock=null 초기 마운트 — prev/next/scheduledTrain 모두 null, schedule 결정 없음', async () => {
      renderHook(() =>
        useBoardingLockScheduler({ lock: null, route, destinationName: '강남' }),
      );
      await waitFor(() => expect(mockLoggerWarn).toHaveBeenCalled());
      const traceCall = mockLoggerWarn.mock.calls.find((c) =>
        String(c[0]).startsWith('transition '),
      );
      expect(traceCall).toBeDefined();
      const line = String(traceCall![0]);
      expect(line).toContain('prevTrain=null');
      expect(line).toContain('nextTrain=null');
      expect(line).toContain('scheduledTrain=null');
      expect(line).toContain('canSchedule=false');
      expect(line).toContain('coldRestart=false');
      expect(line).toContain('routeChange=false');
    });

    it('lock A 신규 — scheduledTrain=null (아직 schedule 안 됨), coldRestart=true', async () => {
      renderHook(() =>
        useBoardingLockScheduler({ lock: lockA, route, destinationName: '강남' }),
      );
      await waitFor(() => expect(mockLoggerWarn).toHaveBeenCalled());
      const traceCall = mockLoggerWarn.mock.calls.find((c) =>
        String(c[0]).startsWith('transition '),
      );
      const line = String(traceCall![0]);
      expect(line).toContain('prevTrain=null');
      expect(line).toContain('nextTrain=A');
      // scheduledTrainCodeRef은 schedule 완료 후에야 갱신 — 첫 cycle에선 아직 null.
      expect(line).toContain('scheduledTrain=null');
      expect(line).toContain('coldRestart=true');
      expect(line).toContain('routeChange=false');
    });

    it('lock A → B 교체 — prev=A, next=B, scheduledTrain=A (직전 schedule 성공 흔적)', async () => {
      const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
      await awaitFirstSchedule();
      mockLoggerWarn.mockClear();
      rerender({ lock: lockB, route, destinationName: '강남' });
      await waitFor(() => expect(mockLoggerWarn).toHaveBeenCalled());
      const traceCall = mockLoggerWarn.mock.calls.find((c) =>
        String(c[0]).startsWith('transition '),
      );
      const line = String(traceCall![0]);
      expect(line).toContain('prevTrain=A');
      expect(line).toContain('nextTrain=B');
      // schedule 완료된 직후의 cycle이므로 scheduledTrainCodeRef = 'A'.
      expect(line).toContain('scheduledTrain=A');
    });

    it('#708 같은 trainCode + route 변경 — routeChange=true 노출', async () => {
      const transferRoute = makeTransferRoute({
        transferName: '시청',
        fromLine: '2',
        toLine: '1',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
      await awaitFirstSchedule();
      mockLoggerWarn.mockClear();
      rerender({ lock: lockA, route: transferRoute, destinationName: '강남' });
      await waitFor(() => expect(mockLoggerWarn).toHaveBeenCalled());
      const traceCall = mockLoggerWarn.mock.calls.find((c) =>
        String(c[0]).startsWith('transition '),
      );
      const line = String(traceCall![0]);
      expect(line).toContain('prevTrain=A');
      expect(line).toContain('nextTrain=A');
      expect(line).toContain('routeChange=true');
    });
  });

  // #1282 — setRegisteredBlRouteSig + clearFiredAlarms 통합 검증.
  describe('#1282 bl: route-sig 영속화 및 firedAlarms 초기화', () => {
    it('신규 lock schedule 시 setRegisteredBlRouteSig를 호출한다', async () => {
      renderHook(() =>
        useBoardingLockScheduler({ lock: lockA, route, destinationName: '강남' }),
      );
      await waitFor(() => expect(mockSetRegisteredBlRouteSig).toHaveBeenCalled());
      // routeSignature(route, '강남')는 실제 구현으로 non-null string 반환.
      expect(mockSetRegisteredBlRouteSig).toHaveBeenCalledWith(expect.any(String));
    });

    it('route-sig 변경 시 clearFiredAlarms를 호출한 후 reschedule한다 (#1282)', async () => {
      const altRoute = makeTransferRoute({
        transferName: '교대',
        fromLine: '2',
        toLine: '3',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
      await awaitFirstSchedule();
      mockedClearFiredAlarms.mockClear();
      rerender({ lock: lockA, route: altRoute, destinationName: '강남' });
      await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(2));
      expect(mockedClearFiredAlarms).toHaveBeenCalledTimes(1);
    });

    it('trainCode 변경 시에는 clearFiredAlarms를 호출하지 않는다 (route-sig 변경 아님)', async () => {
      const { rerender } = renderScheduler({ lock: lockA, route, destinationName: '강남' });
      await awaitFirstSchedule();
      mockedClearFiredAlarms.mockClear();
      rerender({ lock: lockB, route, destinationName: '강남' });
      await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(2));
      expect(mockedClearFiredAlarms).not.toHaveBeenCalled();
    });
  });
});
