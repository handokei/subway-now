/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { renderHook } from '@testing-library/react-native';
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
import type { StationArrival, ArrivalInfo } from '../../../../shared/types/arrival';
import type { Station } from '../../../../shared/types/station';
import type { LinePositions, TrainPosition } from '../../api/positionApi';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';

jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));

const mockUseNearest = useNearestStation as jest.Mock;
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockUsePositions = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

function gpsBase(overrides?: Record<string, unknown>) {
  return {
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
    ...overrides,
  };
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

function arrivalRet(stationArrival: StationArrival | null = null) {
  return { arrival: stationArrival, loading: false, isMock: false };
}

function positionRet(positions: LinePositions | null = null) {
  return { positions, loading: false, isMock: false };
}

function train(
  statnNm: string,
  trainStatus: number,
  overrides?: Partial<TrainPosition>,
): TrainPosition {
  return {
    statnId: '',
    statnNm,
    trainNo: 'T',
    trainStatus,
    updnLine: 0,
    terminalStationId: '',
    terminalStationName: '',
    trainType: 'normal',
    isLastTrain: false,
    receivedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * position-train 채택 환승역 시나리오 — gangnam(2호선) GPS 1순위 + chungmuro(3호선) 2순위에
 * trainNo가 ARRIVED 상태. trackTrainProgress가 chungmuro(line=3)로 잠금.
 * #584 boarding-lock 라벨 / #662 fusion 강등 가드 두 describe 모두 같은 setup 사용.
 */
function setupPositionTrainTransferStation(trainNo: string): void {
  mockUseNearest.mockReturnValue(gpsBase({ accuracyMeters: 1500 }));
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

    // 후보 0,1,2 순서대로 useArrivalInfo 호출됨
    mockUseArrival
      .mockReturnValueOnce(arrivalRet({ up: [info(ARRIVAL_CODE.RUNNING)], down: [] }))
      .mockReturnValueOnce(arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }))
      .mockReturnValueOnce(arrivalRet(null));

    const { result } = renderHook(() => useFusedNearestStation());

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
    // MOCK_STATIONS 좌표가 (37.5,127.0)으로 동일하고 trackTrainProgress는 stations.json의
    // 실좌표를 조회한다. #445 거리 게이트와 충돌을 피하려고 accuracy를 게이트 면제 영역으로.
    mockUseNearest.mockReturnValue(gpsBase({ accuracyMeters: 1500 }));
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

    it('lockedTrainCode가 position-train의 trainNo와 일치하면 boarding-lock으로 승격', () => {
      setupPositionTrain('T-LOCKED');
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, 'T-LOCKED'),
      );
      expect(result.current.confidence).toBe('boarding-lock');
      expect(result.current.source).toBe('boarding-lock');
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
      mockUseArrival.mockReturnValue(arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }));
      mockUsePositions.mockReturnValue(positionRet(null));

      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, 'T-LOCKED'),
      );
      expect(result.current.confidence).toBe('arrival-confirmed');
      expect(result.current.source).toBe('arrival');
    });
  });

  describe('#662 환승역 fusion 강등 가드 (BoardingLock 기준)', () => {
    const lockOnLine = (line: '2' | '3'): import('../../../../shared/types/boardingLock').BoardingLock => ({
      destinationId: 'dest-1',
      trainCode: 'T-3',
      boardingStationId: MOCK_STATIONS.gangnam.id,
      boardingLine: line,
      boardedAt: Date.now(),
      expectedDurationMs: 600_000,
    });

    it('lock.boardingLine과 positionTrain.line이 다르면 positionTrain 강등 → GPS로 fallthrough', () => {
      setupPositionTrainTransferStation('T-3');
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null, lockOnLine('2')),
      );
      expect(result.current.source).toBe('gps');
      expect(result.current.result?.station.name).toBe(MOCK_STATIONS.gangnam.name);
    });

    it('lock.boardingLine과 positionTrain.line이 같으면 positionTrain 유지', () => {
      setupPositionTrainTransferStation('T-3');
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null, lockOnLine('3')),
      );
      expect(result.current.source).toBe('position-train');
      expect(result.current.result?.station.name).toBe(MOCK_STATIONS.chungmuro.name);
    });

    it('boardingLock 없으면 가드 미작동 (기존 동작 유지)', () => {
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
    ])('position-train + %s → 강등 안 됨', (_label, accuracy: number, speed: number, no: string) => {
      setupPositionTrainScenario(accuracy, speed, no);

      const { result } = renderHook(() => useFusedNearestStation());

      expect(result.current.confidence).toBe('position-train');
      expect(result.current.source).toBe('position-train');
    });

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

    mockUseArrival.mockReturnValue(arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }));
    mockUsePositions.mockReturnValue(positionRet(null));

    const { result } = renderHook(() => useFusedNearestStation());
    expect(result.current.confidence).toBe('arrival-confirmed');
    expect(result.current.source).toBe('arrival');
  });

  it('position-train 다중 후보: lastConfirmedTrainNo 우선(sticky) — 이전 결과 유지', () => {
    // #445 거리 게이트 우회 — MOCK 좌표와 stations.json 실좌표가 다르므로.
    mockUseNearest.mockReturnValue(gpsBase({ accuracyMeters: 1500 }));
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

    // 두 번째 렌더: 두 트레인 (T-1, T-2). GPS 없이도 sticky로 T-1 유지.
    mockUsePositions.mockReturnValue(
      positionRet({
        line: '2',
        trains: [
          train(MOCK_STATIONS.gangnam.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-1' }),
          train(MOCK_STATIONS.chungmuro.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-2' }),
        ],
      }),
    );
    mockUseNearest.mockReturnValue(gpsBase({ userLocation: null }));
    rerender(undefined);
    expect(result.current.source).toBe('position-train');
    expect(result.current.result?.station.name).toBe(MOCK_STATIONS.gangnam.name);
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

    it('지하 fix(accuracy > MAX_ACCURACY_M)면 거리 게이트 면제 → positionTrain 유지', () => {
      setup용마산GpsSagajeongTrain({ accuracyMeters: 1500 });
      const { result } = renderHook(() => useFusedNearestStation());
      // 지하 가정. positionTrain이 살아서 사가정을 그대로 채택.
      expect(result.current.source).toBe('position-train');
      expect(result.current.result?.station.name).toBe('사가정');
    });

    it('accuracy null도 거리 게이트 면제 → positionTrain 유지', () => {
      setup용마산GpsSagajeongTrain({ accuracyMeters: null });
      const { result } = renderHook(() => useFusedNearestStation());
      expect(result.current.source).toBe('position-train');
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
      jest.useFakeTimers();
      try {
        // mockImplementation으로 안정 — 매 호출마다 동일한 positions 반환.
        mockUseNearest.mockReturnValue(
          gpsBase({
            userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
            accuracyMeters: 1500, // 거리 게이트 면제 → TTL만 검사
            result: { station: yongmasan, distanceKm: 0 },
          }),
        );
        mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);
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
            userLocation: { lat: yongmasan.lat + 0.00001, lng: yongmasan.lng },
            accuracyMeters: 1500,
            result: { station: yongmasan, distanceKm: 0 },
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

    it('GPS stale(용마산) + 1 hop 경과 → interp(중곡)이 ratchet forward로 승격', () => {
      // Seam B (#898): 라이브 관측 없는 dead-zone에선 boardingIdx+1까지만 허용.
      // 본 시나리오는 lastObservedRef=null + boardingIdx=용마산(0) → cap=중곡(1).
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 90_000);
        setupGpsAt(yongmasan);
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.source).toBe('boarding-lock-interp');
        expect(result.current.confidence).toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(junggok.id);
      } finally {
        jest.useRealTimers();
      }
    });

    it('Seam B (#898) — dead-zone 3 hop 경과해도 interp이 boardingIdx+1 초과 안 함', () => {
      // 13:19:12 회귀 fixture 인자: LivePosition/ArrivalEta 모두 결손인 상황에서 적분이
      // 물리 위치보다 여러 hop 앞서 가는 것을 차단. estimator 내부 cap + 외부 cap 이중 가드.
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 3 * 90_000);
        setupGpsAt(yongmasan);
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.result?.station.id).toBe(junggok.id);
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

    it('GPS가 arc 밖(서울역 공항철도) + lock 활성 → interp가 boardingIdx+1까지 채택', () => {
      // Seam B (#898): GPS가 arc 밖이라도 라이브 관측은 여전히 없음 → cap=중곡(1).
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 2 * 90_000);
        // 7호선 arc와 무관한 역
        setupGpsAt({ ...MOCK_STATIONS.seoulStation, line: 'airport' });
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.source).toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(junggok.id);
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
        // GPS는 용마산(arc 첫 역). 7093이 군자(arc idx 2)에서 도착 — trainProgress → 군자.
        jest.setSystemTime(T0 + 2 * 90_000);
        setupGpsAtWithLoosAccuracy(yongmasan);
        const t7093 = train('군자', TRAIN_STATUS.ARRIVED, { trainNo: '7093' });
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

    it('시간만 흐르면(부모 리렌더 없이) interp가 다음 hop으로 전진 — useMemo 캐시 회귀 가드', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0);
        setupGpsAt(yongmasan);
        const { result, rerender } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        // 탑승 직후: interp=용마산(idx 0), GPS=용마산 → tied. GPS 유지.
        expect(result.current.result?.station.id).toBe(yongmasan.id);

        // 시계만 진행. boardingLock/arcStations/GPS는 그대로 — 의존성이 안 바뀌어도
        // interp이 새 now를 반영해야 한다. 부모 리렌더(rerender)는 한 번 발생시켜
        // hook이 다시 호출되는 정상 사이클을 시뮬레이션. Seam B cap에 따라 +1 hop까지.
        jest.setSystemTime(T0 + 90_000);
        rerender(undefined);
        expect(result.current.source).toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(junggok.id);
      } finally {
        jest.useRealTimers();
      }
    });

    it('userLocation null + GPS result null → interp 단독 채택 (distanceKm=0)', () => {
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
        expect(result.current.source).toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(junggok.id);
        expect(result.current.result?.distanceKm).toBe(0);
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

        // drift=0 — 결과 역이 lagged 용마산이 아니라 실제 위치(중곡).
        expect(result.current.result?.station.id).toBe(junggok.id);
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
        expect(result.current.source).toBe('boarding-lock-interp');
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
      mockUseArrival.mockReturnValue(arrivalRet({ up: [info(ARRIVAL_CODE.ARRIVED)], down: [] }));
      const { result } = renderWithSub(true);
      expect(result.current.confidence).toBe('arrival-confirmed');
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
});
