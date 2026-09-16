import { renderHook, act } from '@testing-library/react-native';
import { usePrevTrainCandidate } from '../usePrevTrainCandidate';
import type { UsePrevTrainCandidateInputs } from '../usePrevTrainCandidate';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { Station } from '../../../../shared/types/station';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import { PREV_TRAIN_CANDIDATE_TTL_MS } from '../../../../shared/constants/eta';

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

  describe('#2179 — 다음역마저 통과해 candidate pool이 0으로 떨어져도 TTL 내에는 직전 후보를 유지', () => {
    const baseProps: UsePrevTrainCandidateInputs = {
      route,
      destinationName: '잠실',
      currentStation,
      nextStationName: nextStation.name,
      line: '2',
      currentArrivals: [],
    };

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      act(() => jest.runOnlyPendingTimers());
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('탑승 열차가 다음역도 통과해 pool이 비면(candidates=0) 직전 후보를 캐시에서 반환하고, 빈 폴링이 반복돼도 유지된다', () => {
      jest.setSystemTime(1_000_000);
      mockUseArrival.mockReturnValue(
        arrivalRet({ up: [], down: [makeTrain({ trainCode: 'T-DEPARTED', arrivalSeconds: 30 })] }),
      );

      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: baseProps,
      });
      expect(result.current.prevTrain?.train.trainCode).toBe('T-DEPARTED');
      // stopSeconds(150) - arrivalSeconds(30) = 120
      expect(result.current.prevTrain?.elapsedSeconds).toBe(120);

      // 1차 빈 폴링 — 열차가 다음역마저 통과, pool에서 완전히 사라짐(candidates=0)
      mockUseArrival.mockReturnValue(arrivalRet({ up: [], down: [] }));
      act(() => rerender(baseProps));
      expect(result.current.prevTrain?.train.trainCode).toBe('T-DEPARTED');

      act(() => jest.advanceTimersByTime(30_000));
      act(() => rerender(baseProps));
      expect(result.current.prevTrain?.train.trainCode).toBe('T-DEPARTED');
      expect(result.current.prevTrain?.elapsedSeconds).toBe(150); // 120 + 30

      // 2차 빈 폴링(freshCandidate가 연속으로 null인 케이스 재현) — 여전히 캐시 유지.
      act(() => rerender(baseProps));
      expect(result.current.prevTrain?.train.trainCode).toBe('T-DEPARTED');
    });

    it('빈 폴링을 여러 차례 거친 뒤 TTL(PREV_TRAIN_CANDIDATE_TTL_MS) 경과 시 캐시도 만료되어 null — #2656 리뷰 회귀 가드 (freshCandidate/contextKey만으로는 만료 분기가 재실행되지 않던 버그 재현)', () => {
      jest.setSystemTime(2_000_000);
      mockUseArrival.mockReturnValue(
        arrivalRet({ up: [], down: [makeTrain({ trainCode: 'T-EXPIRING', arrivalSeconds: 30 })] }),
      );

      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: baseProps,
      });
      expect(result.current.prevTrain?.train.trainCode).toBe('T-EXPIRING');

      // 이후 모든 폴링에서 pool이 비어있음 — freshCandidate/contextKey는 이 시퀀스 내내 각각
      // null/동일 key로 고정된다(구코드가 만료를 감지하지 못하던 정확한 조건). 이 케이스는 최초
      // 목격과 마지막 목격이 동일 시각(첫 폴링에서 딱 한 번만 관측)이라 last-seen 기준 TTL과
      // first-seen 기준 TTL이 우연히 일치 — 순수 "만료 재실행" 회귀만 검증한다.
      mockUseArrival.mockReturnValue(arrivalRet({ up: [], down: [] }));

      const pollStepMs = 60_000;
      const stepsBeforeTtl = Math.floor(PREV_TRAIN_CANDIDATE_TTL_MS / pollStepMs) - 1;
      // TTL 도달 전 — 빈 폴링을 여러 차례 거쳐도 캐시 유지.
      for (let i = 0; i < stepsBeforeTtl; i += 1) {
        act(() => jest.advanceTimersByTime(pollStepMs));
        act(() => rerender(baseProps));
      }
      expect(result.current.prevTrain?.train.trainCode).toBe('T-EXPIRING');

      // TTL을 확실히 초과하는 추가 경과.
      const remainingToExceedTtl = PREV_TRAIN_CANDIDATE_TTL_MS - stepsBeforeTtl * pollStepMs + pollStepMs;
      act(() => jest.advanceTimersByTime(remainingToExceedTtl));
      act(() => rerender(baseProps));

      expect(result.current.prevTrain).toBeNull();
    });

    it('#2656 리뷰 MEDIUM-1 회귀 — TTL 시계는 최초 목격이 아니라 마지막 목격 시각부터 흐른다', () => {
      // 도착정보 API 특성상 "떠난 열차"가 다음역 도착목록에 보통 2~2.5분간 계속 관측된다(매 폴링마다
      // 새 arrival 참조). 이 구간 동안 cachedAt이 최초 목격 시각에 고정되면(구버전 버그), pool이
      // 실제로 비어 캐시가 "쓰이기 시작"하는 시점엔 이미 TTL의 상당 부분이 소진돼 있다.
      jest.setSystemTime(0);
      mockUseArrival.mockReturnValue(
        arrivalRet({ up: [], down: [makeTrain({ trainCode: 'T-LINGER', arrivalSeconds: 30 })] }),
      );
      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: baseProps,
      });
      expect(result.current.prevTrain?.train.trainCode).toBe('T-LINGER'); // t=0, 최초 목격

      act(() => jest.advanceTimersByTime(60_000)); // t=60_000
      mockUseArrival.mockReturnValue(
        arrivalRet({ up: [], down: [makeTrain({ trainCode: 'T-LINGER', arrivalSeconds: 25 })] }),
      );
      act(() => rerender(baseProps));
      expect(result.current.prevTrain?.train.trainCode).toBe('T-LINGER');

      act(() => jest.advanceTimersByTime(60_000)); // t=120_000 — 마지막 실제 목격 시각
      mockUseArrival.mockReturnValue(
        arrivalRet({ up: [], down: [makeTrain({ trainCode: 'T-LINGER', arrivalSeconds: 20 })] }),
      );
      act(() => rerender(baseProps));
      expect(result.current.prevTrain?.train.trainCode).toBe('T-LINGER');

      // 다음역마저 통과 — pool에서 사라짐(t=130_000 폴링)
      act(() => jest.advanceTimersByTime(10_000)); // t=130_000
      mockUseArrival.mockReturnValue(arrivalRet({ up: [], down: [] }));
      act(() => rerender(baseProps));
      expect(result.current.prevTrain?.train.trainCode).toBe('T-LINGER'); // 캐시로 유지 시작

      // t=350_000 — "최초 목격(t=0)" 기준 TTL(5분)이라면 t=300_000에 이미 만료됐어야 하지만,
      // "마지막 목격(t=120_000)" 기준이면 만료 시각은 t=420_000이라 아직 유효해야 한다.
      act(() => jest.advanceTimersByTime(220_000));
      act(() => rerender(baseProps));
      expect(result.current.prevTrain?.train.trainCode).toBe('T-LINGER');

      // t=430_000 — 마지막 목격(120_000) 기준으로도 TTL을 넘겨 결국 만료된다(무한 캐시 아님).
      act(() => jest.advanceTimersByTime(80_000));
      act(() => rerender(baseProps));
      expect(result.current.prevTrain).toBeNull();
    });

    it('trip context(출발역)가 바뀌면 이전 캐시를 즉시 무효화한다', () => {
      jest.setSystemTime(3_000_000);
      mockUseArrival.mockReturnValue(
        arrivalRet({ up: [], down: [makeTrain({ trainCode: 'T-STALE-CONTEXT', arrivalSeconds: 30 })] }),
      );

      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: baseProps,
      });
      expect(result.current.prevTrain?.train.trainCode).toBe('T-STALE-CONTEXT');

      const newStation: Station = { ...currentStation, id: 'stn-new-origin' };
      mockUseArrival.mockReturnValue(arrivalRet({ up: [], down: [] }));
      act(() => jest.advanceTimersByTime(10_000));
      act(() => rerender({ ...baseProps, currentStation: newStation }));

      expect(result.current.prevTrain).toBeNull();
    });

    it('#2656 리뷰 LOW-3 — 출발역/호선/방향이 같아도 nextStationName만 바뀌면 캐시를 무효화한다', () => {
      jest.setSystemTime(3_500_000);
      mockUseArrival.mockReturnValue(
        arrivalRet({ up: [], down: [makeTrain({ trainCode: 'T-OLD-NEXT', arrivalSeconds: 30 })] }),
      );

      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: baseProps,
      });
      expect(result.current.prevTrain?.train.trainCode).toBe('T-OLD-NEXT');

      const otherNextStation: Station = { ...nextStation, id: 'stn-other-next', name: '삼성' };
      mockFindStationByNameAndLine.mockReturnValue(otherNextStation);
      mockUseArrival.mockReturnValue(arrivalRet({ up: [], down: [] }));
      act(() => jest.advanceTimersByTime(10_000));
      act(() => rerender({ ...baseProps, nextStationName: otherNextStation.name }));

      expect(result.current.prevTrain).toBeNull();
    });

    it('신선한 candidate가 다시 나타나면 캐시된 오래된 후보 대신 최신 candidate로 갱신한다', () => {
      jest.setSystemTime(4_000_000);
      mockUseArrival.mockReturnValue(
        arrivalRet({ up: [], down: [makeTrain({ trainCode: 'T-OLD', arrivalSeconds: 30 })] }),
      );
      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: baseProps,
      });
      expect(result.current.prevTrain?.train.trainCode).toBe('T-OLD');

      mockUseArrival.mockReturnValue(
        arrivalRet({ up: [], down: [makeTrain({ trainCode: 'T-NEW-FRESH', arrivalSeconds: 20 })] }),
      );
      act(() => jest.advanceTimersByTime(30_000));
      act(() => rerender(baseProps));

      expect(result.current.prevTrain?.train.trainCode).toBe('T-NEW-FRESH');
    });

    it('#2656 리뷰 — 캐시가 없으면(candidate 산출 자체가 없으면) tick interval이 아예 등록되지 않는다', () => {
      jest.setSystemTime(7_000_000);
      mockUseArrival.mockReturnValue(arrivalRet({ up: [], down: [] }));
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: baseProps,
      });
      act(() => jest.advanceTimersByTime(60_000));

      expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it('#2656 리뷰 — 캐시가 생기면 tick interval이 시작되고, TTL 만료로 캐시가 사라지면 clearInterval된다', () => {
      jest.setSystemTime(8_000_000);
      mockUseArrival.mockReturnValue(
        arrivalRet({ up: [], down: [makeTrain({ trainCode: 'T-GATED', arrivalSeconds: 30 })] }),
      );
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: baseProps,
      });
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy).not.toHaveBeenCalled();

      act(() => jest.advanceTimersByTime(PREV_TRAIN_CANDIDATE_TTL_MS + 10_000));

      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('TTL tick interval은 캐시가 있는 상태에서 언마운트 시 정리된다', () => {
      jest.setSystemTime(9_000_000);
      mockUseArrival.mockReturnValue(
        arrivalRet({ up: [], down: [makeTrain({ trainCode: 'T-UNMOUNT', arrivalSeconds: 30 })] }),
      );
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      const { unmount } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: baseProps,
      });
      unmount();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });
});
