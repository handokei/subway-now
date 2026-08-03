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
import { SIMPLE_ARRIVAL_ARCH_ENV_KEY } from '../../../../shared/config/archFlag';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { Station } from '../../../../shared/types/station';
import { makeDirectRoute, makeTransferRoute } from '../../../../testUtils/routeFixtures';

// #2016 — 각 테스트가 명시적으로 flag 를 셋하지 않는 한 dormant 기본값 유지 (flag OFF, 기존 D5 동작).
const ORIGINAL_ARCH_ENV = process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];

beforeEach(() => {
  delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
});

afterAll(() => {
  if (ORIGINAL_ARCH_ENV === undefined) {
    delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
  } else {
    process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = ORIGINAL_ARCH_ENV;
  }
});

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
 * #1211 D5 — 환승 leg autoLock 트리거.
 *
 * 사용자가 origin에서 명시 탭으로 lock을 만든 trip(=현재 lock 존재)에서 planned route transfer
 * waypoint 도달 + arvlCd 우선순위로 단일 train 선정 가능 → createTransferLock 자동 호출.
 * lock 없음(lockless 직접 entry) / ambiguity / arrivals 비어있음은 skip — 기존 manual fallback 유지.
 */
describe('#1211 D5 환승 leg autoLock 트리거', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseArrival.mockReturnValue(arrivalRet(null));
    mockPrefetchArrival.mockResolvedValue(undefined);
    // clearAllMocks resets mock implementation — restore real behavior as default.
    const actual = jest.requireActual<typeof import('../../utils/findActiveTransferContext')>('../../utils/findActiveTransferContext');
    mockFindActiveTransferContext.mockImplementation(actual.findActiveTransferContext);
  });

  const gondeokOn5Id = (findStationByNameAndLine('공덕', '5') as Station).id;

  /** baseline createTransferLock 호출 시 들어가야 할 lock 필드. */
  function expectedAutoLock(trainCode: string, initialEtaSeconds: number): unknown {
    return expect.objectContaining({
      destinationId: 'dest-X',
      trainCode,
      boardingLine: '5',
      boardingStationId: gondeokOn5Id,
      expectedDurationMs: 6 * 60_000,
      initialEtaSeconds,
    });
  }

  it('context 활성 + arvlCd 단일 train(ARRIVED=1) → autoLock 1회', () => {
    const arrived = makeTrain({ trainCode: 'T-ARRIVED', arrivalCode: 1, arrivalSeconds: 30 });
    const running = makeTrain({ trainCode: 'T-RUN', arrivalCode: 99, arrivalSeconds: 300 });
    mockUseArrival.mockReturnValue(arrivalRet({ up: [arrived, running], down: [] }));
    renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockCreateLock).toHaveBeenCalledTimes(1);
    expect(mockCreateLock).toHaveBeenCalledWith(expectedAutoLock('T-ARRIVED', 30));
  });

  it('arvlCd 우선순위 — DEPARTED(2) 단일이면 ENTERING(0) 무시하고 DEPARTED 선택', () => {
    const departed = makeTrain({ trainCode: 'T-DEP', arrivalCode: 2, arrivalSeconds: 10 });
    const entering = makeTrain({ trainCode: 'T-ENT', arrivalCode: 0, arrivalSeconds: 60 });
    mockUseArrival.mockReturnValue(arrivalRet({ up: [departed, entering], down: [] }));
    renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockCreateLock).toHaveBeenCalledWith(expectedAutoLock('T-DEP', 10));
  });

  it('ambiguity (같은 우선순위 train 2대) → autoLock skip — manual fallback', () => {
    const a = makeTrain({ trainCode: 'T-A', arrivalCode: 1, arrivalSeconds: 30 });
    const b = makeTrain({ trainCode: 'T-B', arrivalCode: 1, arrivalSeconds: 60 });
    mockUseArrival.mockReturnValue(arrivalRet({ up: [a, b], down: [] }));
    renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockCreateLock).not.toHaveBeenCalled();
  });

  it('arrivals 비어 있음 → autoLock skip', () => {
    mockUseArrival.mockReturnValue(arrivalRet({ up: [], down: [] }));
    renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockCreateLock).not.toHaveBeenCalled();
  });

  it('context 미활성(currentStation=null) → autoLock skip', () => {
    const arrived = makeTrain({ trainCode: 'T-ARRIVED', arrivalCode: 1, arrivalSeconds: 30 });
    mockUseArrival.mockReturnValue(arrivalRet({ up: [arrived], down: [] }));
    renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: null,
      }),
    );
    expect(mockCreateLock).not.toHaveBeenCalled();
  });

  it('lock=null(완전 lockless 진입) → context 미활성 → autoLock skip', () => {
    const arrived = makeTrain({ trainCode: 'T-ARRIVED', arrivalCode: 1, arrivalSeconds: 30 });
    mockUseArrival.mockReturnValue(arrivalRet({ up: [arrived], down: [] }));
    renderHook(() =>
      useTransferTrainList({
        lock: null,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockCreateLock).not.toHaveBeenCalled();
  });

  it('같은 환승역에서 polling 반복(arrival 새 객체) → autoLock 1회만 (idempotency)', () => {
    // 폴링 tick마다 useArrivalInfo가 새 arrival 객체를 반환하더라도(ref만 다름) transferKey가
    // 동일하면 ref 가드로 effect skip — 한 번만 호출. 실제 폴링 시나리오 시뮬레이션.
    const makeFreshArrival = (): { arrival: StationArrival; loading: boolean; isMock: boolean; refetch: jest.Mock } =>
      arrivalRet({
        up: [makeTrain({ trainCode: 'T-ARRIVED', arrivalCode: 1, arrivalSeconds: 30 })],
        down: [],
      }) as { arrival: StationArrival; loading: boolean; isMock: boolean; refetch: jest.Mock };
    mockUseArrival.mockImplementation(() => makeFreshArrival());
    const { rerender } = renderHook(
      (props: { lock: BoardingLock }) =>
        useTransferTrainList({
          lock: props.lock,
          route,
          destinationName: '여의나루',
          currentStation: gondeokOn6,
        }),
      { initialProps: { lock } },
    );
    // 새 arrival 객체가 매 render마다 반환되어 effect deps(arrivals)가 변경되지만, transferKey
    // ref 가드(line 154)로 skip.
    rerender({ lock });
    rerender({ lock });
    expect(mockCreateLock).toHaveBeenCalledTimes(1);
  });

  it('autoLock 후 lock.boardingLine === nextLine으로 갱신되면 context 자연 닫힘', () => {
    // 첫 렌더: 옛 leg lock(boardingLine='6')으로 context 활성 → autoLock 발사.
    // 두 번째 렌더: lock.boardingLine='5'로 swap 시뮬 → findActiveTransferContext가 null
    // → autoLock effect의 `if (!context) return`로 안전 skip.
    const arrived = makeTrain({ trainCode: 'T-ARRIVED', arrivalCode: 1, arrivalSeconds: 30 });
    mockUseArrival.mockReturnValue(arrivalRet({ up: [arrived], down: [] }));
    const swapped: BoardingLock = { ...lock, boardingLine: '5' as const, trainCode: 'T-ARRIVED' };
    const { rerender } = renderHook(
      (props: { lock: BoardingLock }) =>
        useTransferTrainList({
          lock: props.lock,
          route,
          destinationName: '여의나루',
          currentStation: gondeokOn6,
        }),
      { initialProps: { lock } },
    );
    expect(mockCreateLock).toHaveBeenCalledTimes(1);
    mockCreateLock.mockClear();
    rerender({ lock: swapped });
    expect(mockCreateLock).not.toHaveBeenCalled();
  });

  it('사용자가 수동 탭(createTransferLock)으로 먼저 lock을 만들면 autoLock은 그 후 재발사 안 함', () => {
    // arrivals ambiguity 상황 → autoLock 자동 skip → 사용자가 직접 선택 → 그 호출만 발생.
    const a = makeTrain({ trainCode: 'T-A', arrivalCode: 1, arrivalSeconds: 30 });
    const b = makeTrain({ trainCode: 'T-B', arrivalCode: 1, arrivalSeconds: 60 });
    mockUseArrival.mockReturnValue(arrivalRet({ up: [a, b], down: [] }));
    const { result } = renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockCreateLock).not.toHaveBeenCalled();
    act(() => result.current.createTransferLock(makeTrain({ trainCode: 'T-A', arrivalSeconds: 30 })));
    expect(mockCreateLock).toHaveBeenCalledTimes(1);
    expect(mockCreateLock).toHaveBeenCalledWith(expectedAutoLock('T-A', 30));
  });

  it('환승역에서 벗어나면(currentStation null로 전환) idempotency ref 리셋 — 다음 진입 시 재시도', () => {
    const arrived = makeTrain({ trainCode: 'T-ARRIVED', arrivalCode: 1, arrivalSeconds: 30 });
    mockUseArrival.mockReturnValue(arrivalRet({ up: [arrived], down: [] }));
    const { rerender } = renderHook(
      (props: { currentStation: Station | null }) =>
        useTransferTrainList({
          lock,
          route,
          destinationName: '여의나루',
          currentStation: props.currentStation,
        }),
      { initialProps: { currentStation: gondeokOn6 as Station | null } },
    );
    expect(mockCreateLock).toHaveBeenCalledTimes(1);
    // GPS 끊김 — context null → ref 리셋.
    rerender({ currentStation: null });
    // 다시 환승역 진입 — autoLock 재발사.
    rerender({ currentStation: gondeokOn6 });
    expect(mockCreateLock).toHaveBeenCalledTimes(2);
  });

  it('#1740 — context.direction=null (방향 미확정) → destinationDirection=undefined, 양방향 합산 후 autoLock 정상 발사', () => {
    // context.direction === null은 resolveDirectionInLine이 index 비교에 실패한 edge-case.
    // pickAutoTrainCodeFromArrivals에 destinationDirection=undefined가 전달되고,
    // filterArrivalsByDirection가 양방향을 합산한 arrivals에서 단일 train을 선정해 lock이 생성된다.
    const arrived = makeTrain({ trainCode: 'T-DIR-NULL', arrivalCode: 2, arrivalSeconds: 15 });
    mockUseArrival.mockReturnValue(arrivalRet({ up: [arrived], down: [] }));
    mockFindActiveTransferContext.mockReturnValueOnce({
      transferStationInToLine: findStationByNameAndLine('공덕', '5') as Station,
      nextLine: '5' as const,
      nextWaypointName: '여의나루',
      direction: null,
      completedTransferIdx: 0,
    });
    renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockCreateLock).toHaveBeenCalledTimes(1);
    expect(mockCreateLock).toHaveBeenCalledWith(expect.objectContaining({ trainCode: 'T-DIR-NULL' }));
  });
});

