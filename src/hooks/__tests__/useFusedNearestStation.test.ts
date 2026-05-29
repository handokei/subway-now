import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../useArrivalInfo';
import { useTrainPositions } from '../useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../utils/stationRoute';
import { ARRIVAL_CODE } from '../../constants/arrivalCodes';
import { TRAIN_STATUS } from '../../constants/trainStatus';
import { MOCK_STATIONS } from '../../testUtils/fixtures';
import type { StationArrival, ArrivalInfo } from '../../api/arrivalApi';
import type { LinePositions, TrainPosition } from '../../api/positionApi';
import type { DirectRoute } from '../../utils/stationRoute';

jest.mock('../useNearestStation');
jest.mock('../useArrivalInfo');
jest.mock('../useTrainPositions');
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
    // 공통 setup: position-train 채택 시나리오. lockedTrainCode 인자만 바꿔가며 라벨 검증.
    const setupPositionTrain = (overrideTrainNo: string) => {
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
            trains: [
              train(MOCK_STATIONS.chungmuro.name, TRAIN_STATUS.ARRIVED, {
                trainNo: overrideTrainNo,
              }),
            ],
          }),
        )
        .mockReturnValueOnce(positionRet(null));
    };

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
      const stationRouteModule = jest.requireActual('../../utils/stationRoute');
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
    const route: DirectRoute = { type: 'direct', stops: 4, line: '7' };

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
    const route: DirectRoute = { type: 'direct', stops: 4, line: '7' };
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

    it('GPS stale(용마산) + 3 hop 경과 → interp(어린이대공원)이 ratchet forward로 승격', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 3 * 90_000);
        setupGpsAt(yongmasan);
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.source).toBe('boarding-lock-interp');
        expect(result.current.confidence).toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(oolinidae.id);
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

    it('GPS가 arc 밖(서울역 공항철도) + lock 활성 → interp가 채택됨', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(T0 + 2 * 90_000);
        // 7호선 arc와 무관한 역
        setupGpsAt({ ...MOCK_STATIONS.seoulStation, line: 'airport' });
        const { result } = renderHook(() =>
          useFusedNearestStation(undefined, undefined, routeContext, '7093', lock),
        );
        expect(result.current.source).toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(gunja.id);
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
        // hook이 다시 호출되는 정상 사이클을 시뮬레이션.
        jest.setSystemTime(T0 + 3 * 90_000);
        rerender(undefined);
        expect(result.current.source).toBe('boarding-lock-interp');
        expect(result.current.result?.station.id).toBe(oolinidae.id);
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
});
