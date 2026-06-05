import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import {
  useBoardingLockController,
  type UseBoardingLockControllerInputs,
} from '../useBoardingLockController';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { Station } from '../../../../shared/types/station';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';

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

  describe('createLockFromTrain', () => {
    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
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
      // currentStation.line='2'(fusion이 옆 노선으로 잘못 잠긴 상태), train.line='7'(사용자가 탭한 실제 열차)
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
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
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
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
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await act(async () => {
        result.current.createLockFromTrain(makeTrain({ trainCode: 'T-X', line: '7' }));
      });
      expect(mockSetBoardingLock).toHaveBeenCalledWith(
        expect.objectContaining({ boardingStationId: 'stn-A' }),
      );
    });
  });

  // #915/#916 — backend autoLockCandidate hydrate. lockController가 createLock으로 위임.
  describe('hydrateLockFromCandidate (#915/#916)', () => {
    it('valid candidate + 컨텍스트 있음 → createLock 호출', async () => {
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
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
    });

    it('역명+line 매칭 시 boardingStationId 정정', async () => {
      mockFindStationByNameAndLine.mockReturnValueOnce({ id: 'stn-A-line2', name: '강남', line: '2' });
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      expect(mockSetBoardingLock.mock.calls[0][0].boardingStationId).toBe('stn-A-line2');
    });

    it('역명 매칭 실패 → currentStation.id 폴백', async () => {
      mockFindStationByNameAndLine.mockReturnValueOnce(null);
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      expect(mockSetBoardingLock.mock.calls[0][0].boardingStationId).toBe('stn-A');
    });

    it('expectedDurationMinutes null → fallback 30분', async () => {
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, expectedDurationMinutes: null }),
      );
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      await waitFor(() => expect(mockSetBoardingLock).toHaveBeenCalled());
      expect(mockSetBoardingLock.mock.calls[0][0].expectedDurationMs).toBe(30 * 60_000);
    });

    it('destinationId null → no-op', async () => {
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, destinationId: null }),
      );
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      expect(mockSetBoardingLock).not.toHaveBeenCalled();
    });

    it('currentStation null → no-op', async () => {
      const { result } = renderHook(() =>
        useBoardingLockController({ ...defaultInputs, currentStation: null }),
      );
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      expect(mockSetBoardingLock).not.toHaveBeenCalled();
    });

    it('candidate.line 무효 값 → no-op (graceful)', async () => {
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '99', subwayId: '1099' });
      });
      expect(mockSetBoardingLock).not.toHaveBeenCalled();
    });

    it('idempotent — 동일 trainCode + line이 이미 활성이면 재생성 안 함', async () => {
      const existing: BoardingLock = {
        destinationId: 'dest-1',
        trainCode: 'AUTO-7',
        boardingStationId: 'stn-A',
        boardingLine: '2',
        boardedAt: Date.now(),
        expectedDurationMs: 600_000,
      };
      // loadLock(mount effect)이 store를 덮어쓰지 않도록 storage mock도 동일 lock 반환.
      mockGetBoardingLock.mockResolvedValue(existing);
      useBoardingLockStore.setState({ lock: existing });
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await waitFor(() => expect(useBoardingLockStore.getState().lock?.trainCode).toBe('AUTO-7'));
      mockSetBoardingLock.mockClear();
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'AUTO-7', line: '2', subwayId: '1002' });
      });
      expect(mockSetBoardingLock).not.toHaveBeenCalled();
    });

    it('lock 이미 존재 → 다른 trainCode candidate 와도 no-op (사용자 명시 lock overwrite 차단)', async () => {
      const existing: BoardingLock = {
        destinationId: 'dest-1',
        trainCode: 'OLD-1',
        boardingStationId: 'stn-A',
        boardingLine: '2',
        boardedAt: Date.now(),
        expectedDurationMs: 600_000,
      };
      mockGetBoardingLock.mockResolvedValue(existing);
      useBoardingLockStore.setState({ lock: existing });
      const { result } = renderHook(() => useBoardingLockController(defaultInputs));
      await waitFor(() => expect(useBoardingLockStore.getState().lock?.trainCode).toBe('OLD-1'));
      mockSetBoardingLock.mockClear();
      await act(async () => {
        result.current.hydrateLockFromCandidate({ trainCode: 'NEW-2', line: '2', subwayId: '1002' });
      });
      // 정책: lock 존재 시 hydrate no-op. 사용자가 picker 탭한 lock을 backend cron candidate가
      // silently overwrite하지 않게 보호. swap은 createLockFromTrain으로 명시 호출.
      expect(mockSetBoardingLock).not.toHaveBeenCalled();
      expect(useBoardingLockStore.getState().lock?.trainCode).toBe('OLD-1');
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
});
