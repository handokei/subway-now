import { renderHook, waitFor } from '@testing-library/react-native';
import { useBoardingLockScheduler } from '../useBoardingLockScheduler';
import {
  cancelAllHopsForLock,
  scheduleHopsForLock,
} from '../../utils/boardingLockScheduler';
import type { BoardingLock } from '../../types/boardingLock';
import { useAppStore } from '../../store/useAppStore';
import { makeDirectRoute } from '../../testUtils/routeFixtures';

jest.mock('../../utils/boardingLockScheduler', () => ({
  scheduleHopsForLock: jest.fn(),
  cancelAllHopsForLock: jest.fn(),
}));
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
});
