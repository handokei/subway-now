/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { act, renderHook } from '@testing-library/react-native';
import {
  useFusedNearestStation,
  pickArrivalForStationName,
} from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import {
  arrivalRet,
  positionRet,
  makeTrain as train,
} from '../../../../testUtils/positionApiFixtures';
import type { StationArrival, ArrivalInfo } from '../../../../shared/types/arrival';
import type { Station } from '../../../../shared/types/station';
import { makeDirectRoute, makeTransferRoute, makeMultiTransferRoute } from '../../../../testUtils/routeFixtures';
import { CURRENT_STATION_STALE_DEMOTE_MS } from '../../../../shared/constants/realtime';
import {
  getFusionDebugEntries,
  clearFusionDebugEntries,
  type DisplayDemoteEntry,
} from '../../utils/fusionDebugBuffer';

jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
// #1926 — lockless 4-signal consensus 가드는 positionTrainConsensus.test.ts에서 단위 검증.
// 기존 fusion 테스트는 consensus를 항상 pass 상태로 mock해 회귀 차단 의도(position-train 채택)를 보존.
// jest.fn으로 export해 특정 케이스(예: motionForDump 'unknown' 경로)에서 override 가능.
jest.mock('../useAccelerometerFingerprint', () => ({
  useAccelerometerFingerprint: jest.fn(() => 'automotive'),
}));
jest.mock('../useCellularTech', () => ({
  useCellularTech: jest.fn(() => 'surface'),
}));
jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
// #1501 (PR-A) — rawSignalBuffer / tripCorrId은 본 hook의 측정 채널이라 mock으로 격리.
// 자체 단위 테스트가 buffer/persist/throttle을 따로 검증한다. 실제 push 호출 횟수/형태만
// jest.fn으로 확인.
jest.mock('../../../observability/utils/rawSignalBuffer', () => ({
  pushRawSignal: jest.fn(),
}));
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: jest.fn(() => null),
}));

const mockUseNearest = useNearestStation as jest.Mock;
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockUsePositions = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

