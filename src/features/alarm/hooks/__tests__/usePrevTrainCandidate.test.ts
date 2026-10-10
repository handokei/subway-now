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

  // #2697 red — 이전에는 시각 개념 자체가 없었다(elapsedSeconds만 존재). 사라진 뒤에도
  // 마지막 관측(목록에 있던 마지막 tick)의 receivedAtMs+arrivalSeconds*1000이 stamp되어
  // 유지되는지 검증한다. "사라진 시각"(detectedAtMs)으로 대체되면 이 값과 달라진다.
  describe('#2697 — 출발한 열차의 도착 시각 stamp', () => {
    it('목록에 있던 마지막 관측(receivedAtMs+arrivalSeconds*1000)이 사라진 뒤에도 stamp로 유지된다', () => {
      jest.setSystemTime(0);
      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: {
          ...baseProps,
          currentArrivals: [
            makeTrain({ trainCode: 'T-STAMP', arrivalSeconds: 20, receivedAtMs: 100_000 }),
          ],
        },
      });
      expect(result.current.prevTrain).toBeNull();

      // 5초 뒤(detectedAtMs가 stamp로 쓰이면 안 됨을 구분하기 위해 시간 이동) 열차가 사라짐.
      act(() => jest.advanceTimersByTime(5_000));
      act(() => rerender({ ...baseProps, currentArrivals: [] }));

      expect(result.current.prevTrain?.train.trainCode).toBe('T-STAMP');
      // stamp = 마지막 관측의 receivedAtMs(100_000) + arrivalSeconds(20)*1000 = 120_000.
      // "사라진 시각"(detectedAtMs=5_000)으로 대체됐다면 이 값이 아니게 된다.
      expect(result.current.prevTrain?.arrivedAtMs).toBe(120_000);

      // 시간이 더 흘러도(elapsedSeconds는 증가) stamp 자체는 재계산되지 않고 고정 유지된다.
      act(() => jest.advanceTimersByTime(30_000));
      act(() => rerender({ ...baseProps, currentArrivals: [] }));
      expect(result.current.prevTrain?.arrivedAtMs).toBe(120_000);
    });

    it('열차가 목록에 있는 동안 갱신되는 관측 중 마지막(사라지기 직전) 값이 stamp된다', () => {
      jest.setSystemTime(0);
      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: {
          ...baseProps,
          currentArrivals: [
            makeTrain({ trainCode: 'T-UPDATED', arrivalSeconds: 200, receivedAtMs: 1_000, arrivalCode: 0 }),
          ],
        },
      });

      // 다음 폴 — 같은 열차가 arrivalCode 도착(1)에 가까워지며 최신 관측으로 갱신됨.
      act(() =>
        rerender({
          ...baseProps,
          currentArrivals: [
            makeTrain({ trainCode: 'T-UPDATED', arrivalSeconds: 5, receivedAtMs: 195_000, arrivalCode: 1 }),
          ],
        }),
      );
      // 그 다음 폴에서 출발(사라짐) — 위 최신 관측이 stamp돼야 한다(첫 관측 값이 아니라).
      act(() => rerender({ ...baseProps, currentArrivals: [] }));

      expect(result.current.prevTrain?.train.trainCode).toBe('T-UPDATED');
      // 마지막 관측 stamp = 195_000 + 5*1000 = 200_000. 첫 관측(1_000+200_000=201_000)이 아님.
      expect(result.current.prevTrain?.arrivedAtMs).toBe(200_000);
    });

    it('마지막 관측의 receivedAtMs=0(mock/누락)이면 stamp 불가 — arrivedAtMs null (degrade, 크래시 없음)', () => {
      jest.setSystemTime(0);
      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: {
          ...baseProps,
          currentArrivals: [makeTrain({ trainCode: 'T-NO-RECEIVED', arrivalSeconds: 20, receivedAtMs: 0 })],
        },
      });
      act(() => rerender({ ...baseProps, currentArrivals: [] }));

      expect(result.current.prevTrain?.train.trainCode).toBe('T-NO-RECEIVED');
      expect(result.current.prevTrain?.arrivedAtMs).toBeNull();
    });

    // #2689 회귀 — 다음 열차가 출발하는 순간 전열차 후보가 교체될 때, stamp도 새 후보 기준으로
    // 갱신되어야 한다(옛 stamp가 새 trainCode에 잘못 붙어 남아있지 않아야 한다).
    it('다음 열차가 출발하면 전열차 후보와 함께 stamp도 새 열차 기준으로 교체된다 (#2689 회귀)', () => {
      jest.setSystemTime(0);
      const { result, rerender } = renderHook((props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props), {
        initialProps: {
          ...baseProps,
          currentArrivals: [
            makeTrain({ trainCode: 'T-28MIN', arrivalSeconds: 30, receivedAtMs: 1_000 }),
            makeTrain({ trainCode: 'T-32MIN', arrivalSeconds: 270, receivedAtMs: 1_000 }),
          ],
        },
      });

      act(() =>
        rerender({
          ...baseProps,
          currentArrivals: [makeTrain({ trainCode: 'T-32MIN', arrivalSeconds: 240, receivedAtMs: 31_000 })],
        }),
      );
      expect(result.current.prevTrain?.train.trainCode).toBe('T-28MIN');
      expect(result.current.prevTrain?.arrivedAtMs).toBe(1_000 + 30 * 1000);

      // T-32MIN 출발(사라짐) — 후보와 stamp 모두 T-32MIN 기준으로 교체.
      act(() => rerender({ ...baseProps, currentArrivals: [] }));
      expect(result.current.prevTrain?.train.trainCode).toBe('T-32MIN');
      expect(result.current.prevTrain?.arrivedAtMs).toBe(31_000 + 240 * 1000);
    });
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