/**
 * #2016 (ADR-022 D5 dormant) — `isSimpleArchEnabled()` 활성 시 D5 autoLock effect skip.
 *
 * 배경: 관찰 11 fix (#2015) 로 arvlCd=1 즉시 boardingPrompt 가 fire 되면서 D5 autoLock 이
 * 메꾸려던 lockless gap 자체가 사라짐. flag ON 시 사용자 명시 의향(boardingPrompt 응답 /
 * BoardingTrainList 직접 탭) 만이 락 트리거.
 *
 * flag OFF (기본) 시 기존 D5 동작 100% 유지는 위 '#1211 D5' describe 가 이미 검증.
 * 본 describe 는 flag ON 시 dormant + 수동 flow 정상 발동 만 박제.
 */
describe('#2016 (autoLock dormant) archFlag ON 시 D5 autoLock skip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseArrival.mockReturnValue(arrivalRet(null));
    mockPrefetchArrival.mockResolvedValue(undefined);
    process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
  });

  it('flag ON + context 활성 + arvlCd 단일 train(ARRIVED=1) → autoLock 발동 0건 (dormant)', () => {
    // #1211 D5 baseline 시나리오. flag OFF 였으면 autoLock 1회 호출됐을 조건.
    const arrived = makeTrain({ trainCode: 'T-ARRIVED', arrivalCode: 1, arrivalSeconds: 30 });
    mockUseArrival.mockReturnValue(arrivalRet({ up: [arrived], down: [] }));
    renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockCreateLock).not.toHaveBeenCalled();
  });

  it('flag ON + BoardingTrainList 직접 탭 (createTransferLock) → 정상 락 발동 (수동 flow 유지)', () => {
    mockUseArrival.mockReturnValue(arrivalRet({ up: [makeTrain({ trainCode: 'NEW' })], down: [] }));
    const { result } = renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    // 자동 autoLock 은 dormant.
    expect(mockCreateLock).not.toHaveBeenCalled();
    // 사용자 명시 탭 → createTransferLock 직접 호출 시 정상 락 생성.
    act(() => result.current.createTransferLock(makeTrain({ trainCode: 'NEW', arrivalSeconds: 240 })));
    expect(mockCreateLock).toHaveBeenCalledTimes(1);
    expect(mockCreateLock).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationId: 'dest-X',
        trainCode: 'NEW',
        boardingLine: '5',
        expectedDurationMs: 6 * 60_000,
        initialEtaSeconds: 240,
      }),
    );
  });

  it('flag ON + polling 반복(arrival 새 객체) → autoLock 0건 유지 (dormant 안정성)', () => {
    // flag OFF 였으면 idempotency ref 로 1회만 호출. flag ON 이면 항상 0회.
    const makeFreshArrival = (): { arrival: StationArrival; loading: boolean; isMock: boolean; refetch: jest.Mock } =>
      arrivalRet({
        up: [makeTrain({ trainCode: 'T-ARRIVED', arrivalCode: 1, arrivalSeconds: 30 })],
        down: [],
      }) as { arrival: StationArrival; loading: boolean; isMock: boolean; refetch: jest.Mock };
    mockUseArrival.mockImplementation(() => makeFreshArrival());
    const { rerender } = renderHook(
      (props: { lock: BoardingLock }) =>
        useTransferTrainList({
          lock: props.lock,
          route,
          destinationName: '여의나루',
          currentStation: gondeokOn6,
        }),
      { initialProps: { lock } },
    );
    rerender({ lock });
    rerender({ lock });
    expect(mockCreateLock).not.toHaveBeenCalled();
  });
});