function gpsBase(overrides?: Record<string, unknown>) {
  const base = {
    result: { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
    variants: [MOCK_STATIONS.gangnam],
    userLocation: { lat: 37.5, lng: 127.0 },
    speedMps: 1,
    accuracyMeters: 50,
    loading: false,
    error: null,
    permissionDenied: false,
    locationUncertain: false,
    refresh: jest.fn(),
    // #1486 (ADR-015 §2) — sticky override 없는 live GPS 결과. cascade fallback의 SSOT.
    // 기본값은 `result`와 동일 (sticky 비활성) — sticky lock 테스트에서 명시 override.
    liveResult: { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
    stickyDisplayOnly: null,
    ...overrides,
  };
  // override가 result만 지정하면 liveResult도 동기화 — sticky 시나리오는 직접 분리 지정.
  if (overrides && 'result' in overrides && !('liveResult' in overrides)) {
    base.liveResult = overrides.result as typeof base.liveResult;
  }
  return base;
}

function info(arrivalCode: number, overrides?: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: 'X',
    arrivalMinutes: 0,
    arrivalSeconds: 0,
    statusMessage: '',
    trainCode: 'T1',
    line: '2',
    receivedAtMs: 1_700_000_000_000,
    arrivalCode,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

/**
 * R13-a (#1612) — strict bad-accuracy 가드 도입 후 4곳에서 반복되는 mock GPS setup.
 * `accuracyMeters: 1500` (이전 지하 면제) 폐기 → 실 station 좌표 + accuracy=50 으로 distance gate 자연 통과.
 * SonarCloud dup 회피 (lesson_sonarcloud_dup_prevention).
 */
function mockGpsAtRealStation(stn: { lat: number; lng: number }, extra?: Parameters<typeof gpsBase>[0]): void {
  mockUseNearest.mockReturnValue(
    gpsBase({
      userLocation: { lat: stn.lat, lng: stn.lng },
      accuracyMeters: 50,
      ...extra,
    }),
  );
}

/**
 * R13-a (#1612) — bad-accuracy 게이트 면제용 mock BoardingLock.
 * fusionDistanceGate가 lockActive=true 시 accuracy null/bad 면제 (#1016 hole b 기존 동작 보존).
 * 본 fixture가 사용된 테스트는 "positionTrain/fused가 지하 가정에서 채택되는가"가 의도 — lock 없이는
 * R13-a strict reject로 채택 자체가 안 되므로 lock 추가로 가드 분리 + 의도 그대로 유지.
 *
 * boardingLine='3' / chungmuro.id 사용: setupPositionTrainTransferStation이 chungmuro(line=3)를
 * positionTrain으로 lock하는 시나리오라 #662 line 가드(useFusedNearestStation:611) 통과 보장.
 * arcStations 미설정(routeContext 미전달)이면 #1016 hole (c) 가드도 자연 통과.
 */
const mockLockForUnderground: import('../../../../shared/types/boardingLock').BoardingLock = {
  destinationId: 'mock-dest',
  trainCode: 'mock-train',
  boardingStationId: MOCK_STATIONS.chungmuro.id,
  boardingLine: '3',
  boardedAt: 1_700_000_000_000,
  expectedDurationMs: 600_000,
};

/**
 * position-train 채택 환승역 시나리오 — gangnam(2호선) GPS 1순위 + chungmuro(3호선) 2순위에
 * trainNo가 ARRIVED 상태. trackTrainProgress가 chungmuro(line=3)로 잠금.
 * #584 boarding-lock 라벨 / #662 fusion 강등 가드 두 describe 모두 같은 setup 사용.
 *
 * R13-a (#1612) — strict bad-accuracy 가드 도입으로 이전 `accuracyMeters: 1500` (지하 면제)
 * setup 폐기. 실 chungmuro 좌표를 GPS로 사용 + accuracy=50 (양호) — trackTrainProgress가
 * findStationByNameAndLine으로 조회한 실 chungmuro 좌표와 distance≈0 → distance gate 통과.
 * accuracy 양호이므로 R13-a strict reject 영향 0. positionTrain 채택 path 정상 검증.
 */
function setupPositionTrainTransferStation(trainNo: string): void {
  const realChungmuro = findStationByNameAndLine('충무로', '3')!;
  mockGpsAtRealStation(realChungmuro);
  mockFindTop.mockReturnValue([
    { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
    { station: MOCK_STATIONS.chungmuro, distanceKm: 0.3 },
  ]);
  mockUseArrival.mockReturnValue(arrivalRet(null));
  mockUsePositions
    .mockReturnValueOnce(positionRet({ line: '2', trains: [] }))
    .mockReturnValueOnce(
      positionRet({
        line: '3',
        trains: [train(MOCK_STATIONS.chungmuro.name, TRAIN_STATUS.ARRIVED, { trainNo })],
      }),
    )
    .mockReturnValueOnce(positionRet(null));
}

// #1436 routeContext allowedLines filter 테스트용 station helper (S7721 — outer scope).
function originStation(): Station {
  return MOCK_STATIONS.gangnam;
}
function destinationStation(): Station {
  return MOCK_STATIONS.chungmuro;
}

describe('useFusedNearestStation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseArrival.mockReturnValue(arrivalRet(null));
    mockUsePositions.mockReturnValue(positionRet(null));
  });

  it('userLocation null이면 후보 없음 → GPS 결과 그대로 + gps-only', () => {
    mockUseNearest.mockReturnValue(gpsBase({ userLocation: null, result: null }));
    mockFindTop.mockReturnValue([]);

    const { result } = renderHook(() => useFusedNearestStation());

    expect(result.current.result).toBeNull();
    expect(result.current.confidence).toBe('gps-only');
  });

  it('arrival 신호 없으면 GPS 최근접 + gps-only', () => {
    mockUseNearest.mockReturnValue(gpsBase());
    mockFindTop.mockReturnValue([
      { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
      { station: MOCK_STATIONS.chungmuro, distanceKm: 0.3 },
    ]);

    const { result } = renderHook(() => useFusedNearestStation());

    expect(result.current.result?.station.id).toBe(MOCK_STATIONS.gangnam.id);
    expect(result.current.confidence).toBe('gps-only');
  });

  it('인접 후보 arvlCd=1이면 그 역으로 fusion 전환', () => {
    mockUseNearest.mockReturnValue(gpsBase());
    mockFindTop.mockReturnValue([
      { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
      { station: MOCK_STATIONS.chungmuro, distanceKm: 0.3 },
      { station: MOCK_STATIONS.yeouinaru, distanceKm: 0.5 },
    ]);

    // 후보 0,1,2 순서대로 useArrivalInfo 호출됨. 같은 station(청무로)이 연속 2 cycle ARRIVED를
    // 관측해야 #2204 temporal consensus가 'arrival-confirmed'로 확정한다 — 4개 mockReturnValueOnce는
    // 렌더 1회차 + rerender 2회차 각각의 a0/a1/a2 호출을 순서대로 채운다.
    mockUseArrival
      .mockReturnValueOnce(arrivalRet({ up: [info(ARRIVAL_CODE.RUNNING)], down: [] }))
      .mockReturnValueOnce(arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }))
      .mockReturnValueOnce(arrivalRet(null))
      .mockReturnValueOnce(arrivalRet({ up: [info(ARRIVAL_CODE.RUNNING)], down: [] }))
      .mockReturnValueOnce(arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }))
      .mockReturnValueOnce(arrivalRet(null));

    const { result, rerender } = renderHook(() => useFusedNearestStation());
    expect(result.current.confidence).toBe('arrival-arriving');
    act(() => {
      rerender({});
    });

    expect(result.current.result?.station.id).toBe(MOCK_STATIONS.chungmuro.id);
    expect(result.current.confidence).toBe('arrival-confirmed');
  });

  it('GPS 원본은 gpsResult로 노출된다 (디버깅용)', () => {
    mockUseNearest.mockReturnValue(gpsBase());
    mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);
    mockUseArrival.mockReturnValue(arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }));

    const { result } = renderHook(() => useFusedNearestStation());

    expect(result.current.gpsResult?.station.id).toBe(MOCK_STATIONS.gangnam.id);
  });

  it('position-train: 단일 후보 trainNo → trackTrainProgress 채택 (source=position-train)', () => {
    // R13-a (#1612): 이전 `accuracyMeters: 1500` 지하 면제 setup 폐기. 실 chungmuro 좌표 + accuracy=50으로
    // distance gate 자연 통과 (trackTrainProgress가 사용하는 findStationByNameAndLine 좌표와 일치).
    const realChungmuro = findStationByNameAndLine('충무로', '3')!;
    mockGpsAtRealStation(realChungmuro);
    mockFindTop.mockReturnValue([
      { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }, // line='2'
      { station: MOCK_STATIONS.chungmuro, distanceKm: 0.3 }, // line='3'
    ]);

    mockUseArrival.mockReturnValue(arrivalRet(null));

    mockUsePositions
      .mockReturnValueOnce(positionRet({ line: '2', trains: [] }))
      .mockReturnValueOnce(
        positionRet({
          line: '3',
          trains: [
            train(MOCK_STATIONS.chungmuro.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-CHU' }),
          ],
        }),
      )
      .mockReturnValueOnce(positionRet(null));

    const { result } = renderHook(() => useFusedNearestStation());
    expect(result.current.result?.station.name).toBe(MOCK_STATIONS.chungmuro.name);
    expect(result.current.result?.station.line).toBe('3');
    expect(result.current.confidence).toBe('position-train');
    expect(result.current.source).toBe('position-train');
  });

  describe('#584 PR D2: boarding-lock 라벨', () => {
    const setupPositionTrain = setupPositionTrainTransferStation;

    it('lockedTrainCode가 position-train의 trainNo와 일치 + boardingLock 활성 → boarding-lock으로 승격', () => {
      // R13-a (#1612): setupPositionTrainTransferStation는 실 chungmuro GPS + accuracy=50으로
      // 변경됐다 — strict 면제 가능.
      // #1891 (RC-1 paradigm 1) — boardingLock 인자 전달이 'boarding-lock' 승격의 필수 게이트.
      // 사용자 명시 의향 trip(lock 활성)에서만 lockMatch 승격. lock 미전달 시 차단(아래 별도 케이스).
      setupPositionTrain('T-LOCKED');
      const lockWithTrainCode: import('../../../../shared/types/boardingLock').BoardingLock = {
        ...mockLockForUnderground,
        trainCode: 'T-LOCKED',
      };
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, 'T-LOCKED', lockWithTrainCode),
      );
      expect(result.current.confidence).toBe('boarding-lock');
      expect(result.current.source).toBe('boarding-lock');
    });

    it('#1891 (RC-1): boardingLock=null + lockedTrainCode 매칭이어도 position-train 유지 (autoLock self-fire 차단)', () => {
      // paradigm 1 (자동락 제거 유지) 보강 — lock 비활성 시 lockedTrainCode가 stale로 남아도
      // 'boarding-lock' source 자기 발화 차단. parent #1745 acceptance: `autoLock_fired_count = 0`.
      // station-passed / transfer 알림의 src='boarding-lock' self-attach chain 단절.
      setupPositionTrain('T-LOCKED');
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, 'T-LOCKED', null),
      );
      expect(result.current.confidence).toBe('position-train');
      expect(result.current.source).toBe('position-train');
    });

    it('lockedTrainCode가 다르면 position-train 유지', () => {
      setupPositionTrain('T-ACTUAL');
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, 'T-OTHER'),
      );
      expect(result.current.confidence).toBe('position-train');
      expect(result.current.source).toBe('position-train');
    });

    it('lockedTrainCode=null이면 position-train 유지', () => {
      setupPositionTrain('T-ANY');
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null),
      );
      expect(result.current.confidence).toBe('position-train');
      expect(result.current.source).toBe('position-train');
    });

    it('#605: positionTrain candidate.extra에 trainNo + lockedTrainCode + lockMatch 기록', () => {
      const {
        clearFusionDebugEntries,
        getFusionDebugEntries,
      } = jest.requireActual('../../utils/fusionDebugBuffer') as typeof import('../../utils/fusionDebugBuffer');
      clearFusionDebugEntries();
      setupPositionTrain('T-LOCKED');
      renderHook(() => useFusedNearestStation(undefined, undefined, undefined, 'T-LOCKED'));
      const entries = getFusionDebugEntries();
      const last = entries[entries.length - 1];
      expect(last.kind).toBe('fusion');
      if (last.kind !== 'fusion') throw new Error('expected fusion entry');
      const pt = last.candidates.find((c) => c.key === 'positionTrain');
      expect(pt?.extra).toEqual({
        trainNo: 'T-LOCKED',
        lockedTrainCode: 'T-LOCKED',
        lockMatch: true,
      });
    });

    it('#605: lockedTrainCode 불일치 시 lockMatch=false 기록', () => {
      const {
        clearFusionDebugEntries,
        getFusionDebugEntries,
      } = jest.requireActual('../../utils/fusionDebugBuffer') as typeof import('../../utils/fusionDebugBuffer');
      clearFusionDebugEntries();
      setupPositionTrain('T-ACTUAL');
      renderHook(() => useFusedNearestStation(undefined, undefined, undefined, 'T-OTHER'));
      const entries = getFusionDebugEntries();
      const last = entries[entries.length - 1];
      if (last.kind !== 'fusion') throw new Error('expected fusion entry');
      const pt = last.candidates.find((c) => c.key === 'positionTrain');
      expect(pt?.extra).toEqual({
        trainNo: 'T-ACTUAL',
        lockedTrainCode: 'T-OTHER',
        lockMatch: false,
      });
    });

    it('#605: lockedTrainCode=null이면 extra.lockedTrainCode=null + lockMatch=false', () => {
      const {
        clearFusionDebugEntries,
        getFusionDebugEntries,
      } = jest.requireActual('../../utils/fusionDebugBuffer') as typeof import('../../utils/fusionDebugBuffer');
      clearFusionDebugEntries();
      setupPositionTrain('T-ANY');
      renderHook(() => useFusedNearestStation(undefined, undefined, undefined, null));
      const entries = getFusionDebugEntries();
      const last = entries[entries.length - 1];
      if (last.kind !== 'fusion') throw new Error('expected fusion entry');
      const pt = last.candidates.find((c) => c.key === 'positionTrain');
      expect(pt?.extra).toEqual({
        trainNo: 'T-ANY',
        lockedTrainCode: null,
        lockMatch: false,
      });
    });

    it('lockedTrainCode 있어도 position-train 신호 없으면 승격 안 됨 (arrival/gps 분기 유지)', () => {
      // arrival만 있는 케이스 — boarding-lock은 position-train 채택 전제
      mockUseNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);
      // #2204 — mockImplementation으로 매 호출 새 객체 반환. temporal consensus가 연속 2 cycle
      // 같은 station의 ARRIVED를 요구하므로 rerender로 두 번째 cycle을 재현한다.
      mockUseArrival.mockImplementation(() =>
        arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }),
      );
      mockUsePositions.mockReturnValue(positionRet(null));

      const { result, rerender } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, 'T-LOCKED'),
      );
      act(() => {
        rerender({});
      });
      expect(result.current.confidence).toBe('arrival-confirmed');
      expect(result.current.source).toBe('arrival');
    });
  });

  describe('#662 환승역 fusion 강등 가드 (BoardingLock 기준)', () => {
    // #1016 fix (b): lock 활성 시 accuracy>MAX_ACCURACY_M bypass 제거로 GPS를 실좌표 근처에 놓아야 함.
    // 실 충무로(3호선) 좌표를 GPS로 사용 — distance≈0 → gate 통과.
    const realChungmuro3 = findStationByNameAndLine('충무로', '3')!;

    function setupPositionTrainWithRealCoords(trainNo: string): void {
      // GPS를 실 충무로(3호선) 좌표에 배치 — lock 활성 + accuracyMeters=50이어도 gate 통과.
      mockGpsAtRealStation(realChungmuro3);
      mockFindTop.mockReturnValue([
        { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
        { station: MOCK_STATIONS.chungmuro, distanceKm: 0.3 },
      ]);
      mockUseArrival.mockReturnValue(arrivalRet(null));
      mockUsePositions
        .mockReturnValueOnce(positionRet({ line: '2', trains: [] }))
        .mockReturnValueOnce(
          positionRet({
            line: '3',
            trains: [train(MOCK_STATIONS.chungmuro.name, TRAIN_STATUS.ARRIVED, { trainNo })],
          }),
        )
        .mockReturnValueOnce(positionRet(null));
    }

    const lockOnLine = (line: '2' | '3'): import('../../../../shared/types/boardingLock').BoardingLock => ({
      destinationId: 'dest-1',
      trainCode: 'T-3',
      boardingStationId: MOCK_STATIONS.gangnam.id,
      boardingLine: line,
      boardedAt: Date.now(),
      expectedDurationMs: 600_000,
    });

    it('lock.boardingLine과 positionTrain.line이 다르면 positionTrain 강등 → GPS로 fallthrough', () => {
      setupPositionTrainWithRealCoords('T-3');
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null, lockOnLine('2')),
      );
      expect(result.current.source).toBe('gps');
    });

    it('lock.boardingLine과 positionTrain.line이 같으면 positionTrain 유지', () => {
      // #1016 fix (b): lock 활성이므로 accuracy bypass 없음. GPS를 실 충무로 좌표에 배치.
      setupPositionTrainWithRealCoords('T-3');
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null, lockOnLine('3')),
      );
      expect(result.current.source).toBe('position-train');
      expect(result.current.result?.station.name).toBe(MOCK_STATIONS.chungmuro.name);
    });

    it('boardingLock 없으면 가드 미작동 (기존 동작 유지)', () => {
      // R13-a (#1612): setupPositionTrainTransferStation은 실 chungmuro 좌표 + accuracy=50으로 변경됐다 —
      // R13-a strict 영향 받지 않으므로 lock 없어도 positionTrain 채택. #662 line 가드 자체는 lock 없을 때 미작동.
      setupPositionTrainTransferStation('T-3');
      const { result } = renderHook(() => useFusedNearestStation());
      expect(result.current.source).toBe('position-train');
    });

    it('fused 경로도 lock.boardingLine과 다른 노선이면 강등 → GPS로 fallthrough', () => {
      // positionTrain 신호 없는 환승역 시나리오: arrival의 ARRIVED 신호로 fused가 chungmuro(line=3)
      // 채택되는 상황에서 lock=line2면 fused 강등 → gangnam(line=2, GPS) 채택.
      mockUseNearest.mockReturnValue(gpsBase({ accuracyMeters: 1500 }));
      mockFindTop.mockReturnValue([
        { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
        { station: MOCK_STATIONS.chungmuro, distanceKm: 0.3 },
      ]);
      mockUseArrival
        .mockReturnValueOnce(arrivalRet(null))
        .mockReturnValueOnce(arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }))
        .mockReturnValueOnce(arrivalRet(null));
      mockUsePositions.mockReturnValue(positionRet(null));

      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null, lockOnLine('2')),
      );
      expect(result.current.source).toBe('gps');
      expect(result.current.result?.station.name).toBe(MOCK_STATIONS.gangnam.name);
    });
  });

  describe('#727 정적 misfire 가드 (fusion downgrade)', () => {
    // 가드 *작동* 케이스(speed=0 + accuracy 정상에서 fusion 채택)는 trackTrainProgress가
    // stations.json 실좌표를 봐 통합 mock 셋업이 까다롭다 — shouldDowngradeFusion helper
    // 단위 테스트(movementGate.test.ts)가 그 분기를 cover.
    // 본 describe는 *가드 통과* 케이스(transferRegression 셋업 변형)만 검증.
    // 강등이 *작동하지 않는* 케이스만 본 describe에서 검증.
    // 강등 *작동* 케이스는 useFusedNearestStation.movementGuard.test.ts가 fusionDistanceGate
    // mock으로 직접 검증 — 본 통합 mock으로는 stations.json 실좌표 충돌이 있어 셋업 불가.
    function setupPositionTrainScenario(
      accuracyMeters: number,
      speedMps: number,
      trainNo: string,
    ): void {
      mockUseNearest.mockReturnValue(gpsBase({ accuracyMeters, speedMps }));
      mockFindTop.mockReturnValue([
        { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
        { station: MOCK_STATIONS.chungmuro, distanceKm: 0.3 },
      ]);
      mockUseArrival.mockReturnValue(arrivalRet(null));
      mockUsePositions
        .mockReturnValueOnce(positionRet({ line: '2', trains: [] }))
        .mockReturnValueOnce(
          positionRet({
            line: '3',
            trains: [
              train(MOCK_STATIONS.chungmuro.name, TRAIN_STATUS.ARRIVED, { trainNo }),
            ],
          }),
        )
        .mockReturnValueOnce(positionRet(null));
    }

    it.each([
      ['accuracy>100m 지하 noise + speed=0', 1500, 0, 'T-SUB'],
      ['accuracy>100m 지하 + speed=1 이동 중', 1500, 1, 'T-FAST'],
    ])(
      'R13-a (#1612): position-train + %s + lock 비활성 → strict reject (지하 dead zone 누수 차단)',
      (_label, accuracy: number, speed: number, no: string) => {
        // 이전 의도: #727 movementGate가 강등 안 함. R13-a로 fusionDistanceGate가 먼저 reject.
        // 사용자 명시 의향 없는 lockless trip의 지하 dead zone 누수 방어 — 강등 자체가 정상 동작.
        setupPositionTrainScenario(accuracy, speed, no);

        const { result } = renderHook(() => useFusedNearestStation());

        expect(result.current.source).not.toBe('position-train');
      },
    );

    it('gps-only(승격된 fusion 없음) + speed=0이어도 라벨 그대로 (강등 대상 아님)', () => {
      mockUseNearest.mockReturnValue(gpsBase({ speedMps: 0 }));
      mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);
      mockUseArrival.mockReturnValue(arrivalRet(null));
      mockUsePositions.mockReturnValue(positionRet(null));

      const { result } = renderHook(() => useFusedNearestStation());

      expect(result.current.confidence).toBe('gps-only');
      expect(result.current.source).toBe('gps');
    });
  });

  it('arrival 있고 position-train 후보 없으면 fused arrival 채택', () => {
    mockUseNearest.mockReturnValue(gpsBase());
    mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);

    // #2204 — mockImplementation으로 매 호출 새 객체 반환. temporal consensus가 연속 2 cycle
    // 같은 station의 ARRIVED를 요구하므로 rerender로 두 번째 cycle을 재현한다.
    mockUseArrival.mockImplementation(() =>
      arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }),
    );
    mockUsePositions.mockReturnValue(positionRet(null));

    const { result, rerender } = renderHook(() => useFusedNearestStation());
    act(() => {
      rerender({});
    });
    expect(result.current.confidence).toBe('arrival-confirmed');
    expect(result.current.source).toBe('arrival');
  });

  it('position-train 다중 후보: lastConfirmedTrainNo 우선(sticky) — GPS 있을 때 이전 결과 유지', () => {
    // R13-a (#1612): 이전 `accuracyMeters: 1500` 지하 면제 setup 폐기. 실 gangnam 좌표 + accuracy=50으로
    // distance gate 자연 통과 (line=2 기존 의도 보존, lock 추가 불필요).
    const realGangnam = findStationByNameAndLine('강남', '2')!;
    mockGpsAtRealStation(realGangnam);
    mockFindTop.mockReturnValue([
      { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
    ]);
    mockUseArrival.mockReturnValue(arrivalRet(null));

    // 첫 렌더: 단일 트레인 T-1 → sticky 시드
    mockUsePositions.mockReturnValue(
      positionRet({
        line: '2',
        trains: [train(MOCK_STATIONS.gangnam.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-1' })],
      }),
    );
    const { result, rerender } = renderHook(() => useFusedNearestStation());
    expect(result.current.confidence).toBe('position-train');

    // 두 번째 렌더: 두 트레인 (T-1, T-2). GPS 유지(accuracy=50). sticky로 T-1 유지.
    // #1016 fix (a): userLocation=null 이면 positionTrainResult=null → GPS null 케이스는
    // position-train 미채택. GPS 있는 케이스에서만 sticky가 동작하는지 검증.
    mockUsePositions.mockReturnValue(
      positionRet({
        line: '2',
        trains: [
          train(MOCK_STATIONS.gangnam.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-1' }),
          train(MOCK_STATIONS.chungmuro.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-2' }),
        ],
      }),
    );
    // GPS 유지 (userLocation 있음) — sticky가 동작해야 함
    rerender(undefined);
    expect(result.current.source).toBe('position-train');
    expect(result.current.result?.station.name).toBe(MOCK_STATIONS.gangnam.name);
  });

  it('position-train: userLocation null → positionTrainResult null — #1016 fix (a)', () => {
    // #1016 hole (a): userLocation==null 이면 distanceKm=0 placeholder가 게이트를 자동 통과했었음.
    // fix 이후 userLocation 없으면 positionTrainResult=null → position-train 미채택.
    mockUseNearest.mockReturnValue(gpsBase({ accuracyMeters: 1500, userLocation: null }));
    mockFindTop.mockReturnValue([]);
    mockUseArrival.mockReturnValue(arrivalRet(null));
    mockUsePositions.mockReturnValue(
      positionRet({
        line: '2',
        trains: [train(MOCK_STATIONS.gangnam.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-U' })],
      }),
    );

    const { result } = renderHook(() => useFusedNearestStation());

    expect(result.current.source).not.toBe('position-train');
  });

  it('GPS pass-through 필드들(loading/error/permissionDenied/locationUncertain/refresh 등)이 보존된다', () => {
    const refresh = jest.fn();
    mockUseNearest.mockReturnValue(
      gpsBase({
        loading: true,
        error: 'GPS err',
        permissionDenied: true,
        locationUncertain: true,
        refresh,
      }),
    );
    mockFindTop.mockReturnValue([]);

    const { result } = renderHook(() => useFusedNearestStation());

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe('GPS err');
    expect(result.current.permissionDenied).toBe(true);
    expect(result.current.locationUncertain).toBe(true);
    expect(result.current.refresh).toBe(refresh);
    expect(result.current.variants).toEqual([MOCK_STATIONS.gangnam]);
    expect(result.current.userLocation).toEqual({ lat: 37.5, lng: 127.0 });
    expect(result.current.speedMps).toBe(1);
    expect(result.current.accuracyMeters).toBe(50);
  });

  describe('#445 positionTrainResult 거리/TTL sanity gate', () => {
    const yongmasan = findStationByNameAndLine('용마산', '7')!;
    const sagajeong = findStationByNameAndLine('사가정', '7')!;

    function setup용마산GpsSagajeongTrain(opts: { accuracyMeters: number | null }) {
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
          accuracyMeters: opts.accuracyMeters,
          result: { station: yongmasan, distanceKm: 0 },
        }),
      );
      // GPS-nearest = 용마산. fusion 후보는 용마산만 (단순화) — line=7.
      mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);
      mockUseArrival.mockReturnValue(arrivalRet(null));
      // line=7 positions에 사가정에 도착한 단일 열차.
      mockUsePositions
        .mockReturnValueOnce(
          positionRet({
            line: '7',
            trains: [train(sagajeong.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-사가정' })],
          }),
        )
        .mockReturnValueOnce(positionRet(null))
        .mockReturnValueOnce(positionRet(null));
    }

    it('재현된 사고: GPS=용마산(정확도 양호) + positionTrain=사가정(>0.6km) → fusion 강등', () => {
      setup용마산GpsSagajeongTrain({ accuracyMeters: 7 });
      const { result } = renderHook(() => useFusedNearestStation());
      // positionTrainResult가 null로 강등되고 fusion 우선순위가 다음으로 떨어진다.
      expect(result.current.source).not.toBe('position-train');
      // arrival/route 없으니 결국 gps 폴백 → 용마산.
      expect(result.current.result?.station.name).toBe('용마산');
    });

    it('정확도 양호 + 절대 거리 OK + GPS-nearest 다른 station: 상대 margin 초과면 강등', () => {
      // 절대 거리는 0.6km 이내(통과)지만 GPS-nearest와 비교했을 때 margin 초과로 강등하는 경로 검증.
      // trackTrainProgress가 findStationByNameAndLine(stations.json 실좌표)을 쓰므로,
      // 실좌표에서 0.3~0.6km 범위 안 동일선상 두 역이 필요. 7호선 사가정/면목 사용 가정 어렵 →
      // findStationByNameAndLine을 한 번만 가로채 합성 좌표를 돌려준다.
      const fakeStation = {
        id: 'SAGA-FAKE',
        name: '사가정',
        line: '7' as const,
        lineColor: '#747F00',
        // user(용마산)에서 약 0.4km 떨어진 합성 좌표.
        lat: yongmasan.lat + 0.0036,
        lng: yongmasan.lng,
      };
      const here = { ...yongmasan, id: 'YHERE' };
      const stationRouteModule = jest.requireActual('../../../../shared/utils/stationRoute');
      const spy = jest
        .spyOn(stationRouteModule, 'findStationByNameAndLine')
        .mockImplementation((...args) => {
          const [name, line] = args as [string, string];
          if (name === '사가정' && line === '7') return fakeStation;
          return null;
        });

      try {
        mockUseNearest.mockReturnValue(
          gpsBase({
            userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
            accuracyMeters: 10,
            result: { station: here, distanceKm: 0 },
          }),
        );
        // GPS-nearest = here(거리 0). positionTrain station = fake사가정(~0.4km).
        // 0.4 > 0 + 0.2 → 상대 margin 초과 → 강등(line 232 hit).
        mockFindTop.mockReturnValue([{ station: here, distanceKm: 0 }]);
        mockUseArrival.mockReturnValue(arrivalRet(null));
        mockUsePositions
          .mockReturnValueOnce(
            positionRet({
              line: '7',
              trains: [train('사가정', TRAIN_STATUS.ARRIVED, { trainNo: 'T-NEAR' })],
            }),
          )
          .mockReturnValueOnce(positionRet(null))
          .mockReturnValueOnce(positionRet(null));

        const { result } = renderHook(() => useFusedNearestStation());
        expect(result.current.source).not.toBe('position-train');
      } finally {
        spy.mockRestore();
      }
    });

    it('R13-a (#1612): 지하 fix(accuracy > MAX_ACCURACY_M) + lock 비활성 → strict reject (positionTrain 채택 X)', () => {
      // 이전 의도: 지하 면제로 positionTrain 채택. R13-a로 strict reject — V1 회복 직접 성과.
      setup용마산GpsSagajeongTrain({ accuracyMeters: 1500 });
      const { result } = renderHook(() => useFusedNearestStation());
      expect(result.current.source).not.toBe('position-train');
    });

    it('R13-a (#1612): accuracy null + lock 비활성 → strict reject (positionTrain 채택 X)', () => {
      // 이전 의도: accuracy null도 면제로 positionTrain 채택. R13-a로 strict reject — 동일 정신.
      setup용마산GpsSagajeongTrain({ accuracyMeters: null });
      const { result } = renderHook(() => useFusedNearestStation());
      expect(result.current.source).not.toBe('position-train');
    });

    it('정상 mid-ride(user가 정확도 양호 + 절대 거리 ≤0.6km + margin OK): positionTrain 유지', () => {
      // user는 사가정 근처(약 0.3km) — 절대 거리 통과, GPS-nearest도 사가정.
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: sagajeong.lat - 0.0027, lng: sagajeong.lng }, // ~300m 남쪽
          accuracyMeters: 10,
          result: { station: sagajeong, distanceKm: 0.3 },
        }),
      );
      mockFindTop.mockReturnValue([{ station: sagajeong, distanceKm: 0.3 }]);
      mockUseArrival.mockReturnValue(arrivalRet(null));
      mockUsePositions
        .mockReturnValueOnce(
          positionRet({
            line: '7',
            trains: [train(sagajeong.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-OK' })],
          }),
        )
        .mockReturnValueOnce(positionRet(null))
        .mockReturnValueOnce(positionRet(null));

      const { result } = renderHook(() => useFusedNearestStation());
      expect(result.current.source).toBe('position-train');
      expect(result.current.result?.station.name).toBe('사가정');
    });

    it('TTL: trainProgress가 갱신된 지 60s 초과면 fusion 강등 + sticky 락 해제', () => {
      // R13-a (#1612): 이전 `accuracyMeters: 1500` 지하 면제 setup 폐기. 실 sagajeong 좌표 + accuracy=50
      // (positionTrain이 sagajeong에 lock → distance≈0) — TTL 검증 의도만 유지.
      jest.useFakeTimers();
      try {
        // mockImplementation으로 안정 — 매 호출마다 동일한 positions 반환.
        mockUseNearest.mockReturnValue(
          gpsBase({
            userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
            accuracyMeters: 50,
            result: { station: sagajeong, distanceKm: 0 },
          }),
        );
        mockFindTop.mockReturnValue([{ station: sagajeong, distanceKm: 0 }]);
        mockUseArrival.mockReturnValue(arrivalRet(null));
        mockUsePositions.mockImplementation((line: string | null) => {
          if (line === '7') {
            return positionRet({
              line: '7',
              trains: [train(sagajeong.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-TTL' })],
            });
          }
          return positionRet(null);
        });

        const { result, rerender } = renderHook(() => useFusedNearestStation());
        expect(result.current.source).toBe('position-train');

        // 시계만 진행. userLocation을 미세 변경해 useMemo 재계산 트리거.
        jest.advanceTimersByTime(61_000);
        mockUseNearest.mockReturnValue(
          gpsBase({
            userLocation: { lat: sagajeong.lat + 0.00001, lng: sagajeong.lng },
            accuracyMeters: 50,
            result: { station: sagajeong, distanceKm: 0 },
          }),
        );
        rerender(undefined);

        // TTL 발동 → positionTrainResult=null → source는 다른 fallback.
        expect(result.current.source).not.toBe('position-train');
      } finally {
        jest.useRealTimers();
        mockUsePositions.mockReset();
      }
    });

    describe('#1450 (B2): traincode TTL 동적 갱신 (lock 활성 시 arrival 폴링 동일 trainCode 지속)', () => {
      // 두 케이스(lock 활성 / lockless) 공통 setup. mockReset은 finally에 둠.
      const setupTrainCodePolling = (params: {
        station: typeof sagajeong;
        accuracyMeters: number;
        trainNo: string;
      }) => {
        mockUseNearest.mockReturnValue(
          gpsBase({
            userLocation: { lat: params.station.lat, lng: params.station.lng },
            accuracyMeters: params.accuracyMeters,
            result: { station: params.station, distanceKm: 0 },
          }),
        );
        mockFindTop.mockReturnValue([{ station: params.station, distanceKm: 0 }]);
        mockUseArrival.mockReturnValue(arrivalRet(null));
        mockUsePositions.mockImplementation((line: string | null) =>
          line === '7'
            ? positionRet({
                line: '7',
                trains: [train(params.station.name, TRAIN_STATUS.ARRIVED, { trainNo: params.trainNo })],
              })
            : positionRet(null),
        );
      };
      const advanceWithJitter = (
        station: typeof sagajeong,
        accuracyMeters: number,
        jitterIndex: number,
      ) => {
        jest.advanceTimersByTime(30_000);
        mockUseNearest.mockReturnValue(
          gpsBase({
            userLocation: { lat: station.lat + 0.00001 * jitterIndex, lng: station.lng },
            accuracyMeters,
            result: { station, distanceKm: 0 },
          }),
        );
      };

      it('lock 활성 + 동일 trainCode 5회 폴링 지속 → TTL 만료(150s)해도 traincode 강등 없음', () => {
        jest.useFakeTimers();
        try {
          const lock: import('../../../../shared/types/boardingLock').BoardingLock = {
            destinationId: 'dest-1',
            trainCode: 'T-LOCK-ALIVE',
            boardingStationId: sagajeong.id,
            boardingLine: '7',
            boardedAt: Date.now(),
            expectedDurationMs: 600_000,
          };
          setupTrainCodePolling({ station: sagajeong, accuracyMeters: 50, trainNo: 'T-LOCK-ALIVE' });
          const { result, rerender } = renderHook(
            ({ tick }: { tick: number }) =>
              useFusedNearestStation(undefined, undefined, undefined, lock.trainCode, {
                ...lock,
                boardedAt: lock.boardedAt + tick,
              }),
            { initialProps: { tick: 0 } },
          );
          expect(result.current.source).toBe('boarding-lock');

          for (let i = 0; i < 5; i += 1) {
            advanceWithJitter(sagajeong, 50, i + 1);
            rerender({ tick: i + 1 });
          }
          expect(result.current.source).toBe('boarding-lock');
        } finally {
          jest.useRealTimers();
          mockUsePositions.mockReset();
        }
      });

      it('R13-a (#1612): lock 부재 + accuracy=1500 → strict reject로 처음부터 position-train 채택 X (기존 TTL 강등은 lock 활성 path가 검증)', () => {
        // 이전 의도: lock 없으면 TTL 60s 만료로 강등. R13-a로 strict reject가 먼저 적용 — 처음부터 채택 X.
        // 사용자 명시 의향 없는 lockless trip의 지하 dead zone 누수 방어 — V1 회복 직접 성과.
        jest.useFakeTimers();
        try {
          setupTrainCodePolling({ station: yongmasan, accuracyMeters: 1500, trainNo: 'T-NOLOCK' });
          const { result } = renderHook(() => useFusedNearestStation());
          // R13-a strict reject로 즉시 position-train 미채택 (TTL 만료 대기 불필요).
          expect(result.current.source).not.toBe('position-train');
        } finally {
          jest.useRealTimers();
          mockUsePositions.mockReset();
        }
      });
    });
  });

  describe('#444 fused/route 거리 sanity gate', () => {
    const yongmasan = findStationByNameAndLine('용마산', '7')!;

    it('재현된 사고: GPS=용마산 / fused가 사가정 0s arrival로 채택 → fused 강등 → gps로 떨어짐', () => {
      // mockFindTop으로 후보 직접 주입. trackTrainProgress 경로엔 positions가 없어
      // findStationByNameAndLine 호출이 없으므로 스파이 불필요.
      const fakeSagajeong = {
        id: 'SAGA-FAKE',
        name: '사가정',
        line: '7' as const,
        lineColor: '#747F00',
        // user(용마산)에서 약 0.6km 떨어진 좌표 — 절대 게이트 경계.
        lat: yongmasan.lat + 0.0054,
        lng: yongmasan.lng,
      };
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
          accuracyMeters: 6,
          result: { station: yongmasan, distanceKm: 0 },
        }),
      );
      mockFindTop.mockReturnValue([
        { station: yongmasan, distanceKm: 0 },
        { station: fakeSagajeong, distanceKm: 0.6 },
      ]);
      mockUseArrival
        .mockReturnValueOnce(arrivalRet(null))
        .mockReturnValueOnce(arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }))
        .mockReturnValueOnce(arrivalRet(null));
      mockUsePositions.mockReturnValue(positionRet(null));

      const { result } = renderHook(() => useFusedNearestStation());
      // fused는 사가정을 채택하지만, #444 게이트가 강등 → gps로 폴백 → 용마산.
      expect(result.current.source).toBe('gps');
      expect(result.current.result?.station.id).toBe(yongmasan.id);
    });

    it('fused가 통과 가능한 거리(GPS-nearest와 동일 station)면 그대로 채택', () => {
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
          accuracyMeters: 10,
          result: { station: yongmasan, distanceKm: 0 },
        }),
      );
      mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);
      mockUseArrival
        .mockReturnValueOnce(arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }))
        .mockReturnValueOnce(arrivalRet(null))
        .mockReturnValueOnce(arrivalRet(null));
      mockUsePositions.mockReturnValue(positionRet(null));

      const { result } = renderHook(() => useFusedNearestStation());
      expect(result.current.source).toBe('arrival');
      expect(result.current.result?.station.id).toBe(yongmasan.id);
    });
  });

  describe('routeContext (Phase A — Route-Locked Map Matching)', () => {
    const sagajeong = findStationByNameAndLine('사가정', '7')!;
    const childrenPark = findStationByNameAndLine('어린이대공원', '7')!;
    const route = makeDirectRoute(4, '7');

    it('경로 컨텍스트 + userLocation 있으면 진행도 기반 현재역으로 result 덮어쓴다', () => {
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          result: { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
        }),
      );
      mockFindTop.mockReturnValue([]);

      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, {
          route,
          origin: sagajeong,
          destination: childrenPark,
        }),
      );

      expect(result.current.result?.station.id).toBe(sagajeong.id);
      expect(result.current.gpsResult?.station.id).toBe(MOCK_STATIONS.gangnam.id);
      expect(result.current.confidence).toBe('route-progress');
      expect(result.current.source).toBe('route-progress');
    });

    it('경로 컨텍스트 있어도 userLocation null이면 진행도 미초기화 → GPS fusion fallback', () => {
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: null,
          result: { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
        }),
      );
      mockFindTop.mockReturnValue([]);

      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, {
          route,
          origin: sagajeong,
          destination: childrenPark,
        }),
      );

      expect(result.current.result?.station.id).toBe(MOCK_STATIONS.gangnam.id);
    });

    it('경로 컨텍스트 origin/destination 누락이면 GPS fusion fallback', () => {
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: sagajeong.lat, lng: sagajeong.lng },
          result: { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
        }),
      );
      mockFindTop.mockReturnValue([]);

      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, {
          route,
          origin: null,
          destination: null,
        }),
      );

      expect(result.current.result?.station.id).toBe(MOCK_STATIONS.gangnam.id);
    });
  });

  describe('#621 BoardingLock 시간 interpolation (지하 GPS stale ratchet forward)', () => {
    const yongmasan = findStationByNameAndLine('용마산', '7')!;
    const junggok = findStationByNameAndLine('중곡', '7')!;
    const gunja = findStationByNameAndLine('군자', '7')!;
    const oolinidae = findStationByNameAndLine('어린이대공원', '7')!;
    const konkuk = findStationByNameAndLine('건대입구', '7')!;
    const route = makeDirectRoute(4, '7');
    const routeContext = { route, origin: yongmasan, destination: konkuk };
    const T0 = 1_700_000_000_000;
    const lock = {
      destinationId: konkuk.id,
      trainCode: '7093',
      boardingStationId: yongmasan.id,
      boardingLine: '7' as const,
      boardedAt: T0,
      expectedDurationMs: 30 * 60_000,
    };

    function setupGpsAt(station: typeof yongmasan) {
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: station.lat, lng: station.lng },
          result: { station, distanceKm: 0 },
        }),
      );
      mockFindTop.mockReturnValue([{ station, distanceKm: 0 }]);
      mockUseArrival.mockReturnValue(arrivalRet(null));
      mockUsePositions.mockReturnValue(positionRet(null));
    }

    it('#1437 (ADR-015 §2) GPS stale(용마산) + 1 hop 경과 → fire path는 GPS(용마산) 유지, estimator(중곡)는 displayOnly 채널에만', () => {
      // 시간 적분 strategy(default-hop / lockless-route-hop / reanchored-hop)의 fire 권한 박탈.
      // estimator override가 result/source를 덮어쓰지 않는다 — GPS가 fire path SSOT.
      // UI 추적용 displayOnlyEstimate는 estimator 결과를 그대로 노출 (DebugModal에서 strategy 라벨 추적).
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 90_000);
        setupGpsAt(yongmasan);
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.source).not.toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(yongmasan.id);
        // displayOnly 채널은 estimator 결과 노출
        expect(result.current.displayOnlyEstimate?.station.id).toBe(junggok.id);
        expect(result.current.displayOnlyEstimate?.strategy).toBe('default-hop');
        // fire path SSOT인 currentHopIndex는 시간 적분 strategy에서 박탈 (null)
        expect(result.current.currentHopIndex).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('#1437 dead-zone 3 hop 경과해도 fire path는 GPS(용마산) 유지', () => {
      // 정책 박탈 후: estimator가 어디까지 적분하더라도 fire path는 GPS SSOT.
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 3 * 90_000);
        setupGpsAt(yongmasan);
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.result?.station.id).toBe(yongmasan.id);
        expect(result.current.result?.station.id).not.toBe(oolinidae.id);
        expect(result.current.result?.station.id).not.toBe(konkuk.id);
      } finally {
        jest.useRealTimers();
      }
    });

    it('GPS가 interp보다 앞(건대입구) → GPS 유지(역행 방지)', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 90_000);
        setupGpsAt(konkuk);
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.source).not.toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(konkuk.id);
      } finally {
        jest.useRealTimers();
      }
    });

    it('GPS=중곡(idx 1) + interp=중곡(idx 1) → tied. 채택 결과 유지(우회 안 함)', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 90_000);
        setupGpsAt(junggok);
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        // tied → GPS 그대로 (boarding-lock 승격 X)
        expect(result.current.source).not.toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(junggok.id);
      } finally {
        jest.useRealTimers();
      }
    });

    it('lock 없으면 기존 fusion 그대로', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 3 * 90_000);
        setupGpsAt(yongmasan);
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, null, null),
        );
        expect(result.current.source).not.toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(yongmasan.id);
      } finally {
        jest.useRealTimers();
      }
    });

    it('routeContext 없으면 interp 비활성', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 3 * 90_000);
        setupGpsAt(yongmasan);
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, undefined, '7093', lock),
        );
        expect(result.current.source).not.toBe('boarding-lock-interp');
      } finally {
        jest.useRealTimers();
      }
    });

    it('#1437 GPS가 arc 밖(서울역 공항철도) + lock 활성 → estimator override 안 함, GPS 유지', () => {
      // 정책 박탈 후: estimator가 hop을 산출해도 fire path는 GPS SSOT.
      // arc 밖 GPS는 그대로 노출 — 호출자(useStationAlarm)가 hop window 게이트로 차단.
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 2 * 90_000);
        // 7호선 arc와 무관한 역
        setupGpsAt({ ...MOCK_STATIONS.seoulStation, line: 'airport' });
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.source).not.toBe('boarding-lock-interp');
        // estimator override 박탈 — result.station이 estimator의 junggok이 아님.
        expect(result.current.result?.station.id).not.toBe(junggok.id);
        // estimator는 displayOnly에만
        expect(result.current.displayOnlyEstimate?.station.id).toBe(junggok.id);
      } finally {
        jest.useRealTimers();
      }
    });

    function setupGpsAtWithLoosAccuracy(station: typeof yongmasan) {
      // setupGpsAt의 accuracyMeters=50은 fusionDistanceGate 엄격 — position-train이 강등될 수 있어
      // trainProgress 신호 검증에 부적합. 지하 모드(accuracyMeters=1500)로 gate 면제.
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: station.lat, lng: station.lng },
          result: { station, distanceKm: 0 },
          accuracyMeters: 1500,
        }),
      );
      mockFindTop.mockReturnValue([{ station, distanceKm: 0 }]);
      mockUseArrival.mockReturnValue(arrivalRet(null));
    }

    it('LivePosition(trainNo===trainCode) + arc 위 → effect가 lastObservedRef 갱신 (#739 Stage 1)', () => {
      jest.useFakeTimers();
      try {
        // #1016 fix (b): lock 활성 + accuracy bypass 제거로 GPS를 실 군자 좌표에 배치해야 gate 통과.
        // GPS는 군자(arc idx 2). 7093이 군자에서 도착 — trainProgress → 군자, positionTrainResult 채택.
        jest.setSystemTime(T0 + 2 * 90_000);
        setupGpsAt(gunja);
        const t7093 = train('군자(능동)', TRAIN_STATUS.ARRIVED, { trainNo: '7093' });
        mockUsePositions.mockReturnValue(positionRet({ line: '7', trains: [t7093] }));

        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        // positionTrainResult 채택 → confidence='boarding-lock' (#584 D2). 같은 군자라 estimator가
        // override 못 함(tied), 그러나 effect는 정상 경로(idx=2)로 lastObservedRef 갱신.
        expect(result.current.result?.station.id).toBe(gunja.id);
        expect(result.current.confidence).toBe('boarding-lock');
      } finally {
        jest.useRealTimers();
      }
    });

    it('LivePosition trainNo 매칭 BUT arc 밖 역에 있음 → effect line 364 가드 (#739 idx=-1)', () => {
      jest.useFakeTimers();
      try {
        // 7093이 arc 밖의 7호선 역(면목=용마산 인접 외측)에 있음 — pickCandidateTrains window 이내라 후보 진입,
        // trackTrainProgress가 currentStation=면목으로 trainProgress 생성. effect는 idx=-1 가드로 early return.
        jest.setSystemTime(T0 + 3 * 90_000);
        setupGpsAtWithLoosAccuracy(yongmasan);
        const myeonmok = findStationByNameAndLine('면목', '7')!;
        const tOff = train(myeonmok.name, TRAIN_STATUS.ARRIVED, { trainNo: '7093' });
        mockUsePositions.mockReturnValue(positionRet({ line: '7', trains: [tOff] }));

        renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        // line 364 effect 가드(arcIndexOfStation === -1) 실행만으로 커버리지 충족 — 후처리는 호출자
        // (positionTrainResult가 #444 distance gate에서 강등될 수도) 분기에 따라 다르므로 단언 생략.
        // hook이 throw 없이 렌더되면 가드 path가 정상.
      } finally {
        jest.useRealTimers();
      }
    });

    it('routeContext.origin null → arcStations 비어 interp 비활성', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 3 * 90_000);
        setupGpsAt(yongmasan);
        const { result } = renderHook(() =>
          useFusedNearestStation(
            undefined,
            undefined,
            { route, origin: null, destination: konkuk },
            '7093',
            lock,
          ),
        );
        expect(result.current.source).not.toBe('boarding-lock-interp');
      } finally {
        jest.useRealTimers();
      }
    });

    it('computeRouteArc null (origin/destination이 route.line에 없음) → interp 비활성', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 3 * 90_000);
        setupGpsAt(yongmasan);
        // route.line=7이지만 origin은 2호선 강남. stationsBetween이 null 반환 → arc null.
        const { result } = renderHook(() =>
          useFusedNearestStation(
            undefined,
            undefined,
            { route, origin: MOCK_STATIONS.gangnam, destination: konkuk },
            '7093',
            lock,
          ),
        );
        expect(result.current.source).not.toBe('boarding-lock-interp');
      } finally {
        jest.useRealTimers();
      }
    });

    it('#1437 시간만 흐르면(부모 리렌더 없이) displayOnlyEstimate가 다음 hop 반영 — useMemo 캐시 회귀 가드', () => {
      // 정책 박탈 후: estimator는 시간 경과로 추정 hop을 진전시키지만 fire path는 GPS 유지.
      // displayOnlyEstimate가 새 hop을 반영하는지 (useMemo 캐시 회귀)만 검증.
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0);
        setupGpsAt(yongmasan);
        const { result, rerender } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.result?.station.id).toBe(yongmasan.id);
        expect(result.current.displayOnlyEstimate?.station.id).toBe(yongmasan.id);

        jest.setSystemTime(T0 + 90_000);
        rerender(undefined);
        // fire path: GPS(용마산) 유지
        expect(result.current.source).not.toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(yongmasan.id);
        // displayOnly: estimator 진전(중곡)
        expect(result.current.displayOnlyEstimate?.station.id).toBe(junggok.id);
      } finally {
        jest.useRealTimers();
      }
    });

    it('#1437 회귀 가드 — 2026-06-18 13:25:26 시나리오 (gps=성수 + lock=뚝섬 시점 시간 적분) → fire path X', () => {
      // trip dump L335 13:26:14 `interp 뚝섬 d=827m, gp=성수, rt=성수` 케이스 재현.
      // lock 시점 시간 적분이 lockless-route-hop/default-hop으로 뚝섬을 가리켜도,
      // fire path는 GPS(성수) 유지여야 한다. 사용자 실제 위치 추월 차단.
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 90_000);
        // 사용자는 성수 정차 중 — GPS가 성수 보고. lock anchor는 출발 시 용마산이지만
        // 시간이 흘러 estimator는 다음 hop을 추정한다.
        // 본 케이스의 핵심: estimator 결과가 GPS와 다른 station을 가리키더라도 fire path 불승격.
        setupGpsAt(gunja); // 군자 시뮬레이션 (lock 뚝섬, gps gunja 류 mismatch)
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        // fire path source: GPS 또는 fused 실측 — 절대 boarding-lock-interp 아님.
        expect(result.current.source).not.toBe('boarding-lock-interp');
        expect(result.current.confidence).not.toBe('boarding-lock-interp');
        // dedup 누적 차단: currentHopIndex(시간 적분 SSOT)도 null로 박탈.
        expect(result.current.currentHopIndex).toBeNull();
        // UI 추적은 유지 — displayOnlyEstimate에 estimator 결과 그대로.
        expect(result.current.displayOnlyEstimate).not.toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('#1437 userLocation null + GPS result null → fire path result도 null (estimator override 박탈)', () => {
      // 정책 박탈 후: GPS가 없으면 fire path도 그대로 비어 있다. estimator가 채워주지 않는다.
      // displayOnlyEstimate만 estimator 결과를 노출.
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 90_000);
        mockUseNearest.mockReturnValue(
          gpsBase({ userLocation: null, result: null }),
        );
        mockFindTop.mockReturnValue([]);
        mockUseArrival.mockReturnValue(arrivalRet(null));
        mockUsePositions.mockReturnValue(positionRet(null));
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.source).not.toBe('boarding-lock-interp');
        expect(result.current.result).toBeNull();
        expect(result.current.displayOnlyEstimate?.station.id).toBe(junggok.id);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('#745 Strategy ② ArrivalEta 통합', () => {
    const yongmasan = findStationByNameAndLine('용마산', '7')!;
    const junggok = findStationByNameAndLine('중곡', '7')!;
    const konkuk = findStationByNameAndLine('건대입구', '7')!;
    const route = makeDirectRoute(4, '7');
    const routeContext = { route, origin: yongmasan, destination: konkuk };
    const T0_745 = 1_700_000_000_000;
    const lock = {
      destinationId: konkuk.id,
      trainCode: '7093',
      boardingStationId: yongmasan.id,
      boardingLine: '7' as const,
      boardedAt: T0_745,
      expectedDurationMs: 30 * 60_000,
    };

    function setupLooseAccuracyAt(station: typeof yongmasan): void {
      // accuracyMeters=1500 → fusionDistanceGate 면제 (지하 가정)
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: station.lat, lng: station.lng },
          result: { station, distanceKm: 0 },
          accuracyMeters: 1500,
        }),
      );
    }

    it('LivePosition stale + 다음 역 arrival 신선 → 결과 station이 다음 역(중곡)으로 전진 (drift=0)', () => {
      jest.useFakeTimers();
      try {
        // 1단계: LivePosition 신선(t7093 at 용마산) → lastObservedRef seed
        // Effect 1(LivePosition tracker)이 ref를 시드한 후 Effect 2(lock-key reset)가 첫 렌더에
        // null→key 전환을 잡아 ref를 한 번 wipe 한다(#621 reset 의도). 두 번째 렌더로 Effect 1을
        // 다시 트리거하면 ref가 안정적으로 idx=0에 박힌다 — 이 시점부터 Strategy ②가 활성.
        jest.setSystemTime(T0_745);
        setupLooseAccuracyAt(yongmasan);
        mockFindTop.mockReturnValue([
          { station: yongmasan, distanceKm: 0 },
          { station: junggok, distanceKm: 0.5 },
        ]);
        const arrivalAtJunggok: StationArrival = {
          up: [
            info(ARRIVAL_CODE.ENTERING, {
              trainCode: '7093',
              line: '7',
              receivedAtMs: T0_745 + 10_000,
              arrivalSeconds: 14,
            }),
          ],
          down: [],
        };
        // stationName 기반 mock — Strict Mode/effect 재호출에도 안정적으로 같은 값 반환.
        mockUseArrival.mockImplementation((name: string | null) => {
          if (name === junggok.name) return arrivalRet(arrivalAtJunggok);
          return arrivalRet(null);
        });
        // 렌더마다 다른 reference로 positions 반환 — Effect 1(freshTrainProgress 변경) 재실행 유도.
        mockUsePositions.mockImplementation(() => ({
          positions: {
            line: '7' as const,
            trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: '7093' })],
          },
          loading: false,
          isMock: false,
        }));

        const { result, rerender } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.result?.station.id).toBe(yongmasan.id);

        // 두 번째 LivePosition fresh 렌더 — Effect 2의 lock-key 리셋이 이미 정착했으므로
        // Effect 1이 idx=0를 ref에 안정적으로 박는다.
        jest.setSystemTime(T0_745 + 5_000);
        rerender(undefined);

        // 3단계: LivePosition 끊김. ref={arcIndex:0}이 보존된 상태에서 ② 활성 — 다음 역(중곡)
        // arrival의 trainCode/ENTERING 매칭으로 결과가 junggok으로 전진.
        mockUsePositions.mockImplementation(() => ({
          positions: { line: '7' as const, trains: [] },
          loading: false,
          isMock: false,
        }));
        jest.setSystemTime(T0_745 + 15_000);
        rerender(undefined);

        // R13-a (#1612): gateOpts에 lockActive 추가로 detectionVerdict cascade tier 동작이 변경됐다.
        // strategy ②의 fire path 진입이 lock 활성 trip에서 lastObservedRef fallback (yongmasan)으로
        // 흐른다. displayOnlyEstimate는 estimator 결과(junggok)를 노출 유지 — UI/DebugModal 추적은 그대로.
        // 후속 PR(별도 이슈)에서 strategy ②의 lock 활성 trip detectionVerdict cascade 동작 재정의 예정.
        expect(result.current.result?.station.id).toBe(yongmasan.id);
      } finally {
        jest.useRealTimers();
        mockUseArrival.mockReset();
        mockUsePositions.mockReset();
      }
    });

    // ② skip 시나리오 공통 헬퍼 — 두 테스트가 동일한 시드 패턴(LivePosition 신선 → 끊김 → ③ fallback)을
    // 공유하지만 후보 슬롯/arrival 데이터/시간 진행만 다르므로 중복 setup을 helper로 추출 (SonarCloud CPD).
    function runArrivalEtaSkipScenario(opts: {
      candidates: Array<{ station: Station; distanceKm: number }>;
      arrivalMock: (name: string | null) => ReturnType<typeof arrivalRet>;
      disconnectAtMs: number;
    }) {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0_745);
        setupLooseAccuracyAt(yongmasan);
        mockFindTop.mockReturnValue(opts.candidates);
        mockUseArrival.mockImplementation(opts.arrivalMock);
        mockUsePositions.mockImplementation(() => ({
          positions: {
            line: '7' as const,
            trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: '7093' })],
          },
          loading: false,
          isMock: false,
        }));
        const { result, rerender } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        jest.setSystemTime(T0_745 + 5_000);
        rerender(undefined);
        // LivePosition 끊김 → ② skip 분기 평가 후 ③ ReanchoredHop fallback 확인용.
        mockUsePositions.mockImplementation(() => ({
          positions: { line: '7' as const, trains: [] },
          loading: false,
          isMock: false,
        }));
        jest.setSystemTime(opts.disconnectAtMs);
        rerender(undefined);
        // #1437 — ReanchoredHop도 시간 적분이라 fire path 박탈. estimator는 displayOnly에만.
        // fire path source는 GPS('gps')로 fallback. displayOnly에 reanchored-hop strategy 노출.
        expect(result.current.source).not.toBe('boarding-lock-interp');
        expect(result.current.displayOnlyEstimate?.strategy).toBe('reanchored-hop');
      } finally {
        jest.useRealTimers();
        mockUseArrival.mockReset();
        mockUsePositions.mockReset();
      }
    }

    it('다음 역이 GPS 후보가 아니면 ② skip → ③(ReanchoredHop)으로 fallback (line 133 return [])', () => {
      // 후보에 다음 역(중곡) 없음 — 슬롯 stationName=용마산 vs station.name=중곡 → 모두 continue.
      // 슬롯에 arrival 데이터를 주입(line 127 '!arrival' continue가 아닌 line 128 stationName 불일치 분기 cover).
      // Seam B (#898): lastObserved=용마산(idx 0) → cap=중곡(idx 1). disconnect 90s 후 ReanchoredHop 채택.
      const arrivalAtYongmasan: StationArrival = {
        up: [info(ARRIVAL_CODE.RUNNING, { trainCode: 'OTHER', line: '7' })],
        down: [],
      };
      runArrivalEtaSkipScenario({
        candidates: [{ station: yongmasan, distanceKm: 0 }],
        arrivalMock: (name) =>
          name === yongmasan.name ? arrivalRet(arrivalAtYongmasan) : arrivalRet(null),
        disconnectAtMs: T0_745 + 90_000,
      });
    });

    it('다음 역 슬롯이 있어도 row.line이 모두 다른 호선이면 ② skip (matched.length=0 branch, line 131)', () => {
      // 중곡 슬롯 arrival의 row.line='2', junggok.line='7' 불일치 → filter 빈 배열. RUNNING(99)으로 fused 픽업 차단.
      // Seam B (#898): disconnect 90s 후 ReanchoredHop이 lastObserved+1=중곡까지만 진행.
      const arrivalAtJunggokWrongLine: StationArrival = {
        up: [info(ARRIVAL_CODE.RUNNING, { trainCode: '7093', line: '2' })],
        down: [],
      };
      runArrivalEtaSkipScenario({
        candidates: [
          { station: yongmasan, distanceKm: 0 },
          { station: junggok, distanceKm: 0.5 },
        ],
        arrivalMock: (name) =>
          name === junggok.name ? arrivalRet(arrivalAtJunggokWrongLine) : arrivalRet(null),
        disconnectAtMs: T0_745 + 5_000 + 90_000,
      });
    });

    it('신규 폴링 없음 회귀 — 단일 렌더에서 useArrivalInfo 호출 횟수는 후보 슬롯 수(K=3)와 같다', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0_745);
        setupLooseAccuracyAt(yongmasan);
        mockFindTop.mockReturnValue([
          { station: yongmasan, distanceKm: 0 },
          { station: junggok, distanceKm: 0.5 },
        ]);
        const arrivalAtJunggok: StationArrival = {
          up: [
            info(ARRIVAL_CODE.ENTERING, {
              trainCode: '7093',
              line: '7',
              receivedAtMs: T0_745,
              arrivalSeconds: 14,
            }),
          ],
          down: [],
        };
        mockUseArrival.mockImplementation((name: string | null) => {
          if (name === junggok.name) return arrivalRet(arrivalAtJunggok);
          return arrivalRet(null);
        });
        mockUsePositions.mockReturnValue(positionRet(null));

        // 호출 횟수만 검증 — Strategy ②가 도입돼도 hook slot 증설(=신규 폴링) 없음을 회귀로 고정.
        // renderHook은 effect 적용을 위해 React가 2회 commit phase를 실행할 수 있어 단순 등호 대신
        // (calls % K === 0) 형태로 검증해 K=3 슬롯 가정만 고정한다.
        renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        const calls = mockUseArrival.mock.calls.length;
        expect(calls % 3).toBe(0);
        expect(calls).toBeLessThanOrEqual(6); // 정상 1~2회 commit (StrictMode 등).
      } finally {
        jest.useRealTimers();
        mockUseArrival.mockReset();
      }
    });
  });

  describe('#903 Seam G: barometer subsurface confidence 강등', () => {
    beforeEach(() => {
      mockUseNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);
      mockUseArrival.mockReturnValue(arrivalRet(null));
      mockUsePositions.mockReturnValue(positionRet(null));
    });

    const renderWithSub = (sub?: boolean) =>
      renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null, null, false, { subsurface: sub }),
      );

    it.each([
      { label: 'subsurface=true + gps-only → gps-only-underground 강등', sub: true, expected: 'gps-only-underground' },
      { label: 'subsurface=false → 강등 없음', sub: false, expected: 'gps-only' },
      { label: 'subsurface 미전달 → 강등 없음 (graceful)', sub: undefined, expected: 'gps-only' },
    ])('$label', ({ sub, expected }) => {
      const { result } = renderWithSub(sub);
      expect(result.current.confidence).toBe(expected);
    });

    it('subsurface=true + 강등 케이스: source=gps + result=GPS 최근접 유지', () => {
      const { result } = renderWithSub(true);
      expect(result.current.source).toBe('gps');
      expect(result.current.result?.station.id).toBe(MOCK_STATIONS.gangnam.id);
    });

    it('subsurface=true이지만 confidence가 arrival-confirmed면 강등하지 않음', () => {
      // arrival-confirmed는 자체 검증 신호 — 기압계로 강등하지 않는다.
      // #2204 — mockImplementation으로 매 호출 새 객체 반환. temporal consensus가 연속 2 cycle
      // 같은 station의 ARRIVED를 요구하므로 rerender로 두 번째 cycle을 재현한다.
      mockUseArrival.mockImplementation(() =>
        arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }),
      );
      const { result, rerender } = renderWithSub(true);
      act(() => {
        rerender({});
      });
      expect(result.current.confidence).toBe('arrival-confirmed');
    });
  });

  describe('#963 fusionDebugBuffer decisionKey signal mask', () => {
    // #1926 — 본 describe는 motionForDump fallback 분기(accelerometerPattern='unknown' →
    // motionStationary boolean) 검증이 핵심이므로, 본 describe 동안 accelerometerPattern
    // mock을 'unknown'으로 override해 fallback path를 노출.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const accelMockGlobal = require('../useAccelerometerFingerprint').useAccelerometerFingerprint as jest.Mock;
    beforeEach(() => {
      mockUseNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);
      mockUseArrival.mockReturnValue(arrivalRet(null));
      mockUsePositions.mockReturnValue(positionRet(null));
      accelMockGlobal.mockImplementation(() => 'unknown');
    });
    afterEach(() => {
      accelMockGlobal.mockImplementation(() => 'automotive');
    });

    const renderWithMotion = (motionStationary: boolean | undefined) =>
      renderHook(
        ({ ms }: { ms: boolean | undefined }) =>
          useFusedNearestStation(undefined, undefined, undefined, null, null, ms),
        { initialProps: { ms: motionStationary } },
      );

    it('같은 source/confidence/stationId + 다른 signal 조합 → 별도 entry로 보존', () => {
      const {
        clearFusionDebugEntries,
        getFusionDebugEntries,
      } = jest.requireActual('../../utils/fusionDebugBuffer') as typeof import('../../utils/fusionDebugBuffer');
      clearFusionDebugEntries();

      // motionStationary=false → mask "UFU"
      const { rerender } = renderWithMotion(false);
      // motionStationary=true → 같은 source/confidence/stationId, mask "UTU"
      rerender({ ms: true });
      // motionStationary=undefined → mask "UUU"
      rerender({ ms: undefined });

      const entries = getFusionDebugEntries().filter((e) => e.kind === 'fusion');
      // 동일 source/confidence/stationId여도 mask가 다르므로 3개 보존
      expect(entries.length).toBe(3);
    });

    it('완전 동일 signal 조합 재렌더 → dedup 유지 (entry 1개)', () => {
      const {
        clearFusionDebugEntries,
        getFusionDebugEntries,
      } = jest.requireActual('../../utils/fusionDebugBuffer') as typeof import('../../utils/fusionDebugBuffer');
      clearFusionDebugEntries();

      const { rerender } = renderWithMotion(true);
      rerender({ ms: true });
      rerender({ ms: true });

      const entries = getFusionDebugEntries().filter((e) => e.kind === 'fusion');
      expect(entries.length).toBe(1);
    });
  });

  describe('#957 (P1.4) pickArrivalForStationName — 환승역 line 좁힘', () => {
    // 같은 stationName('충무로') 다른 line('3'/'4')이 동시에 후보 슬롯에 들어온 환승역.
    // useArrivalInfo는 (name, line)로 폴링하므로 슬롯의 line은 응답 라인과 1:1 동일.
    const arrival3: StationArrival = { up: [info(ARRIVAL_CODE.RUNNING, { line: '3' })], down: [] };
    const arrival4: StationArrival = { up: [info(ARRIVAL_CODE.ARRIVED, { line: '4' })], down: [] };
    const slotsTransfer = [
      { stationName: '충무로', line: '3', arrival: arrival3 },
      { stationName: '충무로', line: '4', arrival: arrival4 },
      { stationName: null, line: null, arrival: null },
    ];

    it('result.line=3호선 → 3호선 슬롯 픽 (4호선 옆 슬롯 무시)', () => {
      expect(pickArrivalForStationName('충무로', '3', slotsTransfer)).toBe(arrival3);
    });

    it('result.line=4호선 → 4호선 슬롯 픽', () => {
      expect(pickArrivalForStationName('충무로', '4', slotsTransfer)).toBe(arrival4);
    });

    it('line 미일치(다른 호선만 슬롯에 있음) → null 반환 → fusion 입력 unavailable', () => {
      expect(pickArrivalForStationName('충무로', '5', slotsTransfer)).toBeNull();
    });

    it('단일 노선 일반역(매칭 슬롯 존재) → 기존 동작 동일', () => {
      const slots = [{ stationName: '강남', line: '2', arrival: arrival3 }];
      expect(pickArrivalForStationName('강남', '2', slots)).toBe(arrival3);
    });

    it('매칭 슬롯의 arrival이 null이면 skip하고 다음 슬롯 검사', () => {
      const slots = [
        { stationName: '충무로', line: '3', arrival: null },
        { stationName: '충무로', line: '3', arrival: arrival3 },
      ];
      expect(pickArrivalForStationName('충무로', '3', slots)).toBe(arrival3);
    });

    it('빈 슬롯 배열 → null', () => {
      expect(pickArrivalForStationName('충무로', '3', [])).toBeNull();
    });
  });

  describe('#1290 subsurfaceStationDetected cascade', () => {
    // 기본 GPS + 후보 1개 setup (subsurfaceStationDetected 케이스 공유).
    // distanceKm=0.1 → MAX_FUSION_DISTANCE_KM(0.6) 이내 → 근접 게이트 통과.
    beforeEach(() => {
      mockUseNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);
      mockUseArrival.mockReturnValue(arrivalRet(null));
      mockUsePositions.mockReturnValue(positionRet(null));
    });

    it('subsurface=true + barometer-stop + motion-stationary (≥2 합의) → subsurfaceStationDetected=true', () => {
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          null,
          null,
          /* motionStationary */ true,
          { subsurface: true, signal: { subsurface: true, stop: true } },
        ),
      );
      expect(result.current.subsurfaceStationDetected).toBe(true);
    });

    it('subsurface=true + 단일 신호(barometer-stop)만 합의 → subsurfaceStationDetected=false (≥2 미달)', () => {
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          null,
          null,
          /* motionStationary */ undefined,
          { subsurface: true, signal: { subsurface: true, stop: true } },
        ),
      );
      expect(result.current.subsurfaceStationDetected).toBe(false);
    });

    it('subsurface=false + ≥2 신호 합의여도 → subsurfaceStationDetected=false (지하 아님)', () => {
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          null,
          null,
          /* motionStationary */ true,
          { subsurface: false, signal: { subsurface: false, stop: true } },
        ),
      );
      expect(result.current.subsurfaceStationDetected).toBe(false);
    });

    it('subsurface 미전달 + ≥2 신호 합의여도 → subsurfaceStationDetected=false', () => {
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          null,
          null,
          /* motionStationary */ true,
          { signal: { subsurface: false, stop: true } },
        ),
      );
      expect(result.current.subsurfaceStationDetected).toBe(false);
    });

    it('subsurface=true + ≥2 합의 + 근접 게이트 미달(distanceKm>MAX) → subsurfaceStationDetected=false', () => {
      // distanceKm=0.7 > MAX_FUSION_DISTANCE_KM(0.6) → 근접 게이트 탈락.
      mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.7 }]);
      // GPS result를 gangnam으로, distanceKm=0.7 세팅.
      mockUseNearest.mockReturnValue(
        gpsBase({
          result: { station: MOCK_STATIONS.gangnam, distanceKm: 0.7 },
        }),
      );
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          null,
          null,
          /* motionStationary */ true,
          { subsurface: true, signal: { subsurface: true, stop: true } },
        ),
      );
      expect(result.current.subsurfaceStationDetected).toBe(false);
    });

    it('subsurface=true + ≥2 합의 + result=null → subsurfaceStationDetected=false', () => {
      mockUseNearest.mockReturnValue(gpsBase({ userLocation: null, result: null }));
      mockFindTop.mockReturnValue([]);
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          null,
          null,
          /* motionStationary */ true,
          { subsurface: true, signal: { subsurface: true, stop: true } },
        ),
      );
      expect(result.current.subsurfaceStationDetected).toBe(false);
    });
  });

  describe('#1398 cascade verdict 결합 — detection-fused 라벨 승격', () => {
    // gps-only-underground 상태에서 ≥2 신호 합의 + 근접 게이트 통과 시 confidence를 'detection-fused'로 승격.
    // source는 'gps' 유지(좌표 신호원 동일). 측정/dump에서 cascade가 verdict를 인식한 사실을 명확히 표시.
    beforeEach(() => {
      mockUseNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);
      mockUseArrival.mockReturnValue(arrivalRet(null));
      mockUsePositions.mockReturnValue(positionRet(null));
    });

    // 3 케이스가 동일한 renderHook 7-인자 형태 + .confidence 검증을 반복 → Sonar cpd.
    // motionStationary/barometer signal만 다르고 expected confidence/source만 분기 → 테이블화.
    function renderDetectionCascade(
      motionStationary: boolean | undefined,
      baro: { subsurface: boolean; signal: { subsurface: boolean; stop: boolean } },
    ): ReturnType<typeof renderHook<ReturnType<typeof useFusedNearestStation>, unknown>>['result'] {
      return renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null, null, motionStationary, baro),
      ).result;
    }

    it.each<{
      label: string;
      motionStationary: boolean | undefined;
      baro: { subsurface: boolean; signal: { subsurface: boolean; stop: boolean } };
      expectedConfidence: string;
    }>([
      {
        label: 'gps-only-underground + ≥2 신호 합의 + 근접 → detection-fused 승격',
        motionStationary: true,
        baro: { subsurface: true, signal: { subsurface: true, stop: true } },
        expectedConfidence: 'detection-fused',
      },
      {
        label: 'gps-only-underground + 단일 신호 합의 (≥2 미달) → detection-fused 미승격, gps-only-underground 유지',
        motionStationary: undefined,
        baro: { subsurface: true, signal: { subsurface: true, stop: true } },
        expectedConfidence: 'gps-only-underground',
      },
      {
        label: 'subsurface=false (지상) → cascade 진입 X, 기존 gps-only',
        motionStationary: true,
        baro: { subsurface: false, signal: { subsurface: false, stop: true } },
        expectedConfidence: 'gps-only',
      },
    ])('$label', ({ motionStationary, baro, expectedConfidence }) => {
      const result = renderDetectionCascade(motionStationary, baro);
      expect(result.current.confidence).toBe(expectedConfidence);
      // source는 모든 케이스에서 'gps' — 좌표 신호원 자체는 GPS.
      expect(result.current.source).toBe('gps');
    });
  });

  // #1436 — trip route allowedLines filter. fusion 후보 단계에서 trip 외 노선 entry 차단.
  // 좌표는 같지만 이름이 다른 entry(왕십리(성동구청) vs 왕십리)가 name dedup을 우회해
  // 분당선 variant가 fusion result로 흘러가던 회귀 차단.
  describe('routeContext allowedLines filter (#1436)', () => {
    it('routeContext 없으면 allowedLines 미전달 (자유 화면 기존 동작)', () => {
      mockUseNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([]);
      renderHook(() => useFusedNearestStation());
      const call = mockFindTop.mock.calls[0];
      // 5번째 인자가 allowedLines — undefined여야 함.
      expect(call[4]).toBeUndefined();
    });

    it('direct route → allowedLines = {route.line}', () => {
      mockUseNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([]);
      const routeContext = {
        route: makeDirectRoute(5, '2' as const),
        origin: originStation(),
        destination: destinationStation(),
      };
      renderHook(() => useFusedNearestStation(undefined, undefined, routeContext));
      const allowed = mockFindTop.mock.calls[0][4] as Set<string>;
      expect(allowed).toBeInstanceOf(Set);
      expect([...allowed].sort((a, b) => a.localeCompare(b))).toEqual(['2']);
    });

    it('transfer route → allowedLines = {fromLine, toLine} (왕십리 분당선 회귀 방어)', () => {
      mockUseNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([]);
      const routeContext = {
        route: makeTransferRoute({
          transferName: '왕십리(성동구청)',
          fromLine: '2' as const,
          toLine: '5' as const,
          stopsToTransfer: 3,
          stopsFromTransfer: 4,
        }),
        origin: originStation(),
        destination: destinationStation(),
      };
      renderHook(() => useFusedNearestStation(undefined, undefined, routeContext));
      const allowed = mockFindTop.mock.calls[0][4] as Set<string>;
      expect([...allowed].sort((a, b) => a.localeCompare(b))).toEqual(['2', '5']);
      // trip route 외 line(bundang/gyeongui)은 후보 단계에서 reject 대상.
      expect(allowed.has('bundang')).toBe(false);
      expect(allowed.has('gyeongui')).toBe(false);
    });

    it('multi-transfer route → 모든 segment의 fromLine/toLine 합집합', () => {
      mockUseNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([]);
      const routeContext = {
        route: makeMultiTransferRoute({
          transfers: [
            { transferName: '교대', fromLine: '2' as const, toLine: '3' as const, stopsToTransfer: 2 },
            { transferName: '왕십리(성동구청)', fromLine: '3' as const, toLine: '5' as const, stopsToTransfer: 4 },
          ],
          stopsAfterLastTransfer: 3,
        }),
        origin: originStation(),
        destination: destinationStation(),
      };
      renderHook(() => useFusedNearestStation(undefined, undefined, routeContext));
      const allowed = mockFindTop.mock.calls[0][4] as Set<string>;
      expect([...allowed].sort((a, b) => a.localeCompare(b))).toEqual(['2', '3', '5']);
    });

    it('routeContext.route=null이면 allowedLines 미전달 (route 미설정 상태)', () => {
      mockUseNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([]);
      const routeContext = {
        route: null,
        origin: originStation(),
        destination: destinationStation(),
      };
      renderHook(() => useFusedNearestStation(undefined, undefined, routeContext));
      expect(mockFindTop.mock.calls[0][4]).toBeUndefined();
    });
  });

  // #1486 (ADR-015 §2) — sticky:locked fire 권한 영구 박탈 회귀 가드.
  //
  // useNearestStation:487-504 `exposed`는 sticky.locked가 있고 live와 다른 역이면
  // result.station을 sticky.locked로 override한다. 이전에는 그 result가 useFusedNearestStation
  // cascade fallback의 `gps.result` 입력으로 들어가 fire path(`useStationAlarm.nearestStation`)에 새었다.
  //
  // 2026-06-16 13:27:18 / 13:28:39 dump 시나리오: sticky:locked가 1km 점프(better-fix 갱신 직전
  // 혹은 stale lock)된 상태에서 useStationAlarm이 sticky station에 대한 station-passed를 fire할 가능성.
  //
  // 보강 (ADR-015 §2 처방): useNearestStation에 `liveResult`/`stickyDisplayOnly` 별 채널 분리.
  // useFusedNearestStation cascade fallback은 `gps.liveResult`만 사용 → sticky가 fire path에 진입 불가.
  describe('#1486 sticky:locked fire path 격리 (ADR-015 §2)', () => {
    // sticky override + live GPS 분리 setup helper — useNearestStation의 exposed 동작 시뮬레이션.
    //   result          = sticky.locked로 override된 표시 채널
    //   liveResult      = sticky override 없는 실 GPS 결과 (cascade fallback SSOT)
    //   findTopNearest  = 다른 신호(wifi/positionTrain/fused/route) 미통과 가정
    function renderWithStickyOverride(opts: {
      stickyStation: (typeof MOCK_STATIONS)[keyof typeof MOCK_STATIONS];
      liveStation: (typeof MOCK_STATIONS)[keyof typeof MOCK_STATIONS];
      stickyDistance?: number;
      liveDistance?: number;
      accuracyMeters?: number;
    }) {
      const { stickyStation, liveStation, stickyDistance = 0.1, liveDistance = 0.1, accuracyMeters } = opts;
      mockUseNearest.mockReturnValue(
        gpsBase({
          result: { station: stickyStation, distanceKm: stickyDistance },
          liveResult: { station: liveStation, distanceKm: liveDistance },
          stickyDisplayOnly: stickyStation,
          source: 'sticky' as const,
          ...(accuracyMeters != null ? { accuracyMeters } : {}),
        }),
      );
      mockFindTop.mockReturnValue([{ station: liveStation, distanceKm: liveDistance }]);
      return renderHook(() => useFusedNearestStation());
    }

    it('sticky가 다른 역 lock + 다른 신호 미통과 → fire path result는 live GPS 결과 (sticky 무시)', () => {
      // exposed.result = sticky.locked (효창공원앞) / liveResult = GPS 최근접 (강남)
      const stickyStation = MOCK_STATIONS.chungmuro;
      const liveStation = MOCK_STATIONS.gangnam;
      const { result } = renderWithStickyOverride({ stickyStation, liveStation });

      // fire path SSOT — sticky가 아닌 live GPS 결과로 cascade fallback.
      expect(result.current.result?.station.id).toBe(liveStation.id);
      expect(result.current.source).toBe('gps');
      expect(result.current.confidence).toBe('gps-only');
      // 표시 채널 — sticky 정보는 stickyDisplayOnly로 별 노출(DebugModal/UI 추적용).
      expect(result.current.stickyDisplayOnly?.id).toBe(stickyStation.id);
    });

    it('1km 점프 시나리오 — sticky가 stale lock된 station을 가리켜도 fire path는 GPS 최근접', () => {
      // 2026-06-16 13:27:18 / 13:28:39 dump 재현:
      // sticky가 용마산(7) lock 상태에서 사용자가 사가정(7)으로 이동 → GPS 최근접은 사가정.
      // sticky better-fix 조건(N=3 좋은 fix 연속) 충족 전에는 sticky가 용마산 유지.
      const stickyStation = MOCK_STATIONS.gangnam;
      const liveStation = MOCK_STATIONS.chungmuro;
      const { result } = renderWithStickyOverride({
        stickyStation,
        liveStation,
        stickyDistance: 1,
        liveDistance: 0.05,
        accuracyMeters: 50,
      });

      // fire path는 sticky station에 false station-passed fire를 발사하지 않는다.
      expect(result.current.result?.station.id).toBe(liveStation.id);
      expect(result.current.result?.station.id).not.toBe(stickyStation.id);
      expect(result.current.source).toBe('gps');
    });

    it('sticky 비활성 → result/liveResult 동일 (회귀 가드 무영향)', () => {
      // sticky 비활성 (stickyDisplayOnly=null): 기존 동작 그대로.
      mockUseNearest.mockReturnValue(gpsBase()); // 기본값: result=liveResult=gangnam, sticky=null
      mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);

      const { result } = renderHook(() => useFusedNearestStation());

      expect(result.current.result?.station.id).toBe(MOCK_STATIONS.gangnam.id);
      expect(result.current.stickyDisplayOnly).toBeNull();
      expect(result.current.source).toBe('gps');
    });

    it('표시 채널 stickyDisplayOnly — sticky lock된 station 그대로 패스스루', () => {
      const stickyStation = MOCK_STATIONS.chungmuro;
      const liveStation = MOCK_STATIONS.gangnam;
      const { result } = renderWithStickyOverride({ stickyStation, liveStation });

      // DebugModal/UI는 stickyDisplayOnly로 sticky 정보 노출.
      expect(result.current.stickyDisplayOnly).toEqual(stickyStation);
    });
  });

  // #2125 — 현재역 표시 고착 정직 강등 (RCA (d) 옵션 1). 표시 계층 전용 — 4조건 AND.
  describe('#2125 현재역 표시 고착 정직 강등', () => {
    const yongmasan = findStationByNameAndLine('용마산', '7')!;
    const junggok = findStationByNameAndLine('중곡', '7')!;
    const konkuk = findStationByNameAndLine('건대입구', '7')!;
    const route = makeDirectRoute(4, '7');
    const routeContext = { route, origin: yongmasan, destination: konkuk };
    const T0 = 1_700_000_000_000;

    beforeEach(() => {
      clearFusionDebugEntries();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    // sticky가 tripOrigin(용마산)에 고정 + 다른 신호 미채택 상태로 렌더 후 elapsedMs만큼 경과시킨다.
    // wifiStation을 지정하면 상위 tier(wifi) 채택 시나리오를 재현할 수 있다.
    function renderStuckAtOrigin(opts?: { elapsedMs?: number; wifiStation?: Station | null }) {
      const { elapsedMs = CURRENT_STATION_STALE_DEMOTE_MS, wifiStation = null } = opts ?? {};
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
          result: { station: yongmasan, distanceKm: 0 },
          liveResult: { station: yongmasan, distanceKm: 0 },
          stickyDisplayOnly: yongmasan,
          source: 'sticky' as const,
        }),
      );
      mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);
      jest.useFakeTimers();
      jest.setSystemTime(T0);
      const { result, rerender } = renderHook(
        (wifi: Station | null) =>
          useFusedNearestStation(
            undefined,
            undefined,
            routeContext,
            undefined,
            undefined,
            undefined,
            undefined,
            wifi,
          ),
        { initialProps: wifiStation },
      );
      jest.setSystemTime(T0 + elapsedMs);
      rerender(wifiStation);
      return result;
    }

    it('4조건 충족 (trip 활성 + sticky==tripOrigin + 상위 tier 부재 + 3분 경과) → 강등 true + fusion log 1건', () => {
      const result = renderStuckAtOrigin();

      expect(result.current.currentStationDisplayDemoted).toBe(true);
      const entries = getFusionDebugEntries().filter(
        (e): e is DisplayDemoteEntry => e.kind === 'display-demote',
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].reason).toBe('display-demote-sticky-stale');
      expect(entries[0].stationName).toBe(yongmasan.name);
      expect(entries[0].line).toBe(yongmasan.line);
    });

    it('조건1 미충족 — trip 비활성(routeContext 없음) → 강등하지 않음', () => {
      mockUseNearest.mockReturnValue(
        gpsBase({
          result: { station: yongmasan, distanceKm: 0 },
          liveResult: { station: yongmasan, distanceKm: 0 },
          stickyDisplayOnly: yongmasan,
          source: 'sticky' as const,
        }),
      );
      mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);

      const { result } = renderHook(() => useFusedNearestStation());

      expect(result.current.currentStationDisplayDemoted).toBe(false);
      expect(
        getFusionDebugEntries().filter((e) => e.kind === 'display-demote'),
      ).toHaveLength(0);
    });

    it('조건2 미충족 — result.station이 sticky 다른 역으로 전진(실제 이동 신호) → 강등하지 않음', () => {
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: junggok.lat, lng: junggok.lng },
          result: { station: junggok, distanceKm: 0 },
          liveResult: { station: junggok, distanceKm: 0 },
          stickyDisplayOnly: yongmasan,
          source: 'sticky' as const,
        }),
      );
      mockFindTop.mockReturnValue([{ station: junggok, distanceKm: 0 }]);
      jest.useFakeTimers();
      jest.setSystemTime(T0);
      const { result, rerender } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, routeContext),
      );
      jest.setSystemTime(T0 + CURRENT_STATION_STALE_DEMOTE_MS);
      rerender(undefined);

      expect(result.current.currentStationDisplayDemoted).toBe(false);
    });

    it('조건3 미충족 — 상위 tier(wifi) 채택 시 → 강등하지 않음', () => {
      const result = renderStuckAtOrigin({ wifiStation: yongmasan });

      expect(result.current.source).toBe('wifi-ssid');
      expect(result.current.currentStationDisplayDemoted).toBe(false);
    });

    it('조건4 미충족 — 3분 미경과 → 강등하지 않음', () => {
      const result = renderStuckAtOrigin({ elapsedMs: CURRENT_STATION_STALE_DEMOTE_MS - 1_000 });

      expect(result.current.currentStationDisplayDemoted).toBe(false);
    });

    it('강등 해제 — 상위 tier 채택으로 전환되면 즉시 false로 복귀', () => {
      mockUseNearest.mockReturnValue(
        gpsBase({
          userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
          result: { station: yongmasan, distanceKm: 0 },
          liveResult: { station: yongmasan, distanceKm: 0 },
          stickyDisplayOnly: yongmasan,
          source: 'sticky' as const,
        }),
      );
      mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);
      jest.useFakeTimers();
      jest.setSystemTime(T0);
      const { result, rerender } = renderHook(
        (wifi: Station | null) =>
          useFusedNearestStation(
            undefined,
            undefined,
            routeContext,
            undefined,
            undefined,
            undefined,
            undefined,
            wifi,
          ),
        { initialProps: null as Station | null },
      );
      jest.setSystemTime(T0 + CURRENT_STATION_STALE_DEMOTE_MS);
      rerender(null);
      expect(result.current.currentStationDisplayDemoted).toBe(true);

      // 상위 tier(wifi) 신호 도착 — 즉시 정상 복귀.
      rerender(yongmasan);
      expect(result.current.currentStationDisplayDemoted).toBe(false);
    });
  });
});
