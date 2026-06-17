/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #1015 fusion forward-only 검증.
 *
 * boardingLock + arc(arcStations) 활성 시 positionTrainResult의 station이
 * boarding index보다 backward(이전)면 null 반환 → fusion이 GPS fallback으로 내려가는지 검증.
 *
 * fusionDistanceGate / isWithinArcWindow를 항상 통과 mock하고 pickFusedStation / trackTrainProgress를
 * mock해 backward/forward 역 시나리오만 격리한다.
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
  // arcIndexOfStation 실제 구현 사용 — station.id 비교로 backward/forward 검증.
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

import { renderHook } from '@testing-library/react-native';
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
 * arc: [역A(idx=0), 역B(idx=1, 탑승역), 역C(idx=2)]
 * boardingStation = 역B(idx=1) — forward-only 가드의 기준점.
 */
const { ARC_STATIONS, BOARDING_LOCK, routeContext } = makeArcFixture('fwd-', 1);
const [ARC_STATION_A, ARC_STATION_B, ARC_STATION_C] = ARC_STATIONS;
const gpsBase = makeArcGpsBase;
const trainProgressFor = makeTrainProgressFor;

describe('useFusedNearestStation — #1015 forward-only 검증', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseNearest.mockReturnValue(gpsBase());
    mockFindTop.mockReturnValue([{ station: ARC_STATION_B, distanceKm: 0.1 }]);
    mockFindLines.mockReturnValue(['2']);
    mockUseArrival.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockUsePositions.mockReturnValue({ positions: null, loading: false, isMock: false });
    mockPickCandidates.mockReturnValue([]);
    mockComputeRouteArc.mockReturnValue({ stations: ARC_STATIONS });
  });

  describe('backward jump — positionTrainResult null → GPS fallback', () => {
    it.each([
      ['station이 탑승역(idx=1)보다 이전(idx=0) — backward', ARC_STATION_A],
    ])('%s', (_label, backwardStation) => {
      mockTrackProgress.mockReturnValue(trainProgressFor(backwardStation));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          routeContext,
          'T-2',
          BOARDING_LOCK,
        ),
      );

      // positionTrainResult가 null로 차단 → GPS fallback
      expect(result.current.source).toBe('gps');
      expect(result.current.confidence).toBe('gps-only');
    });
  });

  describe('forward/on-boarding — positionTrainResult 정상 채택', () => {
    it.each([
      ['station이 탑승역(idx=1)과 동일 — on-boarding index', ARC_STATION_B],
      ['station이 탑승역(idx=1)보다 앞(idx=2) — forward', ARC_STATION_C],
    ])('%s', (_label, forwardStation) => {
      mockTrackProgress.mockReturnValue(trainProgressFor(forwardStation));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          routeContext,
          'T-2',
          BOARDING_LOCK,
        ),
      );

      // positionTrainResult 채택 → boarding-lock (trainCode 매칭)
      expect(result.current.source).toBe('boarding-lock');
      expect(result.current.confidence).toBe('boarding-lock');
    });
  });

  describe('boardingLock 없으면 forward-only 가드 미적용', () => {
    it('boardingLock=null일 때 backward station도 position-train으로 채택됨', () => {
      mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_A));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          routeContext,
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
      mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_A));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          routeContext,
          'T-2',
          BOARDING_LOCK,
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
          routeContext,
          'T-2',
          BOARDING_LOCK,
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
        ...BOARDING_LOCK,
        boardingStationId: 'unknown-id',
      };
      mockTrackProgress.mockReturnValue(trainProgressFor(ARC_STATION_A));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          routeContext,
          'T-2',
          lockWithUnknownBoarding,
        ),
      );

      // boardingIdx=-1 → 가드 조건 미충족 → position-train 또는 boarding-lock 채택
      expect(['position-train', 'boarding-lock']).toContain(result.current.source);
    });
  });
});
