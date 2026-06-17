/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리.
 */
/**
 * useFusedNearestStation fusion 통합 테스트.
 *
 * 두 시나리오를 한 파일에 묶음 (mock 블록 중복 제거 — SonarCloud CPD 6.2% → 0).
 *
 * 1) #1401 (Epic #1396 sub 5/6) — trainProgressing 신호 검증.
 *    arc 위 fusion result.station idx가 prev → cur로 증가했는지(forward-only) 호출자에게 export.
 *      - 첫 tick: prev 없음 → false.
 *      - 같은 arcKey 안에서 idx 증가: true.
 *      - 같은 idx / 감소: false (forward-only).
 *      - arcKey 변경(새 trip): prev 리셋 → 첫 tick false.
 *      - arc 없음(arcStations.length=0) / result null: false.
 *
 * 2) #1015 — fusion forward-only 검증.
 *    boardingLock + arc(arcStations) 활성 시 positionTrainResult의 station이
 *    boarding index보다 backward(이전)면 null 반환 → fusion이 GPS fallback으로 내려가는지 검증.
 *
 * positionTrainResult / fusionDistanceGate / pickFusedStation / trackTrainProgress를 mock해
 * 시나리오별 station만 격리.
 */
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../utils/findNearestStation');
jest.mock('../../../route/utils/findActiveLines');
jest.mock('../../utils/fusionDistanceGate', () => ({
  passesFusionDistanceGate: () => true,
  isWithinArcWindow: () => true,
}));
jest.mock('../../utils/pickFusedStation', () => ({
  pickFusedStation: () => null,
}));
jest.mock('../../../route/utils/trackTrainProgress', () => ({
  trackTrainProgress: jest.fn(),
}));
jest.mock('../../../arrival/utils/pickCandidateTrains', () => ({
  pickCandidateTrains: jest.fn(),
}));
jest.mock('../../../route/utils/stationProgressEstimator', () => ({
  arcIndexOfStation: jest.requireActual('../../../route/utils/stationProgressEstimator')
    .arcIndexOfStation,
  estimateStationProgress: () => null,
}));
jest.mock('../../../route/utils/routeProgress', () => ({
  computeRouteArc: jest.fn(),
  nearestArcPoint: jest.fn(),
}));
jest.mock('../../../route/hooks/useRouteProgress', () => ({
  useRouteProgress: () => ({ position: null }),
}));

import { renderHook, act } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findActiveLines } from '../../../route/utils/findActiveLines';
import { trackTrainProgress } from '../../../route/utils/trackTrainProgress';
import { pickCandidateTrains } from '../../../arrival/utils/pickCandidateTrains';
import { computeRouteArc } from '../../../route/utils/routeProgress';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import { makeArcFixture, makeArcGpsBase, makeTrainProgressFor } from '../../../../testUtils/arcTestFixtures';

const mockUseNearest = useNearestStation as jest.Mock;
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockUsePositions = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockFindLines = findActiveLines as jest.Mock;
const mockTrackProgress = trackTrainProgress as jest.Mock;
const mockPickCandidates = pickCandidateTrains as jest.Mock;
const mockComputeRouteArc = computeRouteArc as jest.Mock;

/**
 * arc: [역A(idx=0, 탑승역), 역B(idx=1), 역C(idx=2)]
 * positionTrainResult가 이 arc 위에서 forward advance하는 시나리오만 사용.
 * boardingStationIdx=0 (탑승역=A) → 역B/C로 forward 가능.
 */
const { ARC_STATIONS, BOARDING_LOCK, routeContext } = makeArcFixture('tp-', 0);
const [ARC_STATION_A, ARC_STATION_B, ARC_STATION_C] = ARC_STATIONS;
const gpsBase = makeArcGpsBase;
const trainProgressFor = makeTrainProgressFor;

/**
 * 6 케이스 모두 동일 인자(routeContext + BOARDING_LOCK)로 useFusedNearestStation을 렌더 →
 * Sonar CPD. helper로 추출해 매 케이스 한 줄.
 */
function renderTrainProgressingHook(): ReturnType<
  typeof renderHook<ReturnType<typeof useFusedNearestStation>, unknown>
> {
  return renderHook(() =>
    useFusedNearestStation(
      undefined,
      undefined,
      routeContext,
      BOARDING_LOCK.trainCode,
      BOARDING_LOCK,
    ),
  );
}

