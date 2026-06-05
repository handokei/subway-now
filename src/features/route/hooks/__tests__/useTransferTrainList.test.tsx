import { act, renderHook } from '@testing-library/react-native';
import { useTransferTrainList, filterArrivalsByDirection } from '../useTransferTrainList';
import { prefetchArrival, useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useBoardingLockStore } from '../../../alarm/store/useBoardingLockStore';
import { findStationByNameAndLine } from '../../utils/stationRoute';
import type { ArrivalInfo, StationArrival } from '../../../arrival/api/arrivalApi';
import type { BoardingLock } from '../../../alarm/types/boardingLock';
import type { Station } from '../../../../shared/types/station';
import { makeDirectRoute, makeTransferRoute } from '../../../../testUtils/routeFixtures';

jest.mock('../../../arrival/hooks/useArrivalInfo');
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockPrefetchArrival = prefetchArrival as jest.Mock;
const mockRefetch = jest.fn();

const mockCreateLock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../alarm/store/useBoardingLockStore', () => {
  const actual = jest.requireActual('../../../alarm/store/useBoardingLockStore');
  return {
    ...actual,
    useBoardingLockStore: ((selector?: (s: { createLock: jest.Mock }) => unknown) =>
      selector ? selector({ createLock: mockCreateLock }) : { createLock: mockCreateLock }) as jest.Mock,
  };
});

const lock: BoardingLock = {
  destinationId: 'dest-X',
  trainCode: 'T-OLD',
  boardingStationId: 'stn-from',
  boardingLine: '6',
  boardedAt: 0,
  expectedDurationMs: 1_000_000,
};
const route = makeTransferRoute({
  transferName: '공덕',
  fromLine: '6',
  toLine: '5',
  stopsToTransfer: 2,
  stopsFromTransfer: 3,
});
const gondeokOn6 = findStationByNameAndLine('공덕', '6') as Station;

function arrivalRet(arrival: StationArrival | null) {
  return { arrival, loading: false, isMock: false, refetch: mockRefetch };
}

