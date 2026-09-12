/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { act, renderHook } from '@testing-library/react-native';
import { useTransferTrainList, filterArrivalsByDirection } from '../useTransferTrainList';
import { prefetchArrival, useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useBoardingLockStore } from '../../../alarm/store/useBoardingLockStore';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { Station } from '../../../../shared/types/station';
import { makeDirectRoute, makeTransferRoute } from '../../../../testUtils/routeFixtures';

jest.mock('../../../arrival/hooks/useArrivalInfo');
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockPrefetchArrival = prefetchArrival as jest.Mock;
const mockRefetch = jest.fn();

jest.mock('../../utils/findActiveTransferContext', () => {
  const actual = jest.requireActual('../../utils/findActiveTransferContext');
  return { ...actual, findActiveTransferContext: jest.fn(actual.findActiveTransferContext) };
});
import { findActiveTransferContext } from '../../utils/findActiveTransferContext';
const mockFindActiveTransferContext = findActiveTransferContext as jest.Mock;

const mockCreateLock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../alarm/store/useBoardingLockStore', () => {
  const actual = jest.requireActual('../../../alarm/store/useBoardingLockStore');
  return {
    ...actual,
    useBoardingLockStore: ((selector?: (s: { createLock: jest.Mock }) => unknown) =>
      selector ? selector({ createLock: mockCreateLock }) : { createLock: mockCreateLock }) as jest.Mock,
  };
});

// #2305 — useLegAdvanceStore mock. context 활성화 전이 시 stampLegAdvance 호출 검증.
const mockStampLegAdvance = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../alarm/store/useLegAdvanceStore', () => ({
  useLegAdvanceStore: {
    getState: () => ({ stampLegAdvance: mockStampLegAdvance }),
  },
}));

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

function arrivalRet(arrival: StationArrival | null, loading = false) {
  return { arrival, loading, isMock: false, refetch: mockRefetch };
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
    act(() => result.current.createTransferLock(makeTrain({ trainCode: 'NEW', arrivalSeconds: 240 })));
    // calculateRemainingLegETA(route, 0) = stopsFromTransfer(3)*MINUTES_PER_STOP(2) = 6분
    // #897 Seam A: initialEtaSeconds=탭한 train의 잔여 ETA(=240) 스냅샷.
    expect(mockCreateLock).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationId: 'dest-X',
        trainCode: 'NEW',
        boardingLine: '5',
        boardingStationId: (findStationByNameAndLine('공덕', '5') as Station).id,
        expectedDurationMs: 6 * 60_000,
        initialEtaSeconds: 240,
      }),
      false,
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


/**
 * #2115 — 환승 leg 재진입 직후 첫 arrival fetch 완료 전 loading이 그대로 노출되는지 검증.
 *
 * 근본 원인은 useArrivalInfo 자체(이미 useArrivalInfo.test.ts에서 키 변경 → loading 전이 검증됨)가
 * 아니라, HomeScreen이 BoardingTrainList에 loading을 아예 전달하지 않던 wiring 누락이었다.
 * 본 describe는 useTransferTrainList가 useArrivalInfo의 loading을 그대로 result에 노출하는지,
 * 즉 wiring이 끊기지 않는지를 박제한다.
 */
