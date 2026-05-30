import { act, renderHook } from '@testing-library/react-native';
import { useTransferTrainList, filterArrivalsByDirection } from '../useTransferTrainList';
import { useArrivalInfo } from '../useArrivalInfo';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { findStationByNameAndLine } from '../../utils/stationRoute';
import type { ArrivalInfo, StationArrival } from '../../api/arrivalApi';
import type { BoardingLock } from '../../types/boardingLock';
import type { TransferRoute } from '../../utils/stationRoute';
import type { Station } from '../../types/station';

jest.mock('../useArrivalInfo');
const mockUseArrival = useArrivalInfo as jest.Mock;

const mockCreateLock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../store/useBoardingLockStore', () => {
  const actual = jest.requireActual('../../store/useBoardingLockStore');
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
const route: TransferRoute = {
  type: 'transfer',
  transferName: '공덕',
  fromLine: '6',
  toLine: '5',
  stopsToTransfer: 2,
  stopsFromTransfer: 3,
};
const gondeokOn6 = findStationByNameAndLine('공덕', '6') as Station;

function arrivalRet(arrival: StationArrival | null) {
  return { arrival, loading: false, isMock: false };
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
});
