/**
 * S4 — #2906: 반대 방향·조기 종착 열차는 "어떤 경로로도" 후보가 되면 안 된다.
 *
 * #2696이 소유한 불변식(스펙 1~4)을 네 소비 경로에서 나란히 검증한다:
 *   P1. 탭 리스트 — useBoardingLockController.boardingListArrivals
 *   P2. 프롬프트 응답 자동 lock — useBoardingPromptResponder.handleResponse → tryAutoLock
 *       (내부적으로 pickAutoTrainCodeFromArrivals에 위임)
 *   P3. 이전 열차 후보 — usePrevTrainCandidate
 *   P4. position-train 추적 채택 — pickCandidateTrains (useFusedNearestStation이 호출하는
 *       enumeration 1단계. #2883 반대방향 배제는 boardingLock 활성 시에만 걸리는 2단계
 *       후처리이고, 이 1단계는 그 전에 "언제나" 실행된다 — 판정 참고)
 *
 * 실측 fixture (불변, 조정 금지):
 *   - 10/3 성수: 3174(내선·성수종착) vs 3169(외선·정상). 사용자 방향 외선(down).
 *   - 9/17(#2692): 8387(외선·성수종착), 내선(up) 여정 → 배제.
 *
 * 테스트 전용 — 프로덕션 코드는 수정하지 않는다. 실패 경로는 고치지 않고 판정만 남긴다
 * (PR 본문 경로×스펙 매트릭스 참고).
 *
 * 2호선 실역 순서(인접, stations.json 실측): ... 한양대(idx8) - 뚝섬(idx9) - 성수(idx10) -
 * 건대입구(idx11) - 구의(idx12) - 강변(idx13) - 잠실나루(idx14) ... 외선(down)은 idx 증가 방향.
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ArrivalInfo, StationArrival } from '../../shared/types/arrival';
import type { Station } from '../../shared/types/station';
import { ARRIVAL_CODE } from '../../shared/constants/arrivalCodes';
import { makeDirectRoute } from '../routeFixtures';

// ---------------------------------------------------------------------------
// 공유 실역 fixture (stations.json 실측 id — 하드코딩 매직스트링이 아니라 조회 결과를 상수화)
// ---------------------------------------------------------------------------
const SEONGSU: Station = {
  id: '2-011',
  name: '성수',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.544581,
  lng: 127.055961,
};
const JAMSILNARU: Station = {
  id: '2-015',
  name: '잠실나루',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.520733,
  lng: 127.10379,
};
// nextTargetStationName 기대값 — 성수→잠실나루(외선/down) 사이 바로 다음 정거장.
const NEXT_TARGET_KONKUK = '건대입구';
// 내선(up) 방향 목적지 fixture — 성수→한양대 방향(상행). destinationDirection='up' 테스트가
// destination/route도 실제로 내선 쪽이어야(geometry 일치) 의미 있는 재현이 된다.
const HANYANDAE: Station = {
  id: '2-009',
  name: '한양대',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.556105,
  lng: 127.070229,
};

function makeArrivalInfo(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
  return {
    destination: '',
    arrivalMinutes: 1,
    arrivalSeconds: 60,
    statusMessage: '',
    trainCode: 'T-DEFAULT',
    line: '2',
    receivedAtMs: 1_000,
    arrivalCode: ARRIVAL_CODE.DEPARTED,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

// 10/3 성수 fixture — 3174(내선·성수종착, 우선순위 최상위 DEPARTED여도 조기종착이라 배제돼야 함).
const T3174_OPPOSITE_EARLY_TERMINUS = makeArrivalInfo({
  trainCode: '3174',
  arrivalCode: ARRIVAL_CODE.DEPARTED,
  terminalStation: '성수', // nextTarget(건대입구) 이전 종착 — 조기종착
});
// 3169(외선·정상) — 반드시 후보로 남아야 함(과차단 금지, 요구4).
const T3169_NORMAL = makeArrivalInfo({
  trainCode: '3169',
  arrivalCode: ARRIVAL_CODE.ARRIVED,
  terminalStation: '잠실나루', // nextTarget 이후 종착 — 정상
});

// =============================================================================================
// 공유 mock — P1(useBoardingLockController)과 P2(useBoardingPromptResponder) 둘 다 쓰는 모듈은
// 한 번만 mock한다(중복 jest.mock은 에러). useBoardingLockStore/useLegAdvanceStore/
// addDomainBreadcrumb/alarmLog/logger는 두 소비자 모두 실측 동작이 안전해 실제 모듈 그대로 둔다
// (기존 각 hook의 레퍼런스 테스트 파일도 동일 패턴).
// =============================================================================================
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../features/alarm/utils/boardingLockStorage', () => ({
  getBoardingLock: jest.fn().mockResolvedValue(null),
  setBoardingLock: jest.fn().mockResolvedValue(undefined),
  clearBoardingLock: jest.fn().mockResolvedValue(undefined),
}));

const mockResolveTripDirection = jest.fn();
jest.mock('../../features/route/utils/tripDirection', () => ({
  resolveTripDirection: (...args: unknown[]) => mockResolveTripDirection(...args),
}));

// P1과 P2 둘 다 이 모듈을 import한다 — 단일 mock으로 공유.
const mockFindStationByNameAndLine = jest.fn();
jest.mock('../../shared/utils/stationLookup', () => ({
  findStationByNameAndLine: (...args: unknown[]) => mockFindStationByNameAndLine(...args),
}));

jest.mock('../../features/nearest-station/utils/movementGate', () => ({
  STATIC_SPEED_THRESHOLD_MPS: 0.5,
}));

// P1과 P2 둘 다 `.getState()` 패턴으로만 접근 — 단일 mock으로 공유.
jest.mock('../../features/alarm/store/useUserIntentStore', () => {
  const mockSetInfoModeEnabled = jest.fn(() => Promise.resolve());
  const mockSetBoardingCommitted = jest.fn(() => Promise.resolve());
  return {
    useUserIntentStore: {
      getState: () => ({
        setInfoModeEnabled: mockSetInfoModeEnabled,
        setBoardingCommitted: mockSetBoardingCommitted,
      }),
    },
  };
});

jest.mock('../../features/route/store/useNavigationStore', () => {
  const mockStartNavigation = jest.fn();
  return {
    useNavigationStore: {
      getState: () => ({ startNavigation: mockStartNavigation }),
    },
  };
});

jest.mock('../../features/alarm/utils/consensusMismatchMetrics', () => ({
  recordConsensusMismatch: jest.fn(),
}));

// P2 전용 — expo-notifications/AsyncStorage/positionUpload/widgetRefreshContext.
jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: '$default',
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));
const mockDismissBoardingPrompt = jest.fn();
const mockPostBoardingConfirm = jest.fn().mockResolvedValue(undefined);
jest.mock('../../features/nearest-station/api/positionUpload', () => ({
  dismissBoardingPrompt: (...args: unknown[]) => mockDismissBoardingPrompt(...args),
  postBoardingConfirm: (...args: unknown[]) => mockPostBoardingConfirm(...args),
}));
const mockReadWidgetRefreshContext = jest.fn();
jest.mock('../../features/alarm/utils/widgetRefreshContext', () => ({
  readWidgetRefreshContext: (...args: unknown[]) => mockReadWidgetRefreshContext(...args),
  parseBgLastStation: jest.fn(() => null),
}));

// ===============================================================================================
// P1 — 탭 리스트: useBoardingLockController.boardingListArrivals
// ===============================================================================================
import {
  useBoardingLockController,
  type UseBoardingLockControllerInputs,
} from '../../features/alarm/hooks/useBoardingLockController';
import { useBoardingLockStore } from '../../features/alarm/store/useBoardingLockStore';
import { useLegAdvanceStore } from '../../features/alarm/store/useLegAdvanceStore';

describe('S4 P1 — boardingListArrivals (탭 리스트, useBoardingLockController)', () => {
  const route = makeDirectRoute(5, '2');
  const baseInputs: UseBoardingLockControllerInputs = {
    destinationId: JAMSILNARU.id,
    destinationName: JAMSILNARU.name,
    route,
    arrival: null,
    currentStation: SEONGSU,
    expectedDurationMinutes: 20,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindStationByNameAndLine.mockReturnValue(null);
    useBoardingLockStore.setState({ lock: null });
    useLegAdvanceStore.setState({ nextLine: null, stampedAt: null });
  });

  it('스펙2(조기종착)+스펙4(과차단 금지) — 3174(내선·성수종착)는 배제, 3169(외선·정상)는 남는다', () => {
    mockResolveTripDirection.mockReturnValue('down');
    const arrival: StationArrival = { up: [], down: [T3174_OPPOSITE_EARLY_TERMINUS, T3169_NORMAL] };
    const { result } = renderHook(() =>
      useBoardingLockController({ ...baseInputs, arrival }),
    );
    expect(result.current.boardingListArrivals.map((t) => t.trainCode)).toEqual(['3169']);
  });

  it('스펙3(방향 미해결) — direction===null이면 후보 0건(양방향 병합 금지)', () => {
    mockResolveTripDirection.mockReturnValue(null);
    const arrival: StationArrival = { up: [], down: [T3174_OPPOSITE_EARLY_TERMINUS, T3169_NORMAL] };
    const { result } = renderHook(() =>
      useBoardingLockController({ ...baseInputs, arrival }),
    );
    expect(result.current.boardingListArrivals).toEqual([]);
  });

  it('스펙1(반대 방향) — direction 해결 bucket(up)만 보고, 반대 bucket(down)의 3174는 노출되지 않는다', () => {
    mockResolveTripDirection.mockReturnValue('up');
    const arrival: StationArrival = { up: [], down: [T3174_OPPOSITE_EARLY_TERMINUS] };
    const { result } = renderHook(() =>
      useBoardingLockController({ ...baseInputs, arrival }),
    );
    expect(result.current.boardingListArrivals).toEqual([]);
  });
});

// ===============================================================================================
// P2 — 프롬프트 응답 자동 lock: useBoardingPromptResponder.handleResponse → tryAutoLock
//      (pickAutoTrainCodeFromArrivals에 위임)
// ===============================================================================================
import {
  handleResponse,
  type BoardingPromptPayload,
} from '../../features/alarm/hooks/useBoardingPromptResponder';
import { BOARDING_PROMPT_ACTION_BOARDED } from '../../features/alarm/utils/notificationCategory';
import { PENDING_TRAIN_CODE } from '../../shared/constants/boardingLock';

describe('S4 P2 — 프롬프트 [탑승] 응답 자동 lock (handleResponse → tryAutoLock)', () => {
  const PAYLOAD: BoardingPromptPayload = {
    kind: 'boarding-prompt',
    originStation: SEONGSU.name,
    line: '2',
    tripToken: 'tok-2906',
    destinationDirection: 'down',
  };

  function makeDeps(overrides: Partial<Parameters<typeof handleResponse>[2]> = {}) {
    return {
      fetchArrivalsForStation: jest.fn(async () => ({
        up: [],
        down: [T3174_OPPOSITE_EARLY_TERMINUS, T3169_NORMAL],
      })),
      destinationId: JAMSILNARU.id,
      expectedDurationMs: 600_000,
      createLock: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindStationByNameAndLine.mockReturnValue(SEONGSU);
    mockReadWidgetRefreshContext.mockResolvedValue({
      destination: JAMSILNARU,
      route: makeDirectRoute(5, '2'),
      bgContext: null,
    });
    useBoardingLockStore.setState({ lock: null });
    useLegAdvanceStore.setState({ nextLine: null, stampedAt: null });
  });

  it('스펙2(조기종착) — 3174는 arvlCd 우선순위 최상위여도 선택되지 않고, 3169가 lock된다', async () => {
    const deps = makeDeps();
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(deps.createLock).toHaveBeenCalledWith(
      expect.objectContaining({ trainCode: '3169', boardingStationId: SEONGSU.id }),
      true,
      'boarding-prompt-response',
    );
  });

  it('스펙3(방향 미해결) — destinationDirection undefined면 실 trainCode가 아니라 PENDING sentinel로만 lock된다', async () => {
    const deps = makeDeps();
    await handleResponse(
      BOARDING_PROMPT_ACTION_BOARDED,
      { ...PAYLOAD, destinationDirection: undefined },
      deps,
    );
    // #2407 — 방향 미해결도 "탑승 응답" 자체는 ADR-014상 lock 활성과 동급이라 PENDING sentinel로
    // lock은 생성된다(lockless cascade 차단). 중요한 건 "실 trainCode(반대방향/조기종착 포함)가
    // 섞여 선택되지 않는다"는 것 — 3174/3169 둘 다 거부되어 PENDING으로만 떨어진다.
    expect(deps.createLock).toHaveBeenCalledWith(
      expect.objectContaining({ trainCode: PENDING_TRAIN_CODE }),
      false,
      'boarding-prompt-response',
    );
  });

  it('스펙1(반대 방향, #2692 9/17 8387 재발 방지) — 사용자 내선(up) 여정에서 외선·성수종착 8387은 lock되지 않는다', async () => {
    const t8387 = makeArrivalInfo({
      trainCode: '8387',
      arrivalCode: ARRIVAL_CODE.DEPARTED,
      terminalStation: '성수',
    });
    const deps = makeDeps({
      fetchArrivalsForStation: jest.fn(async () => ({ up: [t8387], down: [] })),
    });
    // 사용자 실제 여정 = 내선(up), 목적지도 내선 방향(한양대) — destinationDirection='up'과
    // route/destination geometry가 서로 일치해야 nextTargetStationName 계산이 의미있다(#2696
    // 설계가 전제하는 정상 조건). 8387은 "외선·성수종착" — 같은 bucket에 잘못 섞여도
    // isBoardableCandidate의 조기종착 판정으로 배제돼야 한다(9/17 #2692 evidence).
    mockReadWidgetRefreshContext.mockResolvedValueOnce({
      destination: HANYANDAE,
      route: makeDirectRoute(3, '2'),
      bgContext: null,
    });
    await handleResponse(
      BOARDING_PROMPT_ACTION_BOARDED,
      { ...PAYLOAD, destinationDirection: 'up' },
      deps,
    );
    expect(deps.createLock).not.toHaveBeenCalledWith(
      expect.objectContaining({ trainCode: '8387' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('스펙4(과차단 금지) — 반대방향 없이 정상 열차 1건만 있으면 lock된다', async () => {
    const deps = makeDeps({
      fetchArrivalsForStation: jest.fn(async () => ({ up: [], down: [T3169_NORMAL] })),
    });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(deps.createLock).toHaveBeenCalledWith(
      expect.objectContaining({ trainCode: '3169' }),
      true,
      'boarding-prompt-response',
    );
  });
});

// ===============================================================================================
// P3 — 이전 열차 후보: usePrevTrainCandidate
// ===============================================================================================
import { usePrevTrainCandidate } from '../../features/alarm/hooks/usePrevTrainCandidate';
import type { UsePrevTrainCandidateInputs } from '../../features/alarm/hooks/usePrevTrainCandidate';

describe('S4 P3 — usePrevTrainCandidate (이전 열차 후보)', () => {
  const baseProps: UsePrevTrainCandidateInputs = {
    route: makeDirectRoute(5, '2'),
    destinationName: JAMSILNARU.name,
    currentStation: SEONGSU,
    nextStationName: NEXT_TARGET_KONKUK,
    line: '2',
    currentArrivals: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockResolveTripDirection.mockReturnValue('down');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('스펙2(조기종착) — 3174는 관측 단계(seenRef)에 아예 들어가지 않아 "출발"로도 전열차 후보가 되지 않는다', () => {
    jest.setSystemTime(0);
    const { rerender, result } = renderHook(
      (props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props),
      { initialProps: { ...baseProps, currentArrivals: [T3174_OPPOSITE_EARLY_TERMINUS, T3169_NORMAL] } },
    );
    expect(result.current.prevTrain).toBeNull();
    // 두 열차 모두 arrivals에서 사라짐(=다음 tick에서 "출발" 전이 관측).
    jest.setSystemTime(5_000);
    rerender({ ...baseProps, currentArrivals: [] });
    // 3169(정상)만 boardable 추적 대상이었으므로 전열차 후보가 됐어야 하는데, 3174가 같은 tick에
    // 사라지며 "arrivalSeconds 최솟값"(= 가장 나중에 출발) 기준으로 후보가 선정된다 — 3174가 섞여
    // 선정 로직에 영향을 주면 안 된다는 것까지 함께 확인.
    expect(result.current.prevTrain?.train.trainCode).toBe('3169');
  });

  it('스펙3(방향 미해결) — direction===null이면 관측 대상(boardableArrivals) 자체가 0건', () => {
    mockResolveTripDirection.mockReturnValue(null);
    jest.setSystemTime(0);
    const { rerender, result } = renderHook(
      (props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props),
      { initialProps: { ...baseProps, currentArrivals: [T3169_NORMAL] } },
    );
    jest.setSystemTime(5_000);
    rerender({ ...baseProps, currentArrivals: [] });
    // direction 미해결 → isBoardableCandidate가 항상 false → seenRef에 아무것도 없었으므로
    // "사라짐" 전이 관측 자체가 없고 전열차 후보도 없다.
    expect(result.current.prevTrain).toBeNull();
  });

  it('스펙4(과차단 금지, 거부 케이스) — 정상 방향·정상 종착 단일 열차는 출발 시 전열차 후보가 된다', () => {
    jest.setSystemTime(0);
    const { rerender, result } = renderHook(
      (props: UsePrevTrainCandidateInputs) => usePrevTrainCandidate(props),
      { initialProps: { ...baseProps, currentArrivals: [T3169_NORMAL] } },
    );
    jest.setSystemTime(5_000);
    rerender({ ...baseProps, currentArrivals: [] });
    expect(result.current.prevTrain?.train.trainCode).toBe('3169');
  });
});

// ===============================================================================================
// P4 — position-train 추적 채택: pickCandidateTrains
//      (useFusedNearestStation이 호출하는 enumeration 1단계 — 판정 섹션 참고)
// ===============================================================================================
import { pickCandidateTrains } from '../../features/arrival/utils/pickCandidateTrains';
import type { LinePositions, TrainPosition } from '../../shared/types/position';

function makeTrainPosition(overrides: Partial<TrainPosition>): TrainPosition {
  return {
    statnId: '2-011',
    statnNm: '성수',
    trainNo: '0001',
    trainStatus: 2,
    updnLine: 0,
    terminalStationId: '2-011',
    terminalStationName: '성수',
    trainType: 'normal',
    isLastTrain: false,
    receivedAtMs: 1_000,
    ...overrides,
  };
}

describe('S4 P4 — pickCandidateTrains (position-train enumeration)', () => {
  // 10/3 성수 fixture를 TrainPosition으로 재현. updnLine: 0=상행/내선, 1=하행/외선(실측 확정,
  // memory/reference_seoul_updnline_format_differs.md). 사용자 방향 외선 → updnLine=1만 유효.
  const posTrain3174 = makeTrainPosition({
    trainNo: '3174',
    updnLine: 0, // 내선 — 반대 방향
    terminalStationName: '성수',
  });
  const posTrain3169 = makeTrainPosition({
    trainNo: '3169',
    updnLine: 1, // 외선 — 정상
    terminalStationName: '잠실나루',
  });
  const positions: LinePositions[] = [{ line: '2', trains: [posTrain3174, posTrain3169] }];

  it(
    '판정(결함, 스펙1/3 위반) — direction 미전달(undefined) 호출은 반대 방향(3174, updnLine=0)을 ' +
      '그대로 merge한다. 실제 호출부(useFusedNearestStation.ts:870-909)가 direction을 전달하지 않아 ' +
      '이 merge가 그대로 일어난다 — file:line은 PR 본문 판정표 참고',
    () => {
      const picked = pickCandidateTrains({ positions, line: '2', direction: undefined });
      // 과차단 회귀 가드(거부 케이스, 스펙4) — 3169는 반드시 남아야 한다.
      expect(picked.some((c) => c.trainNo === '3169')).toBe(true);
      // 스펙1 위반 증거 — direction 미지정 시 3174(반대 방향)도 같이 섞여 나온다.
      expect(picked.some((c) => c.trainNo === '3174')).toBe(true);
    },
  );

  it('direction을 명시 전달하면(0 또는 1) 그 방향만 남는다 — 필터 자체는 존재, 문제는 "항상 호출되지 않음"', () => {
    const pickedDown = pickCandidateTrains({ positions, line: '2', direction: 1 });
    expect(pickedDown.map((c) => c.trainNo)).toEqual(['3169']);
  });

  it(
    '픽스(#2914 결함2) — CandidateTrain이 terminalStationName을 보존해 이 레이어에서도 ' +
      '조기종착 판정이 가능하다 (TrainPosition.terminalStationName을 buildCandidate가 더 이상 ' +
      '드롭하지 않음 — src/features/arrival/utils/pickCandidateTrains.ts buildCandidate)',
    () => {
      const pickedDown = pickCandidateTrains({ positions, line: '2', direction: 1 });
      const candidate = pickedDown.find((c) => c.trainNo === '3169');
      expect(candidate).toBeDefined();
      expect(candidate?.terminalStationName).toBe('잠실나루');
      expect(Object.keys(candidate as object).sort()).toEqual(
        [
          'currentStationName',
          'direction',
          'line',
          'receivedAtMs',
          'terminalStationName',
          'trainNo',
          'trainStatus',
        ].sort(),
      );
    },
  );
});