describe('#2115 loading passthrough', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrefetchArrival.mockResolvedValue(undefined);
  });

  it('키 변경(환승역 진입) 직후 첫 fetch 미완료 → loading=true', () => {
    mockUseArrival.mockReturnValue(arrivalRet(null, true));
    const { result } = renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(result.current.loading).toBe(true);
  });

  it('fetch 완료 + 진짜 empty(도착 열차 없음) → loading=false', () => {
    mockUseArrival.mockReturnValue(arrivalRet({ up: [], down: [] }, false));
    const { result } = renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.arrivals).toEqual([]);
  });

  it('fetch 완료 + data 도착 → loading=false + arrivals populated', () => {
    const trains = [makeTrain({ trainCode: 'T-1' })];
    mockUseArrival.mockReturnValue(arrivalRet({ up: trains, down: [] }, false));
    const { result } = renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.arrivals.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * #2305 — durable legAdvance stamp RCA 재현 테스트.
 *
 * RCA(2026-08-12 건대입구 7→2 환승 실기기): transfer auto-lock(create:other)이 생성된 직후
 * release되면서, 그 순간까지 legAdvance stamp가 없어(#2278 stamp는 hop-end 프롬프트 응답
 * 전용) `getApproachLine`이 route의 동결된 stopsToTransfer fallback으로 떨어져 리스트가
 * 구노선(7호선)으로 붕괴했다. context 활성화(=fusion이 lock+route+currentStation으로 환승
 * waypoint 도달을 확정하는 지점) 자체가 사용자 탭/프롬프트 응답과 무관한 durable 신호여야 한다.
 */
describe('#2305 durable legAdvance stamp — context 활성화 시 stamp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseArrival.mockReturnValue(arrivalRet(null));
    mockPrefetchArrival.mockResolvedValue(undefined);
  });

  it('환승 waypoint 도달(context 활성화) → stampLegAdvance(nextLine) 호출 — lock 탭/프롬프트 응답과 무관', () => {
    renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockStampLegAdvance).toHaveBeenCalledWith('5');
  });

  it('환승역 도달 후 lock이 해제(null)되어도 이미 stamp된 legAdvance는 그대로 유지 — approachLine이 참조하는 store 값 불변', () => {
    const { rerender } = renderHook(
      (props: { lock: BoardingLock | null }) =>
        useTransferTrainList({
          lock: props.lock,
          route,
          destinationName: '여의나루',
          currentStation: gondeokOn6,
        }),
      { initialProps: { lock: lock as BoardingLock | null } },
    );
    expect(mockStampLegAdvance).toHaveBeenCalledTimes(1);
    // lock 해제(RCA evidence: release:user) — context는 lock=null이라 즉시 비활성화되지만
    // 이미 발생한 stamp 호출 자체(=durable 신호)는 취소되지 않는다.
    // #2319 — lock=null 전이 시 lock-비종속 보조 경로(findLocklessTransferWaypoint)가 같은
    // waypoint(nextLine='5')로 stamp를 다시 발화한다. 같은 값 재-stamp는 durable 신호를
    // 무효화하지 않고(멱등), 오히려 lockless로 전환된 이후에도 stamp가 살아있음을 보강한다 —
    // 이 재발화 자체가 #2319가 메우려는 lockless 갭의 정상 동작.
    rerender({ lock: null });
    expect(mockStampLegAdvance).toHaveBeenCalledTimes(2);
    expect(mockStampLegAdvance).toHaveBeenNthCalledWith(2, '5');
  });

  it('context가 계속 활성 상태로 재렌더 되어도 stampLegAdvance 중복 호출 없음', () => {
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
    expect(mockStampLegAdvance).toHaveBeenCalledTimes(1);
    rerender({ currentStation: gondeokOn6 });
    expect(mockStampLegAdvance).toHaveBeenCalledTimes(1);
  });

  it('context 미활성(currentStation=null) → stampLegAdvance 미호출', () => {
    renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: null,
      }),
    );
    expect(mockStampLegAdvance).not.toHaveBeenCalled();
  });
});

/**
 * #2319 — lockless trip(=origin lock 자체가 없는 trip) 환승 진행 시 legAdvance stamp 갭.
 *
 * #2305(PR #2313)의 stamp는 `findActiveTransferContext`의 null→non-null 전이에서 발화하는데,
 * 그 함수는 `lock` 존재를 전제(`if (!lock || ...) return null`)한다. lockless trip은 애초에
 * lock이 없으므로 context가 영원히 null → stamp가 찍히지 않고 approachLine이 동결 route
 * `stopsToTransfer` fallback으로 남는다 (#2318 선행 검증 판정, PR #2313 Deviation 절).
 *
 * 기대 동작: lock 유무와 무관하게, route + destinationName + currentStation만으로 환승
 * waypoint 도달을 판정해 stamp가 발화해야 한다.
 */
describe('#2319 lockless trip 환승 진행 시 legAdvance stamp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseArrival.mockReturnValue(arrivalRet(null));
    mockPrefetchArrival.mockResolvedValue(undefined);
  });

  it('lock=null + 환승 waypoint 도달 → stampLegAdvance(nextLine) 호출 (RED였던 lockless 갭)', () => {
    renderHook(() =>
      useTransferTrainList({
        lock: null,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockStampLegAdvance).toHaveBeenCalledWith('5');
  });

  it('lock=null + 환승 waypoint 미도달(currentStation=null) → stampLegAdvance 미호출', () => {
    renderHook(() =>
      useTransferTrainList({
        lock: null,
        route,
        destinationName: '여의나루',
        currentStation: null,
      }),
    );
    expect(mockStampLegAdvance).not.toHaveBeenCalled();
  });

  it('lock=null + currentStation이 환승역이 아닌 경유역(삼각지) → resolveTransferWaypoint 매칭 실패로 stampLegAdvance 미호출', () => {
    const samgakji = findStationByNameAndLine('삼각지', '6') as Station;
    renderHook(() =>
      useTransferTrainList({
        lock: null,
        route,
        destinationName: '여의나루',
        currentStation: samgakji,
      }),
    );
    expect(mockStampLegAdvance).not.toHaveBeenCalled();
  });

  it('lock=null + 환승역 유지 상태로 재렌더 → stampLegAdvance 중복 호출 없음', () => {
    const { rerender } = renderHook(
      (props: { currentStation: Station }) =>
        useTransferTrainList({
          lock: null,
          route,
          destinationName: '여의나루',
          currentStation: props.currentStation,
        }),
      { initialProps: { currentStation: gondeokOn6 } },
    );
    expect(mockStampLegAdvance).toHaveBeenCalledTimes(1);
    rerender({ currentStation: gondeokOn6 });
    expect(mockStampLegAdvance).toHaveBeenCalledTimes(1);
  });

  it('lock 존재 시(기존 경로)에는 lockless 보조 경로가 중복 stamp를 발생시키지 않음', () => {
    renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockStampLegAdvance).toHaveBeenCalledTimes(1);
    expect(mockStampLegAdvance).toHaveBeenCalledWith('5');
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