describe('useFusedNearestStation — #1401 trainProgressing 신호', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseNearest.mockReturnValue(gpsBase());
    mockFindTop.mockReturnValue([{ station: ARC_STATION_A, distanceKm: 0.1 }]);
    mockFindLines.mockReturnValue(['2']);
    mockUseArrival.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockUsePositions.mockReturnValue({ positions: null, loading: false, isMock: false });
    mockPickCandidates.mockReturnValue([]);
    mockComputeRouteArc.mockReturnValue({ stations: ARC_STATIONS });
  });

  it('첫 tick(prev 없음)은 trainProgressing=false', () => {
    mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_A));

    const { result } = renderTrainProgressingHook();

    expect(result.current.trainProgressing).toBe(false);
  });

  it('같은 arcKey에서 idx 증가(A→B) → trainProgressing=true', () => {
    mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_A));
    // userLocation을 매 tick 다르게 줘 trainProgress useMemo deps 무효화.
    mockUseNearest.mockReturnValue({ ...gpsBase(), userLocation: { lat: 37.5, lng: 127 } });

    const { result, rerender } = renderTrainProgressingHook();

    // 첫 tick은 false (prev=A 저장 effect).
    expect(result.current.trainProgressing).toBe(false);
    expect(result.current.result?.station.id).toBe('tp-A');

    // 두번째 tick — 역B로 advance. userLocation 변경으로 useMemo 무효화.
    mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_B));
    mockUseNearest.mockReturnValue({ ...gpsBase(), userLocation: { lat: 37.5, lng: 127.05 } });
    act(() => {
      rerender({});
    });

    expect(result.current.result?.station.id).toBe('tp-B');
    expect(result.current.trainProgressing).toBe(true);
  });

  it('같은 idx 유지(A→A) → trainProgressing=false (forward-only)', () => {
    mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_A));

    const { result, rerender } = renderTrainProgressingHook();

    expect(result.current.trainProgressing).toBe(false);

    // 같은 역 재진입.
    act(() => {
      rerender({});
    });

    expect(result.current.trainProgressing).toBe(false);
  });

  it('idx 감소(B→A) → trainProgressing=false (forward-only, backward는 무시)', () => {
    // 첫 tick에서 idx=1(역B)로 시작.
    mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_B));

    const { result, rerender } = renderTrainProgressingHook();

    // 첫 tick → false (prev 없음).
    expect(result.current.trainProgressing).toBe(false);

    // backward jump(역A) — forward-only 가드(별도 #1015 fix)로 positionTrainResult=null.
    // 그 결과 result=null(또는 gps fallback) → arc idx -1 → trainProgressing=false.
    mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_A));
    act(() => {
      rerender({});
    });

    expect(result.current.trainProgressing).toBe(false);
  });

  it('arcStations 비어있으면 trainProgressing=false (trip 미활성)', () => {
    mockComputeRouteArc.mockReturnValue(null);
    mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_A));

    const { result } = renderTrainProgressingHook();

    expect(result.current.trainProgressing).toBe(false);
  });

  it('연속 advance(A→B→C) → 매 tick trainProgressing=true', () => {
    mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_A));
    mockUseNearest.mockReturnValue({ ...gpsBase(), userLocation: { lat: 37.5, lng: 127 } });

    const { result, rerender } = renderTrainProgressingHook();

    expect(result.current.trainProgressing).toBe(false);

    mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_B));
    mockUseNearest.mockReturnValue({ ...gpsBase(), userLocation: { lat: 37.5, lng: 127.05 } });
    act(() => {
      rerender({});
    });
    expect(result.current.trainProgressing).toBe(true);

    mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_C));
    mockUseNearest.mockReturnValue({ ...gpsBase(), userLocation: { lat: 37.5, lng: 127.1 } });
    act(() => {
      rerender({});
    });
    expect(result.current.trainProgressing).toBe(true);
  });
});

/**
 * arc: [역A(idx=0), 역B(idx=1, 탑승역), 역C(idx=2)]
 * boardingStation = 역B(idx=1) — forward-only 가드의 기준점.
 */
const {
  ARC_STATIONS: FWD_ARC_STATIONS,
  BOARDING_LOCK: FWD_BOARDING_LOCK,
  routeContext: fwdRouteContext,
} = makeArcFixture('fwd-', 1);
const [FWD_ARC_STATION_A, FWD_ARC_STATION_B, FWD_ARC_STATION_C] = FWD_ARC_STATIONS;

