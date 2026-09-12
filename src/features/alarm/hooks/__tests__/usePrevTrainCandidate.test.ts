import { renderHook } from '@testing-library/react-native';
import { usePrevTrainCandidate } from '../usePrevTrainCandidate';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { Station } from '../../../../shared/types/station';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';

jest.mock('../../../arrival/hooks/useArrivalInfo');
const mockUseArrival = useArrivalInfo as jest.Mock;

const mockResolveTripDirection = jest.fn();
jest.mock('../../../route/utils/tripDirection', () => ({
  resolveTripDirection: (...args: unknown[]) => mockResolveTripDirection(...args),
}));

const mockFindStationByNameAndLine = jest.fn();
const mockGetStopSeconds = jest.fn();
jest.mock('../../../../shared/utils/stationRoute', () => ({
  findStationByNameAndLine: (...args: unknown[]) => mockFindStationByNameAndLine(...args),
  getStopSeconds: (...args: unknown[]) => mockGetStopSeconds(...args),
}));

function arrivalRet(arrival: StationArrival | null, loading = false) {
  return { arrival, loading, isMock: false, refetch: jest.fn() };
}

function makeTrain(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: '종착',
    arrivalMinutes: 2,
    arrivalSeconds: 120,
    statusMessage: '',
    trainCode: 'T-NEW',
    line: '2',
    receivedAtMs: 0,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

const currentStation: Station = {
  id: 'stn-current',
  name: '강남',
  line: '2',
  lat: 37.497,
  lng: 127.027,
} as Station;

const nextStation: Station = {
  id: 'stn-next',
  name: '역삼',
  line: '2',
  lat: 37.5,
  lng: 127.036,
} as Station;

const route = makeDirectRoute(5, '2');

describe('usePrevTrainCandidate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseArrival.mockReturnValue(arrivalRet(null));
    mockResolveTripDirection.mockReturnValue('down');
    mockFindStationByNameAndLine.mockReturnValue(nextStation);
    mockGetStopSeconds.mockReturnValue(150);
  });

  it('다음역 도착 목록에서 출발역 목록에 없는 동일 line/방향 열차 중 최소 ETA를 전열차로 채택한다', () => {
    const currentArrivals = [makeTrain({ trainCode: 'T-STILL-AT-ORIGIN', arrivalSeconds: 200 })];
    const nextArrival: StationArrival = {
      up: [],
      down: [
        makeTrain({ trainCode: 'T-DEPARTED-FAR', arrivalSeconds: 90 }),
        makeTrain({ trainCode: 'T-DEPARTED-CLOSE', arrivalSeconds: 30 }),
        makeTrain({ trainCode: 'T-STILL-AT-ORIGIN', arrivalSeconds: 250 }), // 출발역 목록에도 있음 → 제외
      ],
    };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals,
      }),
    );

    expect(result.current.prevTrain?.train.trainCode).toBe('T-DEPARTED-CLOSE');
    // stopSeconds(150) - arrivalSeconds(30) = 120
    expect(result.current.prevTrain?.elapsedSeconds).toBe(120);
  });

  it('candidate가 이미 최소인 상태에서 뒤 순서 후보가 더 크면 기존 min을 유지한다', () => {
    // reduce 비교의 false 분기(cur.arrivalSeconds < min.arrivalSeconds가 거짓) 커버.
    const nextArrival: StationArrival = {
      up: [],
      down: [
        makeTrain({ trainCode: 'T-MIN-FIRST', arrivalSeconds: 20 }),
        makeTrain({ trainCode: 'T-LARGER-LATER', arrivalSeconds: 80 }),
      ],
    };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain?.train.trainCode).toBe('T-MIN-FIRST');
  });

  it('음수 elapsedSeconds는 0으로 clamp한다', () => {
    mockGetStopSeconds.mockReturnValue(60);
    const nextArrival: StationArrival = {
      up: [],
      down: [makeTrain({ trainCode: 'T-DEPARTED', arrivalSeconds: 200 })],
    };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain?.elapsedSeconds).toBe(0);
  });

  it('direction이 up이면 up 버킷만 candidate pool로 사용한다', () => {
    mockResolveTripDirection.mockReturnValue('up');
    const nextArrival: StationArrival = {
      up: [makeTrain({ trainCode: 'T-UP', arrivalSeconds: 40 })],
      down: [makeTrain({ trainCode: 'T-DOWN', arrivalSeconds: 10 })],
    };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain?.train.trainCode).toBe('T-UP');
  });

  it('direction을 알 수 없으면(null) up+down 합집합에서 채택한다', () => {
    mockResolveTripDirection.mockReturnValue(null);
    const nextArrival: StationArrival = {
      up: [makeTrain({ trainCode: 'T-UP', arrivalSeconds: 40 })],
      down: [makeTrain({ trainCode: 'T-DOWN', arrivalSeconds: 10 })],
    };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain?.train.trainCode).toBe('T-DOWN');
  });

  it('다른 line 열차는 후보에서 제외한다', () => {
    const nextArrival: StationArrival = {
      up: [],
      down: [makeTrain({ trainCode: 'T-OTHER-LINE', arrivalSeconds: 20, line: '5' })],
    };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain).toBeNull();
  });

  it('이미 지나간(arrivalSeconds < 0) 열차는 후보에서 제외한다', () => {
    const nextArrival: StationArrival = {
      up: [],
      down: [makeTrain({ trainCode: 'T-PASSED', arrivalSeconds: -5 })],
    };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain).toBeNull();
  });

  it('후보가 없으면 null', () => {
    const nextArrival: StationArrival = { up: [], down: [] };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain).toBeNull();
  });

  it('arrival이 아직 null이면(첫 폴링 전) prevTrain null', () => {
    mockUseArrival.mockReturnValue(arrivalRet(null, true));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('currentStation이 null이면 prevTrain null (route/destination 유무와 무관)', () => {
    const nextArrival: StationArrival = { up: [], down: [makeTrain({ trainCode: 'T-X', arrivalSeconds: 10 })] };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation: null,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain).toBeNull();
  });

  it('nextStationName이 null이면 prevTrain null', () => {
    const nextArrival: StationArrival = { up: [], down: [makeTrain({ trainCode: 'T-X', arrivalSeconds: 10 })] };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: null,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain).toBeNull();
  });

  it('line이 null이면 prevTrain null', () => {
    const nextArrival: StationArrival = { up: [], down: [makeTrain({ trainCode: 'T-X', arrivalSeconds: 10 })] };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: nextStation.name,
        line: null,
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain).toBeNull();
  });

  it('nextStation lookup 실패(findStationByNameAndLine이 undefined 반환) 시 prevTrain null', () => {
    mockFindStationByNameAndLine.mockReturnValue(undefined);
    const nextArrival: StationArrival = { up: [], down: [makeTrain({ trainCode: 'T-X', arrivalSeconds: 10 })] };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain).toBeNull();
  });

  it('#2179 — 환승역(origin과 다른 line) currentStation을 넘겨도 동일하게 전열차를 산출한다 (재사용 검증, 복제 구현 없음)', () => {
    const transferStation: Station = {
      id: 'stn-transfer',
      name: '건대입구',
      line: '7',
      lat: 37.54,
      lng: 127.07,
    } as Station;
    const transferNextStation: Station = {
      id: 'stn-transfer-next',
      name: '뚝섬유원지',
      line: '7',
      lat: 37.531,
      lng: 127.066,
    } as Station;
    mockFindStationByNameAndLine.mockReturnValue(transferNextStation);
    const nextArrival: StationArrival = {
      up: [],
      down: [makeTrain({ trainCode: 'T-TRANSFER-DEPARTED', arrivalSeconds: 30, line: '7' })],
    };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    const { result } = renderHook(() =>
      usePrevTrainCandidate({
        route,
        destinationName: '잠실',
        currentStation: transferStation,
        nextStationName: transferNextStation.name,
        line: '7',
        currentArrivals: [],
      }),
    );

    expect(result.current.prevTrain?.train.trainCode).toBe('T-TRANSFER-DEPARTED');
  });

  it('route/destinationName이 없으면 direction 계산 없이(null) 진행 — resolveTripDirection 미호출', () => {
    const nextArrival: StationArrival = { up: [], down: [makeTrain({ trainCode: 'T-X', arrivalSeconds: 10 })] };
    mockUseArrival.mockReturnValue(arrivalRet(nextArrival));

    renderHook(() =>
      usePrevTrainCandidate({
        route: null,
        destinationName: null,
        currentStation,
        nextStationName: nextStation.name,
        line: '2',
        currentArrivals: [],
      }),
    );

    expect(mockResolveTripDirection).not.toHaveBeenCalled();
  });
});
