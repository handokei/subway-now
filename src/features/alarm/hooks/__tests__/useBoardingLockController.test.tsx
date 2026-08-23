import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  useBoardingLockController,
  type UseBoardingLockControllerInputs,
} from '../useBoardingLockController';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { useLegAdvanceStore } from '../../store/useLegAdvanceStore';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { Station } from '../../../../shared/types/station';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import {
  makeDirectRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockGetBoardingLock = jest.fn();
const mockSetBoardingLock = jest.fn();
const mockClearBoardingLock = jest.fn();

jest.mock('../../utils/boardingLockStorage', () => ({
  getBoardingLock: (...args: unknown[]) => mockGetBoardingLock(...args),
  setBoardingLock: (...args: unknown[]) => mockSetBoardingLock(...args),
  clearBoardingLock: (...args: unknown[]) => mockClearBoardingLock(...args),
}));

const mockResolveTripDirection = jest.fn();
jest.mock('../../../route/utils/tripDirection', () => ({
  resolveTripDirection: (...args: unknown[]) => mockResolveTripDirection(...args),
}));

const mockFindStationByNameAndLine = jest.fn();
jest.mock('../../../../shared/utils/stationLookup', () => ({
  findStationByNameAndLine: (...args: unknown[]) => mockFindStationByNameAndLine(...args),
}));

// #1014 — movementGate 모듈 mock. STATIC_SPEED_THRESHOLD_MPS 실제값(0.5)을 노출해
// acceptance gate 로직이 테스트에서 일관되게 동작하도록 격리.
jest.mock('../../../nearest-station/utils/movementGate', () => ({
  STATIC_SPEED_THRESHOLD_MPS: 0.5,
}));

// #1923 — useUserIntentStore mock. createLockFromTrain 진입 시 setInfoModeEnabled(true) 호출 검증.
jest.mock('../../store/useUserIntentStore', () => {
  const mockSetInfoModeEnabled = jest.fn(() => Promise.resolve());
  return {
    useUserIntentStore: {
      getState: () => ({ setInfoModeEnabled: mockSetInfoModeEnabled }),
    },
    __mockSetInfoModeEnabled: mockSetInfoModeEnabled,
  };
});
const { __mockSetInfoModeEnabled: setInfoModeEnabledMock } = jest.requireMock(
  '../../store/useUserIntentStore',
);

// #2371 — useNavigationStore mock. createLockFromTrain(user-tap) 진입 시 startNavigation()
// 호출 검증 + hydrateLockFromCandidate(무탭 fusion auto-lock)에서는 호출 안 됨을 검증
// (#2306 RCA — 잠금 시 BG GPS 미시작 회귀 fix + 무탭 auto-lock BG 시작 금지 회귀 방지).
jest.mock('../../../route/store/useNavigationStore', () => {
  const mockStartNavigation = jest.fn();
  return {
    useNavigationStore: {
      getState: () => ({ startNavigation: mockStartNavigation }),
    },
    __mockStartNavigation: mockStartNavigation,
  };
});
const { __mockStartNavigation: startNavigationMock } = jest.requireMock(
  '../../../route/store/useNavigationStore',
);

// #2330 (consensus-D) — 탭 vs consensus-confirmed 불일치 telemetry mock.
const mockRecordConsensusMismatch = jest.fn();
jest.mock('../../utils/consensusMismatchMetrics', () => ({
  recordConsensusMismatch: (...args: unknown[]) => mockRecordConsensusMismatch(...args),
}));

function makeTrain(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
  return {
    destination: '종착',
    arrivalMinutes: 3,
    arrivalSeconds: 180,
    statusMessage: '',
    trainCode: 'T-1',
    line: '2',
    receivedAtMs: 0,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

const stationA: Station = {
  id: 'stn-A',
  name: '강남',
  line: '2',
  lineColor: '#000',
  lat: 37.5,
  lng: 127.0,
};

const route = makeDirectRoute(5, '2');

const upTrain = makeTrain({ trainCode: 'UP-1' });
const downTrain = makeTrain({ trainCode: 'DN-1' });
const arrival: StationArrival = { up: [upTrain], down: [downTrain] };

const defaultInputs: UseBoardingLockControllerInputs = {
  destinationId: 'dest-1',
  destinationName: '성수',
  route,
  arrival,
  currentStation: stationA,
  expectedDurationMinutes: 20,
};

describe('useBoardingLockController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBoardingLock.mockResolvedValue(null);
    mockSetBoardingLock.mockResolvedValue(undefined);
    mockClearBoardingLock.mockResolvedValue(undefined);
    mockResolveTripDirection.mockReturnValue(null);
    // Default: lookup miss — controller falls back to currentStation.id (이전 동작 유지).
    mockFindStationByNameAndLine.mockReturnValue(null);
    useBoardingLockStore.setState({ lock: null });
    // #2278 (PR #2287 리뷰 P1-1) — 매 테스트마다 leg-advance stamp 리셋 (zustand 모듈 싱글톤 leak 차단).
    useLegAdvanceStore.setState({ nextLine: null, stampedAt: null });
  });

  it('마운트 시 loadLock 호출 → storage에서 복원', async () => {
    const stored: BoardingLock = {
      destinationId: 'dest-1',
      trainCode: 'T-100',
      boardingStationId: 'stn-A',
      boardingLine: '2',
      boardedAt: Date.now(),
      expectedDurationMs: 600_000,
    };
    mockGetBoardingLock.mockResolvedValueOnce(stored);
    const { result } = renderHook(() => useBoardingLockController(defaultInputs));
    await waitFor(() => expect(result.current.lock).toEqual(stored));
  });

  describe('directionalArrivals', () => {
    it("direction='up'이면 arrival.up만", () => {
      mockResolveTripDirection.mockReturnValue('up');
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      expect(result.current.directionalArrivals).toEqual([upTrain]);
    });

    it("direction='down'이면 arrival.down만", () => {
      mockResolveTripDirection.mockReturnValue('down');
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      expect(result.current.directionalArrivals).toEqual([downTrain]);
    });

    it('direction 미정이면 up+down 합집합', () => {
      mockResolveTripDirection.mockReturnValue(null);
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      expect(result.current.directionalArrivals).toEqual([upTrain, downTrain]);
    });

    it('arrival null이면 빈 배열', () => {
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, arrival: null }),
      );
      expect(result.current.directionalArrivals).toEqual([]);
    });

    it('route/destinationName/currentStation 누락이면 direction null로 폴백 → 합집합', () => {
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, route: null }),
      );
      expect(mockResolveTripDirection).not.toHaveBeenCalled();
      expect(result.current.directionalArrivals).toEqual([upTrain, downTrain]);
    });

    it('#897 Seam A: arrivalSeconds=0 (임박) 열차도 list에 유지 — useArrivalCountdown 0초 tick에서 행 사라짐 회귀 차단', () => {
      const imminent = makeTrain({ trainCode: 'IMMINENT', arrivalSeconds: 0 });
      const future = makeTrain({ trainCode: 'FUTURE', arrivalSeconds: 180 });
      const arrivalImminent: StationArrival = { up: [imminent, future], down: [] };
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, arrival: arrivalImminent }),
      );
      expect(result.current.directionalArrivals).toEqual([imminent, future]);
    });

    it('#897 음수 arrivalSeconds(이미 지나간)는 그대로 제외 — createLock 오발화 방지', () => {
      const passed = makeTrain({ trainCode: 'PASSED', arrivalSeconds: -10 });
      const future = makeTrain({ trainCode: 'FUTURE', arrivalSeconds: 180 });
      const arrivalWithPast: StationArrival = { up: [passed, future], down: [] };
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, arrival: arrivalWithPast }),
      );
      expect(result.current.directionalArrivals).toEqual([future]);
    });
  });

  describe('boardingListArrivals (#1326)', () => {
    it('방향 필터 결과가 있으면 directionalArrivals 그대로 — 방향 필터 유지', () => {
      mockResolveTripDirection.mockReturnValue('up');
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      expect(result.current.boardingListArrivals).toEqual([upTrain]);
    });

    it('방향 필터가 빈 쪽을 고르면 반대 방향으로 폴백 — "선택할 열차 없음" 회귀 차단', () => {
      mockResolveTripDirection.mockReturnValue('up');
      const onlyDown: StationArrival = { up: [], down: [downTrain] };
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, arrival: onlyDown }),
      );
      // 엄격 list(Gate 1용)는 그대로 비어있고, UI list만 폴백으로 노출된다.
      expect(result.current.directionalArrivals).toEqual([]);
      expect(result.current.boardingListArrivals).toEqual([downTrain]);
    });

    it('arrival null이면 빈 배열', () => {
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, arrival: null }),
      );
      expect(result.current.boardingListArrivals).toEqual([]);
    });

    it('양방향 모두 비면 빈 목록 — 진짜 도착 없음(empty-state)', () => {
      mockResolveTripDirection.mockReturnValue('up');
      const empty: StationArrival = { up: [], down: [] };
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, arrival: empty }),
      );
      expect(result.current.boardingListArrivals).toEqual([]);
    });

    it('폴백 시에도 음수 arrivalSeconds(지나간 열차)는 제외', () => {
      mockResolveTripDirection.mockReturnValue('up');
      const passed = makeTrain({ trainCode: 'PASSED', arrivalSeconds: -10 });
      const future = makeTrain({ trainCode: 'FUTURE', arrivalSeconds: 180 });
      const onlyDownMixed: StationArrival = { up: [], down: [passed, future] };
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, arrival: onlyDownMixed }),
      );
      expect(result.current.boardingListArrivals).toEqual([future]);
    });
  });

  describe('createLockFromTrain', () => {
    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      setInfoModeEnabledMock.mockClear();
    });
    afterEach(() => {
      (Date.now as jest.Mock).mockRestore();
    });

    it('expectedDurationMinutes를 ms로 변환해 lock 생성 + initialEtaSeconds 스냅샷(#897)', async () => {
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await act(async () => {
        result.current.createLockFromTrain(makeTrain({ trainCode: 'T-X', arrivalSeconds: 240 }));
      });
      expect(mockSetBoardingLock).toHaveBeenCalledWith({
        destinationId: 'dest-1',
        trainCode: 'T-X',
        boardingStationId: 'stn-A',
        boardingLine: '2',
        boardedAt: 1_700_000_000_000,
        expectedDurationMs: 20 * 60_000,
        initialEtaSeconds: 240,
        // #2290 P1 — user-tap은 탑승 확정 evidence가 아니므로 evidence=false가 stamp된다.
        boardingEvidence: false,
      });
    });

    it('expectedDurationMinutes null이면 fallback 30분', async () => {
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, expectedDurationMinutes: null }),
      );
      await act(async () => {
        result.current.createLockFromTrain(makeTrain());
      });
      expect(mockSetBoardingLock).toHaveBeenCalledWith(
        expect.objectContaining({ expectedDurationMs: 30 * 60_000 }),
      );
    });

    it('destinationId 또는 currentStation 누락이면 no-op', async () => {
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, destinationId: null }),
      );
      await act(async () => {
        result.current.createLockFromTrain(makeTrain());
      });
      expect(mockSetBoardingLock).not.toHaveBeenCalled();
    });

    it('currentStation null이어도 no-op', async () => {
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, currentStation: null }),
      );
      await act(async () => {
        result.current.createLockFromTrain(makeTrain());
      });
      expect(mockSetBoardingLock).not.toHaveBeenCalled();
    });

    it('boardingLine은 train.line을 사용한다 (currentStation.line이 fusion 잘못 잠금 상태여도 lock은 정확) — #663', async () => {
      // currentStation.line='2'(fusion이 옆 노선으로 잘못 잠긴 상태), train.line='7'(사용자가 탭한 실제 열차).
      // #1449 filter 회피: trip route를 2↔7 환승으로 두어 line 7이 allowedLines에 포함되게 한다.
      const transferRoute2to7 = makeTransferRoute({
        transferName: '강남구청',
        fromLine: '2',
        toLine: '7',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, route: transferRoute2to7 }),
      );
      await act(async () => {
        result.current.createLockFromTrain(makeTrain({ trainCode: 'T-7', line: '7' }));
      });
      expect(mockSetBoardingLock).toHaveBeenCalledWith(
        expect.objectContaining({ trainCode: 'T-7', boardingLine: '7' }),
      );
    });

    it('boardingStationId는 train.line 기준 정정 (#707) — 환승역에서 fusion 오인식된 옆 노선 id 제거', async () => {
      // currentStation은 fusion이 line 2(id=stn-A)로 잘못 잠금. train.line='7' → 같은 역명에서 line 7 stop id로 교정.
      mockFindStationByNameAndLine.mockReturnValue({
        id: 'stn-A-line7',
        name: '강남',
        line: '7',
        lineColor: '#000',
        lat: 37.5,
        lng: 127.0,
      });
      const transferRoute2to7 = makeTransferRoute({
        transferName: '강남구청',
        fromLine: '2',
        toLine: '7',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, route: transferRoute2to7 }),
      );
      await act(async () => {
        result.current.createLockFromTrain(makeTrain({ trainCode: 'T-7', line: '7' }));
      });
      expect(mockFindStationByNameAndLine).toHaveBeenCalledWith('강남', '7');
      expect(mockSetBoardingLock).toHaveBeenCalledWith(
        expect.objectContaining({ boardingStationId: 'stn-A-line7', boardingLine: '7' }),
      );
    });

    it('정정 lookup 실패 시 currentStation.id로 폴백 (#707) — stations.json에 매칭 없는 가상 케이스도 안전', async () => {
      mockFindStationByNameAndLine.mockReturnValue(null);
      const transferRoute2to7 = makeTransferRoute({
        transferName: '강남구청',
        fromLine: '2',
        toLine: '7',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, route: transferRoute2to7 }),
      );
      await act(async () => {
        result.current.createLockFromTrain(makeTrain({ trainCode: 'T-X', line: '7' }));
      });
      expect(mockSetBoardingLock).toHaveBeenCalledWith(
        expect.objectContaining({ boardingStationId: 'stn-A' }),
      );
    });

    // #1449 (ADR-015 §9 frontend) — trip route allowedLines 외 line traincode reject.
    describe('#1449 trip route line filter', () => {
      it('direct route(line 2) 일 때 trip 외 line(7) train 탭 → no-op (lock 채택 차단)', async () => {
        // defaultInputs.route = makeDirectRoute(_, '2'). train.line='7'은 trip 외.
        const { result } = renderHook(() => useBoardingLockController(defaultInputs));
        await act(async () => {
          result.current.createLockFromTrain(makeTrain({ trainCode: 'T-7', line: '7' }));
        });
        expect(mockSetBoardingLock).not.toHaveBeenCalled();
      });

      it('transfer route(2↔5, 왕십리) 다중 line 환승역에서 양쪽 line 모두 허용', async () => {
        const transferRoute = makeTransferRoute({
          transferName: '왕십리',
          fromLine: '2',
          toLine: '5',
          stopsToTransfer: 3,
          stopsFromTransfer: 4,
        });
        const { result } = renderHook(() =>
          useBoardingLockController({ ...defaultInputs, route: transferRoute }),
        );
        // line 5 (toLine) train 탭 → 허용
        await act(async () => {
          result.current.createLockFromTrain(makeTrain({ trainCode: 'T-5', line: '5' }));
        });
        expect(mockSetBoardingLock).toHaveBeenCalledWith(
          expect.objectContaining({ trainCode: 'T-5', boardingLine: '5' }),
        );
      });

      it('transfer route에서 양쪽 line 외 line(7) train 탭 → no-op', async () => {
        const transferRoute = makeTransferRoute({
          transferName: '왕십리',
          fromLine: '2',
          toLine: '5',
          stopsToTransfer: 3,
          stopsFromTransfer: 4,
        });
        const { result } = renderHook(() =>
          useBoardingLockController({ ...defaultInputs, route: transferRoute }),
        );
        await act(async () => {
          result.current.createLockFromTrain(makeTrain({ trainCode: 'T-7', line: '7' }));
        });
        expect(mockSetBoardingLock).not.toHaveBeenCalled();
      });

      it('trip 비활성(route=null) → filter 미적용 (free-trip 등 기존 UX 유지)', async () => {
        // route=null이면 allowedLines=undefined → filter skip. 어떤 line이든 lock 생성.
        const { result } = renderHook(() =>
          useBoardingLockController({ ...defaultInputs, route: null }),
        );
        await act(async () => {
          result.current.createLockFromTrain(makeTrain({ trainCode: 'T-9', line: '9' }));
        });
        expect(mockSetBoardingLock).toHaveBeenCalledWith(
          expect.objectContaining({ trainCode: 'T-9', boardingLine: '9' }),
        );
      });
    });

    it('#1777 lock 생성 성공 시 Success 햅틱이 발사된다', async () => {
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await act(async () => {
        result.current.createLockFromTrain(makeTrain({ trainCode: 'T-HAPTIC' }));
      });
      await waitFor(() => {
        expect(Haptics.notificationAsync).toHaveBeenCalledWith(
          Haptics.NotificationFeedbackType.Success,
        );
      });
    });

    it('#1777 lock 생성 실패(store rejection) 시 햅틱 미발사 — graceful no-op', async () => {
      mockSetBoardingLock.mockRejectedValueOnce(new Error('storage fail'));
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await act(async () => {
        result.current.createLockFromTrain(makeTrain({ trainCode: 'T-FAIL' }));
      });
      await waitFor(() => {
        expect(mockSetBoardingLock).toHaveBeenCalled();
      });
      expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    });

    // #1923 — BoardingTrainList 직접 탭은 lock 활성과 동급 사용자 명시 의향 표명.
    // setInfoModeEnabled(true) stamp는 createLock 시도와 별경로로 발사되어
    // lock 실패/만료해 lockless 전환되어도 backend lockless intermediate gate가 활성화된다.
    describe('#1923 infoModeEnabled stamp (사용자 명시 의향)', () => {
      it('createLockFromTrain 성공 시 setInfoModeEnabled(true) 1회 호출', async () => {
        const { result } = renderHook(() => useBoardingLockController(defaultInputs));
        await act(async () => {
          result.current.createLockFromTrain(makeTrain({ trainCode: 'T-INFO' }));
        });
        expect(setInfoModeEnabledMock).toHaveBeenCalledWith(true);
        expect(setInfoModeEnabledMock).toHaveBeenCalledTimes(1);
      });

      it('createLock 실패해도 setInfoModeEnabled(true)는 여전히 stamp (의향 표명 사실은 store 실패와 무관)', async () => {
        mockSetBoardingLock.mockRejectedValueOnce(new Error('store fail'));
        const { result } = renderHook(() => useBoardingLockController(defaultInputs));
        await act(async () => {
          result.current.createLockFromTrain(makeTrain({ trainCode: 'T-INFO-FAIL' }));
        });
        expect(setInfoModeEnabledMock).toHaveBeenCalledWith(true);
      });

      it('destinationId null이면 stamp 안 함 (createLock 진입 전 early return)', async () => {
        const { result } = renderHook(() =>
          useBoardingLockController({ ...defaultInputs, destinationId: null }),
        );
        await act(async () => {
          result.current.createLockFromTrain(makeTrain());
        });
        expect(setInfoModeEnabledMock).not.toHaveBeenCalled();
      });

      it('#1449 trip route 외 line은 stamp 안 함 (createLock 진입 전 line filter reject)', async () => {
        const { result } = renderHook(() => useBoardingLockController(defaultInputs));
        await act(async () => {
          // route는 line=2. line=9 train은 allowedLines filter에서 reject되어 stamp 도달 안 함.
          result.current.createLockFromTrain(makeTrain({ trainCode: 'T-WRONG', line: '9' }));
        });
        expect(setInfoModeEnabledMock).not.toHaveBeenCalled();
      });
    });

    // #2371 (Part of #2306) — BoardingTrainList 직접 탭(user-tap)도 boardingPrompt 응답과 동급
    // 명시 의향 표명이므로 navigationActive도 함께 켠다. hydrateLockFromCandidate(무탭 fusion
    // auto-lock 경로)에서는 절대 켜지면 안 됨(#1973 "명시 trigger 없이 자동 BG 금지") — 회귀
    // 방지 assertion은 아래 hydrateLockFromCandidate describe에 배치.
    describe('#2371 navigationActive wire (BG GPS 시작 트리거)', () => {
      beforeEach(() => {
        startNavigationMock.mockClear();
      });

      it('createLockFromTrain 성공 시 startNavigation() 1회 호출', async () => {
        const { result } = renderHook(() => useBoardingLockController(defaultInputs));
        await act(async () => {
          result.current.createLockFromTrain(makeTrain({ trainCode: 'T-NAV' }));
        });
        expect(startNavigationMock).toHaveBeenCalledTimes(1);
      });

      it('destinationId null이면 startNavigation 호출 안 함 (createLock 진입 전 early return)', async () => {
        const { result } = renderHook(() =>
          useBoardingLockController({ ...defaultInputs, destinationId: null }),
        );
        await act(async () => {
          result.current.createLockFromTrain(makeTrain());
        });
        expect(startNavigationMock).not.toHaveBeenCalled();
      });

      it('#1449 trip route 외 line은 startNavigation 호출 안 함 (createLock 진입 전 line filter reject)', async () => {
        const { result } = renderHook(() => useBoardingLockController(defaultInputs));
        await act(async () => {
          result.current.createLockFromTrain(makeTrain({ trainCode: 'T-WRONG', line: '9' }));
        });
        expect(startNavigationMock).not.toHaveBeenCalled();
      });
    });

    // #2330 (consensus-D, 설계 SSoT #2323 (3)) — 탭은 항상 우선(SSoT). consensus-confirmed
    // 제안과 다른 열차를 탭하면 mismatch telemetry가 기록되지만 lock 채택 자체는 차단되지 않는다.
    describe('#2330 consensus-mismatch telemetry', () => {
      let readSpy: jest.SpyInstance;
      const CONSENSUS_SUGGESTION = {
        stationId: '강남',
        trainCode: 'CONSENSUS-1',
        lineId: '2',
        confidence: 'consensus' as const,
        decidedAt: 1_700_000_000_000,
      };
      const MIRROR_WITH_CONSENSUS = {
        currentStationId: '강남',
        motionState: 'moving' as const,
        lastAdvanceEvidence: 'arvlcd-confirmed-train',
        lastAdvanceAt: 1_700_000_000_000,
        passedStations: [],
        receivedAt: Date.now(),
        lockSuggestion: CONSENSUS_SUGGESTION,
      };

      beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(1_700_000_000_000);
        mockRecordConsensusMismatch.mockClear();
        const mirror = jest.requireActual('../../utils/backendSsotMirror');
        readSpy = jest.spyOn(mirror, 'readBackendSsotMirror');
      });

      afterEach(() => {
        jest.useRealTimers();
        readSpy.mockRestore();
      });

      it('탭한 trainCode가 consensus 제안과 다르면 recordConsensusMismatch 호출 + lock은 탭이 채택', async () => {
        readSpy.mockResolvedValue(MIRROR_WITH_CONSENSUS);
        const { result } = renderHook(() => useBoardingLockController(defaultInputs));
        await act(async () => {
          jest.advanceTimersByTime(5_000);
        });
        await waitFor(() => {
          expect(result.current.lockSuggestion?.confidence).toBe('consensus');
        });
        await act(async () => {
          result.current.createLockFromTrain(makeTrain({ trainCode: 'TAPPED-1' }));
        });
        expect(mockRecordConsensusMismatch).toHaveBeenCalledWith('CONSENSUS-1', 'TAPPED-1');
        expect(mockSetBoardingLock).toHaveBeenCalledWith(
          expect.objectContaining({ trainCode: 'TAPPED-1' }),
        );
      });

      it('탭한 trainCode가 consensus 제안과 같으면 recordConsensusMismatch 미호출', async () => {
        readSpy.mockResolvedValue(MIRROR_WITH_CONSENSUS);
        const { result } = renderHook(() => useBoardingLockController(defaultInputs));
        await act(async () => {
          jest.advanceTimersByTime(5_000);
        });
        await waitFor(() => {
          expect(result.current.lockSuggestion?.confidence).toBe('consensus');
        });
        await act(async () => {
          result.current.createLockFromTrain(makeTrain({ trainCode: 'CONSENSUS-1' }));
        });
        expect(mockRecordConsensusMismatch).not.toHaveBeenCalled();
      });

      it('lockSuggestion 없으면 recordConsensusMismatch 미호출 (기존 동작)', async () => {
        const { result } = renderHook(() => useBoardingLockController(defaultInputs));
        await act(async () => {
          result.current.createLockFromTrain(makeTrain({ trainCode: 'ANY' }));
        });
        expect(mockRecordConsensusMismatch).not.toHaveBeenCalled();
      });
    });
  });

  // #915/#916 — backend autoLockCandidate hydrate. lockController가 createLock으로 위임.
  describe('hydrateLockFromCandidate (#915/#916)', () => {
    // #1014 acceptance gate: 이 describe의 기본 inputs는 candidate trainCode 'AUTO-7'을
    // directionalArrivals에 포함시켜 Gate 1을 통과하도록 설정.
    const autoArrival: StationArrival = {
      up: [makeTrain({ trainCode: 'AUTO-7' })],
      down: [],
    };
    const hydrateInputs: UseBoardingLockControllerInputs = {
      ...defaultInputs,
      arrival: autoArrival,
    };

    it('valid candidate + 컨텍스트 있음 → createLock 호출', async () => {
      const { result } = renderHook(() => useBoardingLockController(hydrateInputs));
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      const lock = mockSetBoardingLock.mock.calls[0][0];
      expect(lock).toMatchObject({
        destinationId: 'dest-1',
        trainCode: 'AUTO-7',
        boardingLine: '2',
        expectedDurationMs: 20 * 60_000,
      });
      // initialEtaSeconds는 자동 hydrate에선 미포함 (Seam A 지연 칩은 명시 탭 lock 한정).
      expect(lock.initialEtaSeconds).toBeUndefined();
      // #2290 P1 (RCA 재현) — candidate.from이 'transfer-swap'이 아닌 이 경로(#915/#916 원거리
      // autoLock candidate)는 Gate 2(motionStationary)가 "아직 원점 정적 대기 중"을 확인해야
      // 통과하므로 "아직 미탑승" 가능성이 정상 케이스다. evidence로 뭉뚱그리지 않고 false —
      // initialEtaSeconds도 없으므로 hasConsumedOriginWait는 보수적으로 대기를 유지한다.
      expect(lock.boardingEvidence).toBe(false);
    });

    // #2371 (Part of #2306) 회귀 방지 — hydrateLockFromCandidate는 무탭 fusion auto-lock
    // 경로이므로 startNavigation()이 절대 호출되면 안 된다(#1973 "명시 trigger 없이 자동 BG
    // 금지"). createLockFromTrain(user-tap)에서만 startNavigation을 호출하는지 대칭 검증.
    it('#2371: hydrateLockFromCandidate(무탭)는 startNavigation() 호출 안 함', async () => {
      startNavigationMock.mockClear();
      const { result } = renderHook(() => useBoardingLockController(hydrateInputs));
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      expect(startNavigationMock).not.toHaveBeenCalled();
    });

    it('역명+line 매칭 시 boardingStationId 정정', async () => {
      mockFindStationByNameAndLine.mockReturnValueOnce({ id: 'stn-A-line2', name: '강남', line: '2' });
      const { result } = renderHook(() => useBoardingLockController(hydrateInputs));
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      expect(mockSetBoardingLock.mock.calls[0][0].boardingStationId).toBe('stn-A-line2');
    });

    it('역명 매칭 실패 → currentStation.id 폴백', async () => {
      mockFindStationByNameAndLine.mockReturnValueOnce(null);
      const { result } = renderHook(() => useBoardingLockController(hydrateInputs));
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      expect(mockSetBoardingLock.mock.calls[0][0].boardingStationId).toBe('stn-A');
    });

    it('expectedDurationMinutes null → fallback 30분', async () => {
      const { result } = renderHook(() =>
        useBoardingLockController({ ...hydrateInputs, expectedDurationMinutes: null }),
      );
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      expect(mockSetBoardingLock.mock.calls[0][0].expectedDurationMs).toBe(30 * 60_000);
    });

    // #978 (PR #955 follow-up): destinationId null이면 free-trip sentinel으로 hydrate.
    // 사용자가 나중에 실제 destination 설정 → destination 변경 effect가 sentinel mismatch로 자동 release.
    it('destinationId null → sentinel destinationId + hydratedFromSentinel marker stamp (#978)', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_111_222);
      try {
        const { result } = renderHook(() =>
          useBoardingLockController({ ...hydrateInputs, destinationId: null }),
        );
        await act(async () => {
          result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
        });
        await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
        const created = mockSetBoardingLock.mock.calls[0][0];
        expect(created.destinationId).toBe('__free-trip-sentinel__');
        expect(created.hydratedFromSentinel).toEqual({
          destinationId: '__free-trip-sentinel__',
          sentinelAt: 1_700_000_111_222,
        });
      } finally {
        (Date.now as jest.Mock).mockRestore();
      }
    });

    it('destinationId 있음 → sentinel marker 없음 (기존 동작 유지)', async () => {
      const { result } = renderHook(() => useBoardingLockController(hydrateInputs));
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      const created = mockSetBoardingLock.mock.calls[0][0];
      expect(created.destinationId).toBe('dest-1');
      expect(created.hydratedFromSentinel).toBeUndefined();
    });

    it('currentStation null → no-op', async () => {
      const { result } = renderHook(() =>
        useBoardingLockController({ ...hydrateInputs, currentStation: null }),
      );
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      expect(mockSetBoardingLock).not.toHaveBeenCalled();
    });

    it('candidate.line 무효 값 → no-op (graceful)', async () => {
      const { result } = renderHook(() => useBoardingLockController(hydrateInputs));
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '99', subwayId: '1099' });
      });
      expect(mockSetBoardingLock).not.toHaveBeenCalled();
    });

    // hydrate no-op 케이스 공통 시드 — existing lock과 candidate trainCode만 다른 두 분기.
    async function seedExistingAndHydrate(opts: {
      existingTrainCode: string;
      candidateTrainCode: string;
    }) {
      const existing: BoardingLock = {
        destinationId: 'dest-1',
        trainCode: opts.existingTrainCode,
        boardingStationId: 'stn-A',
        boardingLine: '2',
        boardedAt: Date.now(),
        expectedDurationMs: 600_000,
      };
      mockGetBoardingLock.mockResolvedValue(existing);
      useBoardingLockStore.setState({ lock: existing });
      const { result } = renderHook(() => useBoardingLockController(hydrateInputs));
      await waitFor(() => expect(useBoardingLockStore.getState().lock?.trainCode).toBe(opts.existingTrainCode));
      mockSetBoardingLock.mockClear();
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: opts.candidateTrainCode, line: '2', subwayId: '1002' });
      });
    }

    it('idempotent — 동일 trainCode + line이 이미 활성이면 재생성 안 함', async () => {
      await seedExistingAndHydrate({ existingTrainCode: 'AUTO-7', candidateTrainCode: 'AUTO-7' });
      expect(mockSetBoardingLock).not.toHaveBeenCalled();
    });

    it('lock 이미 존재 → 다른 trainCode candidate 와도 no-op (사용자 명시 lock overwrite 차단)', async () => {
      await seedExistingAndHydrate({ existingTrainCode: 'OLD-1', candidateTrainCode: 'NEW-2' });
      // 정책: lock 존재 시 hydrate no-op. 사용자가 picker 탭한 lock을 backend cron candidate가
      // silently overwrite하지 않게 보호. swap은 createLockFromTrain으로 명시 호출.
      expect(mockSetBoardingLock).not.toHaveBeenCalled();
      expect(useBoardingLockStore.getState().lock?.trainCode).toBe('OLD-1');
    });

    it('createLock storage 실패 시 graceful — .catch가 swallow', async () => {
      // storage 일시 실패 시뮬레이션. createLock 내부의 setBoardingLock이 throw하면
      // useBoardingLockController의 .catch 분기로 흡수돼 다음 sync에서 자연 재시도.
      mockSetBoardingLock.mockRejectedValueOnce(new Error('storage'));
      const { result } = renderHook(() => useBoardingLockController(hydrateInputs));
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      // throw가 RN 외부로 새지 않으면 OK — 다음 fix에서 createLock이 다시 호출되도록 lock은 null 유지.
      await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      expect(useBoardingLockStore.getState().lock).toBeNull();
    });

    // #1014 RC2 acceptance gate
    describe('#1014 acceptance gate', () => {
      it('Gate 1: candidate.trainCode가 directionalArrivals에 없으면 no-op (origin 이미 지난 열차 차단)', async () => {
        const arrivalOther: StationArrival = {
          up: [makeTrain({ trainCode: 'OTHER-1' })],
          down: [],
        };
        const { result } = renderHook(() =>
          useBoardingLockController({ ...defaultInputs, arrival: arrivalOther }),
        );
        await act(async () => {
          result.current.hydrateLockFromCandidate({ trainCode: 'PAST-TRAIN', line: '2', subwayId: '1002' });
        });
        expect(mockSetBoardingLock).not.toHaveBeenCalled();
      });

      it('Gate 1: arrival null이면 no-op (arrival 목록 없음 → 방향 확인 불가)', async () => {
        const { result } = renderHook(() =>
          useBoardingLockController({ ...defaultInputs, arrival: null }),
        );
        await act(async () => {
          result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
        });
        expect(mockSetBoardingLock).not.toHaveBeenCalled();
      });

      it('Gate 1: direction=up일 때 candidate가 down에만 있으면 no-op (방향 불일치 차단)', async () => {
        mockResolveTripDirection.mockReturnValue('up');
        const arrivalDirectional: StationArrival = {
          up: [makeTrain({ trainCode: 'UP-TRAIN' })],
          down: [makeTrain({ trainCode: 'DOWN-TRAIN' })],
        };
        const { result } = renderHook(() =>
          useBoardingLockController({ ...defaultInputs, arrival: arrivalDirectional }),
        );
        await act(async () => {
          result.current.hydrateLockFromCandidate({ trainCode: 'DOWN-TRAIN', line: '2', subwayId: '1002' });
        });
        expect(mockSetBoardingLock).not.toHaveBeenCalled();
      });

      it('Gate 2: motionStationary=false + speedMps >= threshold → 양쪽 신호 이동 확인 → no-op', async () => {
        // motionStationary=false 단독으로는 차단하지 않는다 — init 직후 false 초기값과 구별 불가.
        // speedMps가 이동을 교차 확인할 때만 차단.
        const { result } = renderHook(() =>
          useBoardingLockController({ ...hydrateInputs, motionStationary: false, speedMps: 1.5 }),
        );
        await act(async () => {
          result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
        });
        expect(mockSetBoardingLock).not.toHaveBeenCalled();
      });

      it('Gate 2: motionStationary=false + speedMps null → 단일 신호 불확실 → hydrate 허용 (init race 방지)', async () => {
        // motionStationary=false는 앱 init 직후 useState 초기값일 수 있다.
        // speedMps 미측정이면 이동 확신 불가 → 보수적으로 통과.
        const { result } = renderHook(() =>
          useBoardingLockController({ ...hydrateInputs, motionStationary: false }),
        );
        await act(async () => {
          result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
        });
        await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      });

      it('Gate 2: speedMps >= STATIC_SPEED_THRESHOLD_MPS(0.5)면 이동 중 → no-op', async () => {
        const { result } = renderHook(() =>
          useBoardingLockController({ ...hydrateInputs, speedMps: 1.5 }),
        );
        await act(async () => {
          result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
        });
        expect(mockSetBoardingLock).not.toHaveBeenCalled();
      });

      it('Gate 2: motionStationary=true면 정적 → hydrate 허용 (speedMps 무관)', async () => {
        const { result } = renderHook(() =>
          useBoardingLockController({ ...hydrateInputs, motionStationary: true, speedMps: 0.8 }),
        );
        await act(async () => {
          result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
        });
        await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      });

      it('Gate 2: speedMps < STATIC_SPEED_THRESHOLD_MPS(0.5)면 정적 → hydrate 허용', async () => {
        const { result } = renderHook(() =>
          useBoardingLockController({ ...hydrateInputs, speedMps: 0.2 }),
        );
        await act(async () => {
          result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
        });
        await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      });

      it('Gate 2: motionStationary/speedMps 모두 미측정이면 보수적 통과 허용 (false negative 방지)', async () => {
        // motionStationary=undefined, speedMps=undefined → 신호 없음 → 통과
        const { result } = renderHook(() =>
          useBoardingLockController(hydrateInputs), // motionStationary/speedMps 미전달
        );
        await act(async () => {
          result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
        });
        await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      });

      // #1449 (ADR-015 §9 frontend) — trip route allowedLines 외 candidate.line reject.
      // backend autoLock(#916) 9-AND gate는 device-side trip context를 모르므로 device가 한 번 더 검증.
      describe('#1449 trip route line filter', () => {
        it('direct route(line 2) 일 때 candidate.line=7 → no-op (trip 외 line autoLock 차단)', async () => {
          // defaultInputs.route = makeDirectRoute(_, '2'). candidate.line='7'은 trip 외.
          // arrival에 AUTO-7이 있어 Gate 1은 통과해도 line filter에서 차단됨.
          const arrivalLine7: StationArrival = {
            up: [makeTrain({ trainCode: 'AUTO-7', line: '7' })],
            down: [],
          };
          const { result } = renderHook(() =>
            useBoardingLockController({ ...defaultInputs, arrival: arrivalLine7 }),
          );
          await act(async () => {
            result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '7', subwayId: '1007' });
          });
          expect(mockSetBoardingLock).not.toHaveBeenCalled();
        });

        it('transfer route(2↔5, 청량리) 다중 line 환승역 — 양쪽 line 모두 hydrate 허용', async () => {
          const transferRoute = makeTransferRoute({
            transferName: '청량리',
            fromLine: '2',
            toLine: '5',
            stopsToTransfer: 3,
            stopsFromTransfer: 4,
          });
          const arrivalLine5: StationArrival = {
            up: [makeTrain({ trainCode: 'AUTO-5', line: '5' })],
            down: [],
          };
          const { result } = renderHook(() =>
            useBoardingLockController({
              ...defaultInputs,
              route: transferRoute,
              arrival: arrivalLine5,
            }),
          );
          await act(async () => {
            result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-5', line: '5', subwayId: '1005' });
          });
          await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
          expect(mockSetBoardingLock.mock.calls[0][0]).toMatchObject({
            trainCode: 'AUTO-5',
            boardingLine: '5',
          });
        });

        it('transfer route(2↔5)에서 양쪽 line 외 line(7) candidate → no-op', async () => {
          const transferRoute = makeTransferRoute({
            transferName: '왕십리',
            fromLine: '2',
            toLine: '5',
            stopsToTransfer: 3,
            stopsFromTransfer: 4,
          });
          const arrivalLine7: StationArrival = {
            up: [makeTrain({ trainCode: 'AUTO-7', line: '7' })],
            down: [],
          };
          const { result } = renderHook(() =>
            useBoardingLockController({
              ...defaultInputs,
              route: transferRoute,
              arrival: arrivalLine7,
            }),
          );
          await act(async () => {
            result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '7', subwayId: '1007' });
          });
          expect(mockSetBoardingLock).not.toHaveBeenCalled();
        });

        it('trip 비활성(route=null) → line filter 미적용 (기존 free-trip hydrate 경로 유지)', async () => {
          const arrivalLine9: StationArrival = {
            up: [makeTrain({ trainCode: 'AUTO-9', line: '9' })],
            down: [],
          };
          const { result } = renderHook(() =>
            useBoardingLockController({
              ...defaultInputs,
              route: null,
              destinationId: null,
              arrival: arrivalLine9,
            }),
          );
          await act(async () => {
            result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-9', line: '9', subwayId: '1009' });
          });
          await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
        });
      });
    });
  });

  describe('releaseLock', () => {
    it('store releaseLock으로 위임 — storage clear', async () => {
      useBoardingLockStore.setState({
        lock: {
          destinationId: 'dest-1',
          trainCode: 'T-1',
          boardingStationId: 'stn-A',
          boardingLine: '2',
          boardedAt: Date.now(),
          expectedDurationMs: 600_000,
        },
      });
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await act(async () => {
        result.current.releaseLock();
      });
      await waitFor(() => expect(mockClearBoardingLock).toHaveBeenCalled());
    });
  });

  describe('destination 변경 자동 release', () => {
    it('현재 lock의 destinationId가 input.destinationId와 다르면 자동 release', async () => {
      const stale: BoardingLock = {
        destinationId: 'dest-old',
        trainCode: 'T-1',
        boardingStationId: 'stn-A',
        boardingLine: '2',
        boardedAt: Date.now(),
        expectedDurationMs: 600_000,
      };
      mockGetBoardingLock.mockResolvedValueOnce(stale);
      renderHook(() => useBoardingLockController(defaultInputs));
      await waitFor(() => expect(mockClearBoardingLock).toHaveBeenCalled());
    });

    it('같은 destinationId면 release 안 함', async () => {
      const matching: BoardingLock = {
        destinationId: 'dest-1',
        trainCode: 'T-1',
        boardingStationId: 'stn-A',
        boardingLine: '2',
        boardedAt: Date.now(),
        expectedDurationMs: 600_000,
      };
      mockGetBoardingLock.mockResolvedValueOnce(matching);
      renderHook(() => useBoardingLockController(defaultInputs));
      await waitFor(() => expect(useBoardingLockStore.getState().lock).toEqual(matching));
      expect(mockClearBoardingLock).not.toHaveBeenCalled();
    });

    // #978 — free-trip sentinel lock 상태 + destinationId=null이면 같은 free trip으로 간주, 유지.
    it('sentinel lock + destinationId null이면 release 안 함 (같은 free trip 유지) (#978)', async () => {
      const sentinelLock: BoardingLock = {
        destinationId: '__free-trip-sentinel__',
        trainCode: 'AUTO-7',
        boardingStationId: 'stn-A',
        boardingLine: '2',
        boardedAt: Date.now(),
        expectedDurationMs: 600_000,
        hydratedFromSentinel: {
          destinationId: '__free-trip-sentinel__',
          sentinelAt: Date.now(),
        },
      };
      mockGetBoardingLock.mockResolvedValueOnce(sentinelLock);
      renderHook(() =>
        useBoardingLockController({ ...defaultInputs, destinationId: null }),
      );
      await waitFor(() => expect(useBoardingLockStore.getState().lock).toEqual(sentinelLock));
      expect(mockClearBoardingLock).not.toHaveBeenCalled();
    });

    // #978 — sentinel lock 활성 중 사용자가 실제 destination 설정 → sentinel mismatch로 invalidate.
    it('sentinel lock + 실 destinationId 설정 → 자동 release (cross-talk 차단) (#978)', async () => {
      const sentinelLock: BoardingLock = {
        destinationId: '__free-trip-sentinel__',
        trainCode: 'AUTO-7',
        boardingStationId: 'stn-A',
        boardingLine: '2',
        boardedAt: Date.now(),
        expectedDurationMs: 600_000,
        hydratedFromSentinel: {
          destinationId: '__free-trip-sentinel__',
          sentinelAt: Date.now(),
        },
      };
      mockGetBoardingLock.mockResolvedValueOnce(sentinelLock);
      renderHook(() =>
        useBoardingLockController({ ...defaultInputs, destinationId: 'dest-real' }),
      );
      await waitFor(() => expect(mockClearBoardingLock).toHaveBeenCalled());
    });
  });

  describe('AppState 만료 검사', () => {
    it("AppState 'active' 진입 시 checkExpiry 트리거 → 만료된 lock 정리", async () => {
      const expiredLock: BoardingLock = {
        destinationId: 'dest-1',
        trainCode: 'T-1',
        boardingStationId: 'stn-A',
        boardingLine: '2',
        boardedAt: 1, // 매우 과거 → 항상 만료
        expectedDurationMs: 1,
      };
      useBoardingLockStore.setState({ lock: expiredLock });
      const listeners: Array<(s: 'active' | 'background') => void> = [];
      jest.spyOn(AppState, 'addEventListener').mockImplementation(((event: string, h: (s: 'active' | 'background') => void) => {
        listeners.push(h);
        return { remove: jest.fn() };
      }) as never);

      renderHook(() => useBoardingLockController(defaultInputs));
      await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
      await act(async () => {
        listeners[0]('active');
      });
      await waitFor(() => expect(mockClearBoardingLock).toHaveBeenCalled());
    });

    it("'background' 진입은 checkExpiry 트리거 안 함", async () => {
      const listeners: Array<(s: 'active' | 'background') => void> = [];
      jest.spyOn(AppState, 'addEventListener').mockImplementation(((event: string, h: (s: 'active' | 'background') => void) => {
        listeners.push(h);
        return { remove: jest.fn() };
      }) as never);

      useBoardingLockStore.setState({ lock: null });
      renderHook(() => useBoardingLockController(defaultInputs));
      await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
      mockClearBoardingLock.mockClear();
      await act(async () => {
        listeners[0]('background');
      });
      expect(mockClearBoardingLock).not.toHaveBeenCalled();
    });

    it('unmount 시 AppState listener remove', async () => {
      const remove = jest.fn();
      jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove } as never);
      const { unmount } = renderHook(() => useBoardingLockController(defaultInputs));
      unmount();
      expect(remove).toHaveBeenCalled();
    });
  });

  describe('lockSuggestion 1순위 채택 (#1534 S1 T9b, ADR-016)', () => {
    let readSpy: jest.SpyInstance;

    const SUGGESTION = {
      stationId: '강남',
      trainCode: 'AUTO-1',
      lineId: '2',
      confidence: 'high' as const,
      decidedAt: 1_700_000_000_000,
    };

    const MIRROR = {
      currentStationId: '강남',
      motionState: 'moving' as const,
      lastAdvanceEvidence: 'arvlcd-confirmed-train',
      lastAdvanceAt: 1_700_000_000_000,
      passedStations: [],
      receivedAt: Date.now(),
      lockSuggestion: SUGGESTION,
    };

    // 폴링 1 cycle (5s tick) → effect flush (0s tick) — suggestion 채택 흐름 settle 헬퍼.
    async function tickAndSettleCycle() {
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await act(async () => {
        jest.advanceTimersByTime(0);
      });
    }

    // suggestion reject 시나리오 공용 setup — lock=null + createLock mock + renderHook 후 settle 까지.
    // assertion(`expect(createLockMock).not.toHaveBeenCalled()`)는 caller가 검증.
    function setupRejectScenario(inputs: UseBoardingLockControllerInputs = defaultInputs) {
      const createLockMock = jest.fn().mockResolvedValue(undefined);
      useBoardingLockStore.setState({ lock: null, createLock: createLockMock });
      renderHook(() => useBoardingLockController(inputs));
      return createLockMock;
    }

    beforeEach(() => {
      jest.useFakeTimers();
      // jest.requireActual로 module을 가져오고 readBackendSsotMirror만 spy.
      const mirror = jest.requireActual('../../utils/backendSsotMirror');
      readSpy = jest.spyOn(mirror, 'readBackendSsotMirror');
    });

    afterEach(() => {
      jest.useRealTimers();
      readSpy.mockRestore();
    });

    it('lockSuggestion → createLock 호출 (1순위 채택, 9-AND gate 우회)', async () => {
      readSpy.mockResolvedValue(MIRROR);
      const createLockMock = jest.fn().mockResolvedValue(undefined);
      useBoardingLockStore.setState({
        lock: null,
        createLock: createLockMock,
      });
      renderHook(() => useBoardingLockController(defaultInputs));
      // 첫 polling tick (5s) 후 readBackendSsotMirror → setState → createLock effect 발사
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await waitFor(() => {
        expect(createLockMock).toHaveBeenCalled();
      });
      const arg = createLockMock.mock.calls[0][0];
      expect(arg.trainCode).toBe('AUTO-1');
      expect(arg.boardingLine).toBe('2');
      // motion gate / directionalArrivals 검증 X (suggestion 채택은 우회)
      // #2290 P1 (RCA 재현): lockSuggestion은 backend(#1534)가 arvlcd-confirmed evidence로 이미
      // 합의한 뒤 통보한 결과라 생성 시점 자체가 탑승 evidence다. evidence=false로 stamp되면
      // (수정 전 버그) `hasConsumedOriginWait`가 initialEtaSeconds도 없는 이 lock 타입에서 trip
      // 내내 false로 고착돼 출발 대기가 과다 합산된다.
      const evidence = createLockMock.mock.calls[0][1];
      expect(evidence).toBe(true);
    });

    it('이미 lock 존재 → suggestion 채택 skip (idempotent)', async () => {
      readSpy.mockResolvedValue(MIRROR);
      const createLockMock = jest.fn().mockResolvedValue(undefined);
      const existing: BoardingLock = {
        destinationId: 'dest-1',
        trainCode: 'USER-TAP',
        boardingStationId: 'stn-A',
        boardingLine: '2',
        boardedAt: Date.now(),
        expectedDurationMs: 30 * 60_000,
      };
      // loadLock effect도 같은 lock을 반환하도록 모킹 — selector가 hydrate한 후에도 lock 유지.
      mockGetBoardingLock.mockResolvedValue(existing);
      useBoardingLockStore.setState({ lock: existing, createLock: createLockMock });
      renderHook(() => useBoardingLockController(defaultInputs));
      await tickAndSettleCycle();
      expect(createLockMock).not.toHaveBeenCalled();
    });

    // #2278 (PR #2287 리뷰 P1-1) — 사용자 명시 하차 stamp(legAdvance)가 살아있는 동안 stale/
    // 불일치 lockSuggestion으로 lock을 재-hydrate해 그 stamp를 무력화하지 않도록 하는 가드.
    // 원 버그(#2278 RCA): lock > legAdvance 우선순위 chain에서 lockSuggestion 자동 hydrate가
    // stale mirror(예: 이전 leg '7')로 lock을 재생성하면 stamp가 lock에 덮여 다시 fromLine으로
    // 되돌아간다.
    describe('#2278 P1-1 — legAdvance stamp staleness 가드', () => {
      it('lockSuggestion.decidedAt이 stamp.stampedAt보다 이전(stale)이면 skip', async () => {
        // SUGGESTION.decidedAt=1_700_000_000_000. stampedAt을 그보다 나중으로 설정 — 사용자가
        // 하차 응답을 한 뒤에 backend가 그 이전 시점 기준으로 decide한 stale suggestion.
        useLegAdvanceStore.setState({ nextLine: '2', stampedAt: SUGGESTION.decidedAt + 1_000 });
        readSpy.mockResolvedValue(MIRROR);
        const createLockMock = setupRejectScenario();
        await tickAndSettleCycle();
        expect(createLockMock).not.toHaveBeenCalled();
      });

      it('lockSuggestion.lineId가 stamp.nextLine과 다르면(불일치) stamp가 살아있는 동안 skip', async () => {
        // 7→2 환승 route — 두 line 모두 allowedLines를 통과하므로(기존 #1449 가드와 독립적으로)
        // P1-1 disagreement 가드 자체를 isolate해서 검증한다. stampedAt은 decidedAt보다
        // 이전(staleness 가드는 통과) — 그러나 line이 stamp('2')와 다르므로(suggestion='7') skip.
        const transferRoute = {
          type: 'transfer' as const,
          transferName: '건대입구',
          fromLine: '7' as const,
          toLine: '2' as const,
          stopsToTransfer: 0,
          stopsFromTransfer: 5,
          secondsToTransfer: 0,
          secondsFromTransfer: 600,
        };
        useLegAdvanceStore.setState({ nextLine: '2', stampedAt: SUGGESTION.decidedAt - 1_000 });
        readSpy.mockResolvedValue({
          ...MIRROR,
          lockSuggestion: { ...SUGGESTION, lineId: '7' },
        });
        const createLockMock = setupRejectScenario({ ...defaultInputs, route: transferRoute });
        await tickAndSettleCycle();
        expect(createLockMock).not.toHaveBeenCalled();
      });

      it('lockSuggestion이 stamp와 일치 + fresh(decidedAt >= stampedAt)면 정상 채택 (과잉 차단 아님)', async () => {
        useLegAdvanceStore.setState({ nextLine: '2', stampedAt: SUGGESTION.decidedAt - 1_000 });
        readSpy.mockResolvedValue(MIRROR); // lineId='2' — stamp.nextLine과 일치.
        const createLockMock = jest.fn().mockResolvedValue(undefined);
        useBoardingLockStore.setState({ lock: null, createLock: createLockMock });
        renderHook(() => useBoardingLockController(defaultInputs));
        await tickAndSettleCycle();
        expect(createLockMock).toHaveBeenCalled();
      });

      it('legAdvance stamp가 없으면(nextLine=null) 기존 동작 그대로 (가드 미개입)', async () => {
        useLegAdvanceStore.setState({ nextLine: null, stampedAt: null });
        readSpy.mockResolvedValue(MIRROR);
        const createLockMock = jest.fn().mockResolvedValue(undefined);
        useBoardingLockStore.setState({ lock: null, createLock: createLockMock });
        renderHook(() => useBoardingLockController(defaultInputs));
        await tickAndSettleCycle();
        expect(createLockMock).toHaveBeenCalled();
      });
    });

    it('lockSuggestion lineId가 trip route 허용 line이 아니면 reject', async () => {
      readSpy.mockResolvedValue({
        ...MIRROR,
        lockSuggestion: { ...SUGGESTION, lineId: '7' }, // route는 line 2
      });
      const createLockMock = setupRejectScenario();
      await tickAndSettleCycle();
      expect(createLockMock).not.toHaveBeenCalled();
    });

    it('lockSuggestion lineId가 invalid line code (모르는 노선) → reject', async () => {
      readSpy.mockResolvedValue({
        ...MIRROR,
        lockSuggestion: { ...SUGGESTION, lineId: 'mars' },
      });
      const createLockMock = setupRejectScenario();
      await tickAndSettleCycle();
      expect(createLockMock).not.toHaveBeenCalled();
    });

    it('createLock 실패는 graceful — throw 안 함 (다음 cycle 재시도)', async () => {
      readSpy.mockResolvedValue(MIRROR);
      const createLockMock = jest.fn().mockRejectedValue(new Error('storage'));
      useBoardingLockStore.setState({ lock: null, createLock: createLockMock });
      renderHook(() => useBoardingLockController(defaultInputs));
      await expect(
        act(async () => {
          jest.advanceTimersByTime(5_000);
        }),
      ).resolves.toBeUndefined();
    });

    it('destinationId null → free-trip sentinel으로 createLock', async () => {
      readSpy.mockResolvedValue(MIRROR);
      const createLockMock = jest.fn().mockResolvedValue(undefined);
      useBoardingLockStore.setState({ lock: null, createLock: createLockMock });
      renderHook(() =>
        useBoardingLockController({ ...defaultInputs, destinationId: null }),
      );
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await waitFor(() => {
        expect(createLockMock).toHaveBeenCalled();
      });
      const arg = createLockMock.mock.calls[0][0];
      expect(arg.hydratedFromSentinel).toBeDefined();
    });

    it('lockSuggestion 부재 → createLock 미호출 (caller 9-AND fallback)', async () => {
      readSpy.mockResolvedValue(null);
      const createLockMock = setupRejectScenario();
      await tickAndSettleCycle();
      expect(createLockMock).not.toHaveBeenCalled();
    });

    it('result.lockSuggestion 노출 (UI consumer 진입점)', async () => {
      readSpy.mockResolvedValue(MIRROR);
      useBoardingLockStore.setState({ lock: null });
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await waitFor(() => {
        expect(result.current.lockSuggestion).toEqual(SUGGESTION);
      });
    });

    it('stationByName lookup 실패 + currentStation null → lockSuggestion.stationId fallback (line 194)', async () => {
      readSpy.mockResolvedValue(MIRROR);
      mockFindStationByNameAndLine.mockReturnValue(null);
      const createLockMock = jest.fn().mockResolvedValue(undefined);
      useBoardingLockStore.setState({ lock: null, createLock: createLockMock });
      renderHook(() =>
        useBoardingLockController({ ...defaultInputs, currentStation: null }),
      );
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await waitFor(() => {
        expect(createLockMock).toHaveBeenCalled();
      });
      expect(createLockMock.mock.calls[0][0].boardingStationId).toBe('강남');
    });

    it('expectedDurationMinutes null → FALLBACK_BOARDING_DURATION_MINUTES (line 198)', async () => {
      readSpy.mockResolvedValue(MIRROR);
      const createLockMock = jest.fn().mockResolvedValue(undefined);
      useBoardingLockStore.setState({ lock: null, createLock: createLockMock });
      renderHook(() =>
        useBoardingLockController({ ...defaultInputs, expectedDurationMinutes: null }),
      );
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await waitFor(() => {
        expect(createLockMock).toHaveBeenCalled();
      });
      // FALLBACK = 30분 (constants/boardingLock.ts) → 30 * 60_000 ms
      expect(createLockMock.mock.calls[0][0].expectedDurationMs).toBe(30 * 60_000);
    });

    it('lockSuggestion.stationId가 빈 문자열 + currentStation null → boardingStationId=빈 → guard return (line 195)', async () => {
      readSpy.mockResolvedValue({
        ...MIRROR,
        // 형식 검증을 우회하기 위해 직접 entry override — 실제 readBackendSsotMirror는 빈 stationId reject지만
        // 미래 schema migration / 손상 KV 에 대비한 guard 분기 cover.
        lockSuggestion: { ...SUGGESTION, stationId: '' },
      });
      mockFindStationByNameAndLine.mockReturnValue(null);
      const createLockMock = setupRejectScenario({
        ...defaultInputs,
        currentStation: null,
      });
      await tickAndSettleCycle();
      expect(createLockMock).not.toHaveBeenCalled();
    });

    // #2330 (consensus-D, 설계 SSoT #2323 (3)) — confidence='consensus'는 lock 승격 금지.
    // backend legConsensus는 UI 표시/floor 힌트 전용으로만 forward — 자동 hydrate 경로가
    // 이 값을 다른 confidence(high/medium/low)와 동일하게 채택하면 "오토락 부활" 오해를 준다.
    it('confidence=consensus → createLock 미호출 (lock 승격 금지, UI 표시 전용)', async () => {
      readSpy.mockResolvedValue({
        ...MIRROR,
        lockSuggestion: { ...SUGGESTION, confidence: 'consensus' as const },
      });
      const createLockMock = setupRejectScenario();
      await tickAndSettleCycle();
      expect(createLockMock).not.toHaveBeenCalled();
    });

    it('confidence=consensus 여도 result.lockSuggestion에는 노출 (UI consumer 진입점)', async () => {
      readSpy.mockResolvedValue({
        ...MIRROR,
        lockSuggestion: { ...SUGGESTION, confidence: 'consensus' as const },
      });
      useBoardingLockStore.setState({ lock: null });
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      await waitFor(() => {
        expect(result.current.lockSuggestion?.confidence).toBe('consensus');
      });
    });
  });

});
