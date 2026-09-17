import { renderHook, act } from '@testing-library/react-native';
import { usePrevTrainCandidate } from '../usePrevTrainCandidate';
import type { UsePrevTrainCandidateInputs } from '../usePrevTrainCandidate';
import type { ArrivalInfo } from '../../../../shared/types/arrival';
import type { Station } from '../../../../shared/types/station';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import { PREV_TRAIN_CANDIDATE_BACKSTOP_MS } from '../../../../shared/constants/eta';

const mockResolveTripDirection = jest.fn();
jest.mock('../../../route/utils/tripDirection', () => ({
  resolveTripDirection: (...args: unknown[]) => mockResolveTripDirection(...args),
}));

// #2696 — isBoardableCandidate가 관측 단계에서 상태 게이트(0/1/2)를 적용하므로, 기본 fixture도
// 그 범위 안(2=출발)으로 맞춘다. 아직 오지 않은 열차(99 등) 시나리오는 개별 테스트에서 override.
function makeTrain(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: '종착',
    arrivalMinutes: 2,
    arrivalSeconds: 120,
    statusMessage: '',
    trainCode: 'T-DEFAULT',
    line: '2',
    receivedAtMs: 0,
    arrivalCode: 2,
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

const route = makeDirectRoute(5, '2');

const baseProps: UsePrevTrainCandidateInputs = {
  route,
  destinationName: '잠실',
  currentStation,
  nextStationName: '역삼',
  line: '2',
  currentArrivals: [],
};

describe('usePrevTrainCandidate (#2689 — 다음 열차 출발 기준 만료)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockResolveTripDirection.mockReturnValue('down');
  });

  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('currentArrivals에서 trainCode가 사라지면(=출발) 그 열차를 전열차 후보로 채택한다', () => {
    jest.setSystemTime(0);
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [makeTrain({ trainCode: 'T-28MIN', arrivalSeconds: 60 })] },
    });
    expect(result.current.prevTrain).toBeNull(); // 아직 출발 전 — 목록에 있음

    // T-28MIN이 목록에서 사라짐 = 출발
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(result.current.prevTrain?.train.trainCode).toBe('T-28MIN');
    expect(result.current.prevTrain?.elapsedSeconds).toBe(0);
  });

  describe('red 재현 — 배차 2분(러시아워) 시나리오: 고정 5분 TTL이면 이미 지나간 열차가 계속 노출된다', () => {
    it('green: 다음 열차(32분)가 출발하는 즉시 전열차 후보가 28분 열차→32분 열차로 교체된다', () => {
      jest.setSystemTime(0);
      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: {
          ...baseProps,
          currentArrivals: [
            makeTrain({ trainCode: 'T-28MIN', arrivalSeconds: 30 }),
            makeTrain({ trainCode: 'T-32MIN', arrivalSeconds: 270 }),
          ],
        },
      });

      // T-28MIN 출발(사라짐) — 전열차 후보로 채택.
      act(() =>
        rerender({ ...baseProps, currentArrivals: [makeTrain({ trainCode: 'T-32MIN', arrivalSeconds: 240 })] }),
      );
      expect(result.current.prevTrain?.train.trainCode).toBe('T-28MIN');

      // 배차 2분 뒤(t=120_000) — 아직 T-32MIN은 목록에 있음(출발 전). 구현이 고정 5분 TTL이었다면
      // 5분(300_000ms)이 지나기 전까지 T-28MIN이 계속 노출됐을 것 — 하지만 실제 acceptance는
      // "다음 열차가 출발하기 전까지"이지 "5분간"이 아니다.
      act(() => jest.advanceTimersByTime(120_000));
      act(() =>
        rerender({ ...baseProps, currentArrivals: [makeTrain({ trainCode: 'T-32MIN', arrivalSeconds: 240 })] }),
      );
      expect(result.current.prevTrain?.train.trainCode).toBe('T-28MIN'); // 아직 32분 열차 출발 전 — 유지

      // T-32MIN 출발(사라짐) — 이 시점(t=120_000, 5분 TTL 도달 전)에 즉시 교체돼야 한다.
      act(() => rerender({ ...baseProps, currentArrivals: [] }));
      expect(result.current.prevTrain?.train.trainCode).toBe('T-32MIN');
      expect(result.current.prevTrain?.elapsedSeconds).toBe(0);
    });
  });

  describe('red 재현 — 배차 12분(심야) 시나리오: 고정 5분 TTL이면 5분 만에 후보가 사라진다', () => {
    it('green: 다음 열차가 출발하기 전까지(12분 내내) 전열차 후보가 유지된다', () => {
      jest.setSystemTime(0);
      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: { ...baseProps, currentArrivals: [makeTrain({ trainCode: 'T-NIGHT', arrivalSeconds: 30 })] },
      });

      act(() => rerender({ ...baseProps, currentArrivals: [] })); // 출발
      expect(result.current.prevTrain?.train.trainCode).toBe('T-NIGHT');

      // 5분(TTL이었던 값) 경과 — 구버전이면 여기서 null이 됐다.
      act(() => jest.advanceTimersByTime(5 * 60_000));
      act(() => rerender({ ...baseProps, currentArrivals: [] }));
      expect(result.current.prevTrain?.train.trainCode).toBe('T-NIGHT'); // 다음 열차가 아직 출발 안 함

      // 배차 12분 전체 경과 — 여전히 다음 열차 출발 전이면 유지.
      act(() => jest.advanceTimersByTime(7 * 60_000)); // 총 12분
      act(() => rerender({ ...baseProps, currentArrivals: [] }));
      expect(result.current.prevTrain?.train.trainCode).toBe('T-NIGHT');
      expect(result.current.prevTrain?.elapsedSeconds).toBe(12 * 60);
    });
  });

  it('#2179 회귀 — 다음역마저 통과해 도착정보 API 응답에서 완전히 사라져도(currentArrivals 자체 관측과 무관), 다음 열차가 출발하기 전까지는 탭 가능하다', () => {
    jest.setSystemTime(0);
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [makeTrain({ trainCode: 'T-PASSED-NEXT', arrivalSeconds: 20 })] },
    });

    act(() => rerender({ ...baseProps, currentArrivals: [] })); // 출발
    expect(result.current.prevTrain?.train.trainCode).toBe('T-PASSED-NEXT');

    // 다음역도 한참 통과할 시간(예: 10분) 동안 currentArrivals가 계속 비어 있어도(다음 열차 출발
    // 신호가 없으므로) 후보는 계속 탭 가능해야 한다 — TTL로 인위적 유지기간을 뒀던 구버전보다 더
    // 정확한 acceptance.
    act(() => jest.advanceTimersByTime(10 * 60_000));
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(result.current.prevTrain?.train.trainCode).toBe('T-PASSED-NEXT');
  });

  it('여러 대가 한 번에(폴링 간격 > 배차) 사라지면 마지막으로 도착 예정이었던(arrivalSeconds 최솟값) 열차를 채택한다', () => {
    jest.setSystemTime(0);
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: {
        ...baseProps,
        currentArrivals: [
          makeTrain({ trainCode: 'T-EARLIER', arrivalSeconds: 200 }),
          makeTrain({ trainCode: 'T-LATEST', arrivalSeconds: 30 }),
        ],
      },
    });

    act(() => rerender({ ...baseProps, currentArrivals: [] })); // 둘 다 사라짐
    expect(result.current.prevTrain?.train.trainCode).toBe('T-LATEST');
  });

  it('여러 대 이탈 시 min 갱신 비교의 false 분기(순서상 뒤 후보의 arrivalSeconds가 더 큰 경우)도 정상 처리한다', () => {
    jest.setSystemTime(0);
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: {
        ...baseProps,
        currentArrivals: [
          makeTrain({ trainCode: 'T-MIN-FIRST', arrivalSeconds: 20 }),
          makeTrain({ trainCode: 'T-LARGER-LATER', arrivalSeconds: 80 }),
        ],
      },
    });

    act(() => rerender({ ...baseProps, currentArrivals: [] })); // 둘 다 사라짐
    expect(result.current.prevTrain?.train.trainCode).toBe('T-MIN-FIRST');
  });

  it('trip context(출발역)가 바뀌면 전열차 후보를 즉시 무효화한다', () => {
    jest.setSystemTime(0);
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [makeTrain({ trainCode: 'T-STALE-CONTEXT', arrivalSeconds: 30 })] },
    });
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(result.current.prevTrain?.train.trainCode).toBe('T-STALE-CONTEXT');

    const newStation: Station = { ...currentStation, id: 'stn-new-origin' };
    act(() => rerender({ ...baseProps, currentStation: newStation, currentArrivals: [] }));
    expect(result.current.prevTrain).toBeNull();
  });

  it('#2656 리뷰 LOW-3 계승 — 출발역/호선/방향이 같아도 nextStationName만 바뀌면 후보를 무효화한다', () => {
    jest.setSystemTime(0);
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [makeTrain({ trainCode: 'T-OLD-NEXT', arrivalSeconds: 30 })] },
    });
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(result.current.prevTrain?.train.trainCode).toBe('T-OLD-NEXT');

    act(() => rerender({ ...baseProps, nextStationName: '삼성', currentArrivals: [] }));
    expect(result.current.prevTrain).toBeNull();
  });

  it('환승 슬롯(다른 line의 currentStation)도 동일 규칙을 재사용한다 — 복제 구현 없음', () => {
    const transferStation: Station = {
      id: 'stn-transfer',
      name: '건대입구',
      line: '7',
      lat: 37.54,
      lng: 127.07,
    } as Station;
    jest.setSystemTime(0);
    const transferProps: UsePrevTrainCandidateInputs = {
      route,
      destinationName: '잠실',
      currentStation: transferStation,
      nextStationName: '뚝섬유원지',
      line: '7',
      currentArrivals: [makeTrain({ trainCode: 'T-TRANSFER', arrivalSeconds: 30, line: '7' })],
    };
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: transferProps,
    });
    act(() => rerender({ ...transferProps, currentArrivals: [] }));
    expect(result.current.prevTrain?.train.trainCode).toBe('T-TRANSFER');
  });

  it('backstop — 다음 열차 출발 전이가 오래(PREV_TRAIN_CANDIDATE_BACKSTOP_MS) 관측되지 않으면 결국 만료된다', () => {
    jest.setSystemTime(0);
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [makeTrain({ trainCode: 'T-STUCK', arrivalSeconds: 30 })] },
    });
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(result.current.prevTrain?.train.trainCode).toBe('T-STUCK');

    act(() => jest.advanceTimersByTime(PREV_TRAIN_CANDIDATE_BACKSTOP_MS - 10_000));
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(result.current.prevTrain?.train.trainCode).toBe('T-STUCK'); // 아직 backstop 전

    act(() => jest.advanceTimersByTime(20_000));
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(result.current.prevTrain).toBeNull(); // backstop 도달
  });

  it('currentStation이 null이면 prevTrain null (게이트)', () => {
    const { result } = renderHook(() =>
      usePrevTrainCandidate({ ...baseProps, currentStation: null, currentArrivals: [] }),
    );
    expect(result.current.prevTrain).toBeNull();
  });

  it('nextStationName이 null이면 prevTrain null (게이트)', () => {
    const { result } = renderHook(() =>
      usePrevTrainCandidate({ ...baseProps, nextStationName: null, currentArrivals: [] }),
    );
    expect(result.current.prevTrain).toBeNull();
  });

  it('line이 null이면 prevTrain null (게이트)', () => {
    const { result } = renderHook(() => usePrevTrainCandidate({ ...baseProps, line: null, currentArrivals: [] }));
    expect(result.current.prevTrain).toBeNull();
  });

  it('route/destinationName이 없으면 direction 계산 없이(null) 진행 — resolveTripDirection 미호출', () => {
    renderHook(() =>
      usePrevTrainCandidate({ ...baseProps, route: null, destinationName: null, currentArrivals: [] }),
    );
    expect(mockResolveTripDirection).not.toHaveBeenCalled();
  });

  it('후보가 없으면(아무것도 출발 전이) tick interval이 등록되지 않는다', () => {
    jest.setSystemTime(0);
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [makeTrain({ trainCode: 'T-STILL-THERE', arrivalSeconds: 30 })] },
    });
    act(() => jest.advanceTimersByTime(60_000));
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('후보가 생기면 tick interval이 시작되고, backstop 만료로 후보가 사라지면 clearInterval된다', () => {
    jest.setSystemTime(0);
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const { rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [makeTrain({ trainCode: 'T-GATED', arrivalSeconds: 30 })] },
    });
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(PREV_TRAIN_CANDIDATE_BACKSTOP_MS + 10_000));
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('tick interval은 후보가 있는 상태에서 언마운트 시 정리된다', () => {
    jest.setSystemTime(0);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const { rerender, unmount } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [makeTrain({ trainCode: 'T-UNMOUNT', arrivalSeconds: 30 })] },
    });
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});