describe('useFusedNearestStation — #1015 forward-only 검증', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseNearest.mockReturnValue(gpsBase());
    mockFindTop.mockReturnValue([{ station: FWD_ARC_STATION_B, distanceKm: 0.1 }]);
    mockFindLines.mockReturnValue(['2']);
    mockUseArrival.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockUsePositions.mockReturnValue({ positions: null, loading: false, isMock: false });
    mockPickCandidates.mockReturnValue([]);
    mockComputeRouteArc.mockReturnValue({ stations: FWD_ARC_STATIONS });
  });

  describe('backward jump — positionTrainResult null → GPS fallback', () => {
    it.each([
      ['station이 탑승역(idx=1)보다 이전(idx=0) — backward', FWD_ARC_STATION_A],
    ])('%s', (_label, backwardStation) => {
      mockTrackProgress.mockReturnValue(trainProgressFor(backwardStation));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          fwdRouteContext,
          'T-2',
          FWD_BOARDING_LOCK,
        ),
      );

      // positionTrainResult가 null로 차단 → GPS fallback
      expect(result.current.source).toBe('gps');
      expect(result.current.confidence).toBe('gps-only');
    });
  });

  describe('forward/on-boarding — positionTrainResult 정상 채택', () => {
    it.each([
      ['station이 탑승역(idx=1)과 동일 — on-boarding index', FWD_ARC_STATION_B],
      ['station이 탑승역(idx=1)보다 앞(idx=2) — forward', FWD_ARC_STATION_C],
    ])('%s', (_label, forwardStation) => {
      mockTrackProgress.mockReturnValue(trainProgressFor(forwardStation));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          fwdRouteContext,
          'T-2',
          FWD_BOARDING_LOCK,
        ),
      );

      // positionTrainResult 채택 → boarding-lock (trainCode 매칭)
      expect(result.current.source).toBe('boarding-lock');
      expect(result.current.confidence).toBe('boarding-lock');
    });
  });

  describe('boardingLock 없으면 forward-only 가드 미적용', () => {
    it('boardingLock=null일 때 backward station도 position-train으로 채택됨', () => {
      mockTrackProgress.mockReturnValue(trainProgressFor(FWD_ARC_STATION_A));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          fwdRouteContext,
          null,
          null,
        ),
      );

      // lock 없으면 가드 미작동 → position-train 채택
      expect(result.current.source).toBe('position-train');
    });
  });

  describe('arcStations 비어있으면 forward-only 가드 미적용', () => {
    it('computeRouteArc=null(arc 없음)이면 positionTrainResult 정상 채택', () => {
      mockComputeRouteArc.mockReturnValue(null);
      mockTrackProgress.mockReturnValue(trainProgressFor(FWD_ARC_STATION_A));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          fwdRouteContext,
          'T-2',
          FWD_BOARDING_LOCK,
        ),
      );

      // arc 없으면 arcStations=[] → 가드 조건 미충족 → boarding-lock 채택
      expect(result.current.source).toBe('boarding-lock');
    });
  });

  describe('station이 arc 밖(stationIdx=-1)이면 forward-only 가드 통과', () => {
    it('arc에 없는 station은 backward 가드 대상 아님', () => {
      // MOCK_STATIONS.gangnam id('0201')는 ARC_STATIONS에 없어 arcIndexOfStation이 -1 반환.
      // gangnam.line='2'는 BOARDING_LOCK.boardingLine='2'와 일치 → #662 가드 통과.
      mockTrackProgress.mockReturnValue(trainProgressFor(MOCK_STATIONS.gangnam));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          fwdRouteContext,
          'T-2',
          FWD_BOARDING_LOCK,
        ),
      );

      // arc 밖(idx=-1)은 forward-only 가드 대상 아님 → boarding-lock 채택
      expect(['position-train', 'boarding-lock']).toContain(result.current.source);
    });
  });

  describe('boardingStationId가 arc에 없으면(boardingIdx=-1) forward-only 가드 미적용', () => {
    it('boardingStationId가 arcStations에 없으면 backward 역도 채택됨', () => {
      // boardingStationId='unknown-id' → arc에서 findIndex가 -1 → boardingIdx=-1 → 가드 스킵.
      const lockWithUnknownBoarding: BoardingLock = {
        ...FWD_BOARDING_LOCK,
        boardingStationId: 'unknown-id',
      };
      mockTrackProgress.mockReturnValue(trainProgressFor(FWD_ARC_STATION_A));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          fwdRouteContext,
          'T-2',
          lockWithUnknownBoarding,
        ),
      );

      // boardingIdx=-1 → 가드 조건 미충족 → position-train 또는 boarding-lock 채택
      expect(['position-train', 'boarding-lock']).toContain(result.current.source);
    });
  });
});