/**
 * #1241 — 사용자 trip 2026-06-12 회귀 가드
 *
 * Evidence SSOT: tasks/epic-lockless-recovery-2026-06-12.md §1~§2
 *   - 보고 #4 (08:36:46 환승 후 호선 자동 선택 안 됨, 건대입구 7→2)
 *   - 보고 #9 (오후 trip에서 동일 재발)
 * 기대 동작: 사용자 명시 의향 trip(=lock 존재 + planned transfer waypoint 도달)에서
 * arvlCd 우선순위로 단일 train이 결정되면 createTransferLock이 자동 호출되어야 한다.
 *
 * 이 describe는 D5 (#1211, PR #1220)에서 적용된 autoLock 트리거가 향후 회귀로 풀리지 않도록
 * 박제한다. 위 '#1211 D5 환승 leg autoLock 트리거' describe가 기능 검증을 담당하고,
 * 본 describe는 사용자 보고와 직접 매핑된다.
 */
describe('사용자 trip 2026-06-12 회귀 가드', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseArrival.mockReturnValue(arrivalRet(null));
    mockPrefetchArrival.mockResolvedValue(undefined);
  });

  it('보고 #4/#9 — lock 존재 + planned transfer 도달 + arvlCd 단일 train → autoLock 1회', () => {
    const arrived = makeTrain({ trainCode: 'T-ARRIVED', arrivalCode: 1, arrivalSeconds: 30 });
    mockUseArrival.mockReturnValue(arrivalRet({ up: [arrived], down: [] }));
    renderHook(() =>
      useTransferTrainList({
        lock,
        route,
        destinationName: '여의나루',
        currentStation: gondeokOn6,
      }),
    );
    expect(mockCreateLock).toHaveBeenCalledTimes(1);
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
