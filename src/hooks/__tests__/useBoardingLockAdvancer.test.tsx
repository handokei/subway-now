import { renderHook, waitFor } from '@testing-library/react-native';
import { useBoardingLockAdvancer } from '../useBoardingLockAdvancer';
import { advanceHopWindow } from '../../utils/boardingLockScheduler';
import type { BoardingLock } from '../../types/boardingLock';
import type { DirectRoute, TransferRoute } from '../../utils/stationRoute';
import { useAppStore } from '../../store/useAppStore';

jest.mock('../../utils/boardingLockScheduler', () => ({
  advanceHopWindow: jest.fn(),
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

const mockedAdvance = advanceHopWindow as jest.MockedFunction<typeof advanceHopWindow>;

const lockA: BoardingLock = {
  destinationId: 'd',
  trainCode: 'A',
  boardingStationId: 's',
  boardingLine: '2',
  boardedAt: 1,
  expectedDurationMs: 1000,
};
const lockB: BoardingLock = { ...lockA, trainCode: 'B' };

const directRoute: DirectRoute = { type: 'direct', stops: 2, line: '2' };
const transferRoute: TransferRoute = {
  type: 'transfer',
  transferName: '사당',
  fromLine: '2',
  toLine: '4',
  stopsToTransfer: 3,
  stopsFromTransfer: 4,
};

type Props = Parameters<typeof useBoardingLockAdvancer>[0];

beforeEach(() => {
  jest.clearAllMocks();
  mockedAdvance.mockResolvedValue(undefined);
  useAppStore.setState({ sleepMode: false });
});

describe('useBoardingLockAdvancer', () => {
  it('lock=null이면 currentStationName이 waypoint여도 호출 안 함', async () => {
    renderHook(() =>
      useBoardingLockAdvancer({
        lock: null,
        route: directRoute,
        destinationName: '강남',
        currentStationName: '강남',
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedAdvance).not.toHaveBeenCalled();
  });

  it('route=null이면 호출 안 함', async () => {
    renderHook(() =>
      useBoardingLockAdvancer({
        lock: lockA,
        route: null,
        destinationName: '강남',
        currentStationName: '강남',
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedAdvance).not.toHaveBeenCalled();
  });

  it('destinationName=null이면 호출 안 함', async () => {
    renderHook(() =>
      useBoardingLockAdvancer({
        lock: lockA,
        route: directRoute,
        destinationName: null,
        currentStationName: '강남',
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedAdvance).not.toHaveBeenCalled();
  });

  it('currentStationName=null이면 호출 안 함', async () => {
    renderHook(() =>
      useBoardingLockAdvancer({
        lock: lockA,
        route: directRoute,
        destinationName: '강남',
        currentStationName: null,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedAdvance).not.toHaveBeenCalled();
  });

  it('현재역이 waypoint와 매칭되지 않으면 호출 안 함', async () => {
    renderHook(() =>
      useBoardingLockAdvancer({
        lock: lockA,
        route: directRoute,
        destinationName: '강남',
        currentStationName: '역삼',
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedAdvance).not.toHaveBeenCalled();
  });

  it('도착역 waypoint 도달 시 advanceHopWindow를 호출', async () => {
    renderHook(() =>
      useBoardingLockAdvancer({
        lock: lockA,
        route: directRoute,
        destinationName: '강남',
        currentStationName: '강남',
      }),
    );
    await waitFor(() => {
      expect(mockedAdvance).toHaveBeenCalledWith({
        lock: lockA,
        route: directRoute,
        destinationName: '강남',
        passedStationName: '강남',
        sleepMode: false,
      });
    });
  });

  it('환승역 waypoint 도달 시 호출', async () => {
    renderHook(() =>
      useBoardingLockAdvancer({
        lock: lockA,
        route: transferRoute,
        destinationName: '명동',
        currentStationName: '사당',
      }),
    );
    await waitFor(() => {
      expect(mockedAdvance).toHaveBeenCalledWith({
        lock: lockA,
        route: transferRoute,
        destinationName: '명동',
        passedStationName: '사당',
        sleepMode: false,
      });
    });
  });

  it('같은 waypoint가 다시 들어와도 중복 호출 안 함', async () => {
    const { rerender } = renderHook(
      (props: Props) => useBoardingLockAdvancer(props),
      {
        initialProps: {
          lock: lockA,
          route: directRoute,
          destinationName: '강남',
          currentStationName: '강남',
        },
      },
    );
    await waitFor(() => expect(mockedAdvance).toHaveBeenCalledTimes(1));
    // 동일 waypoint로 currentStationName이 다시 들어오는 케이스 — GPS churn 등.
    // useEffect deps 변동을 강제하려면 객체 ref 변경 필요 — route 객체를 같은 내용으로 재할당.
    rerender({
      lock: lockA,
      route: { ...directRoute },
      destinationName: '강남',
      currentStationName: '강남',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedAdvance).toHaveBeenCalledTimes(1);
  });

  it('다음 waypoint로 이동하면 호출이 다시 발생', async () => {
    const { rerender } = renderHook(
      (props: Props) => useBoardingLockAdvancer(props),
      {
        initialProps: {
          lock: lockA,
          route: transferRoute,
          destinationName: '명동',
          currentStationName: '사당',
        },
      },
    );
    await waitFor(() => expect(mockedAdvance).toHaveBeenCalledTimes(1));
    rerender({
      lock: lockA,
      route: transferRoute,
      destinationName: '명동',
      currentStationName: '명동',
    });
    await waitFor(() => expect(mockedAdvance).toHaveBeenCalledTimes(2));
    expect(mockedAdvance).toHaveBeenLastCalledWith({
      lock: lockA,
      route: transferRoute,
      destinationName: '명동',
      passedStationName: '명동',
      sleepMode: false,
    });
  });

  it('trainCode 변경 시 중복 추적 ref가 초기화되어 같은 이름도 다시 호출', async () => {
    const { rerender } = renderHook(
      (props: Props) => useBoardingLockAdvancer(props),
      {
        initialProps: {
          lock: lockA,
          route: directRoute,
          destinationName: '강남',
          currentStationName: '강남',
        },
      },
    );
    await waitFor(() => expect(mockedAdvance).toHaveBeenCalledTimes(1));
    rerender({
      lock: lockB,
      route: directRoute,
      destinationName: '강남',
      currentStationName: '강남',
    });
    await waitFor(() => expect(mockedAdvance).toHaveBeenCalledTimes(2));
    expect(mockedAdvance).toHaveBeenLastCalledWith({
      lock: lockB,
      route: directRoute,
      destinationName: '강남',
      passedStationName: '강남',
      sleepMode: false,
    });
  });

  it('isSameStationName 정규화로 매칭 — 매칭된 target.name이 전달됨', async () => {
    // 도착역명은 짧은 표기, 현재역명은 노선별 부제 포함. normalizeStationName이 부제를 떼고 매칭.
    renderHook(() =>
      useBoardingLockAdvancer({
        lock: lockA,
        route: directRoute,
        destinationName: '상봉',
        currentStationName: '상봉(시외버스터미널)',
      }),
    );
    await waitFor(() => {
      expect(mockedAdvance).toHaveBeenCalledWith({
        lock: lockA,
        route: directRoute,
        destinationName: '상봉',
        // resolveAllTargets가 보유한 정식 이름(=destinationName 그대로)을 전달.
        passedStationName: '상봉',
        sleepMode: false,
      });
    });
  });

  it('#632 sleepMode=true 상태에서 advance 호출에 sleepMode=true 전달', async () => {
    useAppStore.setState({ sleepMode: true });
    renderHook(() =>
      useBoardingLockAdvancer({
        lock: lockA,
        route: transferRoute,
        destinationName: '명동',
        currentStationName: '사당',
      }),
    );
    await waitFor(() => {
      expect(mockedAdvance).toHaveBeenCalledWith({
        lock: lockA,
        route: transferRoute,
        destinationName: '명동',
        passedStationName: '사당',
        sleepMode: true,
      });
    });
  });

  it('advanceHopWindow rejection은 logger.error로 기록되고 throw 없음', async () => {
    mockedAdvance.mockRejectedValueOnce(new Error('boom'));
    renderHook(() =>
      useBoardingLockAdvancer({
        lock: lockA,
        route: directRoute,
        destinationName: '강남',
        currentStationName: '강남',
      }),
    );
    await waitFor(() => {
      expect(mockLoggerError).toHaveBeenCalledWith('advanceHopWindow 실패:', expect.any(Error));
    });
  });
});