function makeTrain(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: '여의나루',
    arrivalMinutes: 5,
    arrivalSeconds: 300,
    statusMessage: '',
    trainCode: 'T-NEW',
    line: '5',
    receivedAtMs: 0,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

describe('useTransferTrainList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseArrival.mockReturnValue(arrivalRet(null));
    mockPrefetchArrival.mockResolvedValue(undefined);
  });

  it('context 미확정(currentStation=null) → context=null + arrivals=[]', () => {
    const { result } = renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: null,
      }),
    );
    expect(result.current.context).toBeNull();
    expect(result.current.arrivals).toEqual([]);
  });

  it('환승역 도달 + arrival up=2 train → arrivals 반환', () => {
    const trains = [makeTrain({ trainCode: 'T-1' }), makeTrain({ trainCode: 'T-2' })];
    mockUseArrival.mockReturnValue(arrivalRet({ up: trains, down: [] }));

    const { result } = renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(result.current.context).not.toBeNull();
    expect(result.current.context!.nextLine).toBe('5');
    // direction에 따라 up/down/양방향 합산 — 적어도 2개는 노출
    expect(result.current.arrivals.length).toBeGreaterThanOrEqual(2);
  });

  it('arrival=null이면 arrivals=[]', () => {
    mockUseArrival.mockReturnValue(arrivalRet(null));
    const { result } = renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(result.current.arrivals).toEqual([]);
  });

  it('createTransferLock 호출 → toLine 환승역 + 잔여 leg 기준 ETA로 새 lock 생성 (#604)', () => {
    mockUseArrival.mockReturnValue(arrivalRet({ up: [makeTrain({ trainCode: 'NEW' })], down: [] }));
    const { result } = renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    act(() => result.current.createTransferLock(makeTrain({ trainCode: 'NEW' })));
    // calculateRemainingLegETA(route, 0) = stopsFromTransfer(3)*MINUTES_PER_STOP(2) = 6분
    expect(mockCreateLock).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationId: 'dest-X',
        trainCode: 'NEW',
        boardingLine: '5',
        boardingStationId: (findStationByNameAndLine('공덕', '5') as Station).id,
        expectedDurationMs: 6 * 60_000,
      }),
    );
  });

  it('context 없을 때 createTransferLock 호출은 no-op', () => {
    const { result } = renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: null,
      }),
    );
    act(() => result.current.createTransferLock(makeTrain({})));
    expect(mockCreateLock).not.toHaveBeenCalled();
  });

  // #814 — 환승 imminent prefetch + transferContext 활성화 시 refetch
  describe('#814 imminent prefetch & release refetch', () => {
    it('환승 1정거장 전(imminent) → 다음 호선 arrival prefetch 트리거', () => {
      const hyochangOn6 = findStationByNameAndLine('효창공원앞', '6') as Station;
      const routeImminent = makeTransferRoute({
        transferName: '공덕',
        fromLine: '6',
        toLine: '5',
        stopsToTransfer: 1,
        stopsFromTransfer: 3,
      });
      renderHook(() =>
        useTransferTrainList({
          lock,
          route: routeImminent,
          destinationName: '여의나루',
          currentStation: hyochangOn6,
        }),
      );
      expect(mockPrefetchArrival).toHaveBeenCalledWith('공덕', '5');
    });

    it('환승역 도달 시(잔여=0)도 prefetch — context 활성화와 동시 prefetch+refetch', () => {
      renderHook(() =>
        useTransferTrainList({
          lock,
          route,
          destinationName: '여의나루',
          currentStation: gondeokOn6,
        }),
      );
      expect(mockPrefetchArrival).toHaveBeenCalledWith('공덕', '5');
    });

    it('환승 2정거장 이상 전 → prefetch 미발생', () => {
      const samgakji = findStationByNameAndLine('삼각지', '6') as Station;
      renderHook(() =>
        useTransferTrainList({
          lock,
          route,
          destinationName: '여의나루',
          currentStation: samgakji,
        }),
      );
      expect(mockPrefetchArrival).not.toHaveBeenCalled();
    });

    it('비환승 trip(direct route) → prefetch 미발생 (불필요 폴링 없음)', () => {
      const directRoute = makeDirectRoute(5, '6');
      const lockOn6 = { ...lock, boardingLine: '6' as const };
      renderHook(() =>
        useTransferTrainList({
          lock: lockOn6,
          route: directRoute,
          destinationName: '여의나루',
          currentStation: gondeokOn6,
        }),
      );
      expect(mockPrefetchArrival).not.toHaveBeenCalled();
    });

    it('lock=null → prefetch 미발생', () => {
      renderHook(() =>
        useTransferTrainList({
          lock: null,
          route,
          destinationName: '여의나루',
          currentStation: gondeokOn6,
        }),
      );
      expect(mockPrefetchArrival).not.toHaveBeenCalled();
    });

    it('transferContext 활성화 즉시 refetch 호출 — 첫 응답 앞당김', () => {
      // 초기 마운트: currentStation=null → context null → refetch 미호출
      const { rerender } = renderHook(
        (props: {
          lock: BoardingLock | null;
          currentStation: Station | null;
        }) =>
          useTransferTrainList({
            lock: props.lock,
            route,
            destinationName: '여의나루',
            currentStation: props.currentStation,
          }),
        { initialProps: { lock, currentStation: null } },
      );
      expect(mockRefetch).not.toHaveBeenCalled();

      // 환승역 도달 → context 활성화 → refetch 1회
      rerender({ lock, currentStation: gondeokOn6 });
      expect(mockRefetch).toHaveBeenCalledTimes(1);
    });

    it('transferContext 유지 중에는 추가 refetch 미발생 (re-render에 면역)', () => {
      const { rerender } = renderHook(
        (props: { currentStation: Station }) =>
          useTransferTrainList({
            lock,
            route,
            destinationName: '여의나루',
            currentStation: props.currentStation,
          }),
        { initialProps: { currentStation: gondeokOn6 } },
      );
      expect(mockRefetch).toHaveBeenCalledTimes(1);
      // 같은 currentStation으로 rerender — context 동일 → refetch 추가 호출 없음
      rerender({ currentStation: gondeokOn6 });
      expect(mockRefetch).toHaveBeenCalledTimes(1);
    });

    it('비환승 trip은 refetch도 미호출', () => {
      const directRoute = makeDirectRoute(5, '6');
      renderHook(() =>
        useTransferTrainList({
          lock,
          route: directRoute,
          destinationName: '강남',
          currentStation: gondeokOn6,
        }),
      );
      expect(mockRefetch).not.toHaveBeenCalled();
    });
  });
});

describe('filterArrivalsByDirection', () => {
  const up = makeTrain({ trainCode: 'UP' });
  const down = makeTrain({ trainCode: 'DN' });
  const arr: StationArrival = { up: [up], down: [down] };

  it('null arrival → 빈 배열', () => {
    expect(filterArrivalsByDirection(null, 'up')).toEqual([]);
  });

  it('direction=up → up만', () => {
    expect(filterArrivalsByDirection(arr, 'up')).toEqual([up]);
  });

  it('direction=down → down만', () => {
    expect(filterArrivalsByDirection(arr, 'down')).toEqual([down]);
  });

  it('direction=null → up+down 합산', () => {
    expect(filterArrivalsByDirection(arr, null)).toEqual([up, down]);
  });

  it('#666 arrivalSeconds <= 0 (지나간 열차) 제외', () => {
    const past = makeTrain({ trainCode: 'PAST', arrivalSeconds: 0 });
    const negative = makeTrain({ trainCode: 'NEG', arrivalSeconds: -30 });
    const future = makeTrain({ trainCode: 'OK', arrivalSeconds: 120 });
    const mixed: StationArrival = { up: [past, future], down: [negative] };
    expect(filterArrivalsByDirection(mixed, 'up')).toEqual([future]);
    expect(filterArrivalsByDirection(mixed, 'down')).toEqual([]);
    expect(filterArrivalsByDirection(mixed, null)).toEqual([future]);
  });
});