// #2696 — 공유 술어(isBoardableCandidate) 단일화. 관측 단계에만 적용하고 이탈(departed) 판정
// 단계에서는 재적용하지 않는다는 설계를 직접 검증한다(메인 세션 스펙 보강 지시).
describe('usePrevTrainCandidate (#2696 — isBoardableCandidate 관측 단계 적용)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockResolveTripDirection.mockReturnValue('down');
  });

  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // 요구사항 핵심 red 시나리오: 방향/노선/종착 모두 유효한 열차가 관측 단계를 통과해 추적
  // 대상이 된 뒤 다음 tick에 목록에서 사라지면(=정상 출발) 전열차 후보로 남아야 한다.
  // 술어를 이탈 판정에도 재적용하면 사라진 열차는 arrival 레코드가 없어(상태값 부재)
  // 항상 상태 게이트에서 탈락 — #2689가 고친 동작이 다시 죽는다.
  it('#2696 — 술어를 통과해 추적된 열차가 다음 tick에 사라지면(정상 출발) 전열차 후보로 유지된다(이탈 판정에서 술어 재적용 금지)', () => {
    jest.setSystemTime(0);
    const boardableTrain = makeTrain({ trainCode: 'T-BOARDABLE', arrivalSeconds: 30, arrivalCode: 2, line: '2' });
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [boardableTrain] },
    });
    expect(result.current.prevTrain).toBeNull(); // 아직 목록에 있음 — 출발 전

    // 다음 tick — arrival 레코드 자체가 사라짐(사라진 열차는 상태값이 없다).
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(result.current.prevTrain?.train.trainCode).toBe('T-BOARDABLE');
  });

  // 대조군: 방향이 틀린 열차는 "관측 단계"에서부터 애초에 추적 대상에 들어가지 않으므로,
  // 나중에 사라져도 전열차 후보가 되지 않는다.
  it('#2696 — 노선 불일치 열차는 관측 단계에서 배제되어, 사라져도 전열차 후보가 되지 않는다', () => {
    jest.setSystemTime(0);
    const wrongLineTrain = makeTrain({ trainCode: 'T-WRONG-LINE', arrivalSeconds: 30, arrivalCode: 2, line: '9' });
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [wrongLineTrain] },
    });
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(result.current.prevTrain).toBeNull();
  });

  // direction 미해결(resolveTripDirection이 null) — 술어가 후보 전체를 무효화한다.
  it('#2696 — direction 미해결(resolveTripDirection null)이면 후보가 관측 단계에서부터 무효화된다', () => {
    jest.setSystemTime(0);
    mockResolveTripDirection.mockReturnValue(null);
    const train = makeTrain({ trainCode: 'T-NO-DIRECTION', arrivalSeconds: 30, arrivalCode: 2, line: '2' });
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [train] },
    });
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(result.current.prevTrain).toBeNull();
  });

  // 아직 오지 않은 열차(arvlCd=99)는 상태 게이트에서 관측 단계부터 배제된다.
  it('#2696 — arvlCd=99(아직 오지 않은 열차)는 관측 단계에서 배제되어 전열차 후보가 되지 않는다', () => {
    jest.setSystemTime(0);
    const notYetTrain = makeTrain({ trainCode: 'T-NOT-YET', arrivalSeconds: 400, arrivalCode: 99, line: '2' });
    const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
      initialProps: { ...baseProps, currentArrivals: [notYetTrain] },
    });
    act(() => rerender({ ...baseProps, currentArrivals: [] }));
    expect(result.current.prevTrain).toBeNull();
  });
});
