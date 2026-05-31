import { renderHook, waitFor } from '@testing-library/react-native';
import { useBoardingLockScheduler } from '../useBoardingLockScheduler';
import {
  cancelAllHopsForLock,
  scheduleHopsForLock,
} from '../../utils/boardingLockScheduler';
import type { BoardingLock } from '../../types/boardingLock';
import { useAppStore } from '../../store/useAppStore';
import { makeDirectRoute, makeTransferRoute } from '../../testUtils/routeFixtures';

jest.mock('../../utils/boardingLockScheduler', () => {
  const actual = jest.requireActual('../../utils/boardingLockScheduler');
  return {
    scheduleHopsForLock: jest.fn(),
    cancelAllHopsForLock: jest.fn(),
    // routeSignature는 실제 구현을 그대로 사용 — hook이 이 결과로 변경 감지를 하므로
    // mocking하면 트레이드가 의미를 잃는다.
    routeSignature: actual.routeSignature,
  };
});
const mockLoggerError = jest.fn();
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  }),
}));

const mockedSchedule = scheduleHopsForLock as jest.MockedFunction<typeof scheduleHopsForLock>;
const mockedCancel = cancelAllHopsForLock as jest.MockedFunction<typeof cancelAllHopsForLock>;

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
  useAppStore.setState({ sleepMode: false });
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
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: null, route, destinationName: '강남' } },
    );
    rerender({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => {
      expect(mockedSchedule).toHaveBeenCalledTimes(1);
      expect(mockedCancel).not.toHaveBeenCalled();
    });
  });

  it('lock 교체(A → B): A cancel 후 B schedule', async () => {
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route, destinationName: '강남' } },
    );
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(1));
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
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route, destinationName: '강남' } },
    );
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(1));
    rerender({ lock: null, route, destinationName: '강남' });
    await waitFor(() => {
      expect(mockedCancel).toHaveBeenCalledWith(lockA);
    });
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
  });

  it('같은 trainCode로 객체만 갱신되면 재호출 안 함', async () => {
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route, destinationName: '강남' } },
    );
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(1));
    rerender({ lock: { ...lockA }, route, destinationName: '강남' });
    // wait one tick
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('lock 있지만 route 또는 destinationName 미상이면 cancel만 호출 (이전 lock 있을 때)', async () => {
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route, destinationName: '강남' } },
    );
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(1));
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
    useAppStore.setState({ sleepMode: true });
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
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route, destinationName: '강남' } },
    );
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(1));
    useAppStore.setState({ sleepMode: true });
    rerender({ lock: lockA, route, destinationName: '강남' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
  });

  // #709 cold restart 회귀: lock 복원이 route보다 먼저 들어오면 같은 trainCode로 두 번째
  // effect가 돌면서 early-return 되어 영구히 schedule 되지 않는 문제. 사전 예약 알람이
  // 살아 있지 않으면 잠금화면/Focus 발사가 통째로 누락된다.
  it('#709 cold restart: lock 먼저 복원되고 route 늦게 로드돼도 schedule 1회 보장', async () => {
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route: null, destinationName: '강남' } },
    );
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
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route, destinationName: null as string | null } },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSchedule).not.toHaveBeenCalled();
    rerender({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => {
      expect(mockedSchedule).toHaveBeenCalledTimes(1);
    });
  });

  it('#709 schedule 성공 후 동일 props 재렌더는 중복 호출 없음', async () => {
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route, destinationName: '강남' } },
    );
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(1));
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
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route, destinationName: '강남' } },
    );
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(1));
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
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route, destinationName: '강남' } },
    );
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(1));
    rerender({ lock: lockA, route, destinationName: '잠실' });
    await waitFor(() => {
      expect(mockedCancel).toHaveBeenCalledWith(lockA);
      expect(mockedSchedule).toHaveBeenCalledTimes(2);
    });
  });

  it('#708 route signature 동일 (객체만 새로 생성) → 재예약 없음', async () => {
    const sameShape = makeDirectRoute(2, '2');
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route, destinationName: '강남' } },
    );
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(1));
    rerender({ lock: lockA, route: sameShape, destinationName: '강남' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('#709 lock release 후 같은 trainCode로 재진입하면 다시 schedule 한다', async () => {
    const { rerender } = renderHook(
      (props: Parameters<typeof useBoardingLockScheduler>[0]) =>
        useBoardingLockScheduler(props),
      { initialProps: { lock: lockA, route, destinationName: '강남' } },
    );
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(1));
    rerender({ lock: null, route, destinationName: '강남' });
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledWith(lockA));
    rerender({ lock: lockA, route, destinationName: '강남' });
    await waitFor(() => expect(mockedSchedule).toHaveBeenCalledTimes(2));
  });
});
