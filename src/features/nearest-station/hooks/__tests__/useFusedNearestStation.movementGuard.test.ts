/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #727 정적 misfire 가드의 *작동 분기*를 격리 검증.
 *
 * trackTrainProgress / fusionDistanceGate는 stations.json 실좌표를 보거나 distanceKm 조건이
 * 복잡해 본 가드만 cover하기 어렵다. 여기선 fusionDistanceGate를 항상 통과 mock하고
 * trackTrainProgress 결과를 직접 mock해 fusion이 position-train으로 채택되는 상태에서
 * speed=0이면 gps-only로 강등되는지만 본다.
 */
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../utils/findNearestStation');
jest.mock('../../../route/utils/findActiveLines');
jest.mock('../../utils/fusionDistanceGate', () => ({
  passesFusionDistanceGate: () => true,
}));
jest.mock('../../../route/utils/trackTrainProgress', () => ({
  trackTrainProgress: jest.fn(),
}));
jest.mock('../../../arrival/utils/pickCandidateTrains', () => ({
  pickCandidateTrains: jest.fn(),
}));
jest.mock('../../../route/utils/stationProgressEstimator', () => ({
  arcIndexOfStation: () => -1,
  estimateStationProgress: () => null,
}));
jest.mock('../../../route/utils/routeProgress', () => ({
  computeRouteArc: () => null,
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
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';

const mockUseNearest = useNearestStation as jest.Mock;
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockUsePositions = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockFindLines = findActiveLines as jest.Mock;
const mockTrackProgress = trackTrainProgress as jest.Mock;
const mockPickCandidates = pickCandidateTrains as jest.Mock;

function gpsBase(speedMps: number | null, accuracyMeters: number | null) {
  return {
    result: { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
    variants: [MOCK_STATIONS.gangnam],
    userLocation: { lat: 37.5, lng: 127 },
    speedMps,
    accuracyMeters,
    loading: false,
    error: null,
    permissionDenied: false,
    locationUncertain: false,
    refresh: jest.fn(),
  };
}

describe('useFusedNearestStation — #727 fusion downgrade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.chungmuro, distanceKm: 0.5 }]);
    mockFindLines.mockReturnValue(['3']);
    mockUseArrival.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockUsePositions.mockReturnValue({ positions: null, loading: false, isMock: false });
    // pickCandidateTrains 1개 후보 — trackTrainProgress 진입
    mockPickCandidates.mockReturnValue([
      { line: '3', trainNo: 'T-1', station: MOCK_STATIONS.chungmuro, distanceKm: 0 },
    ]);
    // trackTrainProgress가 chungmuro를 position-train 채택
    mockTrackProgress.mockReturnValue({
      trainNo: 'T-1',
      currentStation: MOCK_STATIONS.chungmuro,
      distanceKm: 0,
      lastConfirmedAtMs: Date.now(),
    });
  });

  // #1363 — consensus 게이트(≥2 정적 신호). speed 단독으로는 더 이상 강등하지 않는다.
  // useFusedNearestStation positional 인자(6): motionStationary. 6번째 인자로 합의 신호 추가.
  // 강등 동작은 confidence/source 한 쌍 결과만 본다. result 검증(gangnam으로 복원)은 첫 케이스만.
  it.each([
    // speed=0 + motion=true → 2 신호 합의 → 강등
    ['speed=0 + motion=true 합의 → 강등', 0, 50, null, true, 'gps-only', 'gps'],
    // speed=0.1 + motion=true + boarding-lock → 2 신호 합의 → 강등
    ['speed=0.1 + motion=true + boarding-lock → 강등', 0.1, 30, 'T-1', true, 'gps-only', 'gps'],
    // speed=2 이동 중 → 유지(정적 신호 0)
    ['speed=2 이동 중 → 유지', 2, 50, null, false, 'position-train', 'position-train'],
    // speed=0 단독(motion=undefined) → 1 신호 → 유지 (#1363 회귀 차단)
    ['speed=0 단독(motion 미보고) → 유지 (consensus 미달)', 0, 50, null, undefined, 'position-train', 'position-train'],
    // speed=0 + accuracy>100m 지하 noise → 유지(accuracy 가드)
    ['speed=0 + motion=true + accuracy>100m → 유지', 0, 1500, null, true, 'position-train', 'position-train'],
  ])(
    '%s',
    (
      _label,
      speed: number,
      accuracy: number,
      lockedTrainCode: string | null,
      motionStationary: boolean | undefined,
      expectedConfidence: string,
      expectedSource: string,
    ) => {
      mockUseNearest.mockReturnValue(gpsBase(speed, accuracy));

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          lockedTrainCode,
          null,
          motionStationary,
        ),
      );

      expect(result.current.confidence).toBe(expectedConfidence);
      expect(result.current.source).toBe(expectedSource);
    },
  );

  it('강등 시 result도 GPS 원본(강남)으로 복원', () => {
    mockUseNearest.mockReturnValue(gpsBase(0, 50));

    const { result } = renderHook(() =>
      useFusedNearestStation(undefined, undefined, undefined, null, null, true),
    );

    expect(result.current.result?.station.name).toBe(MOCK_STATIONS.gangnam.name);
  });

  // #728/#1363 — motionStationary + 추가 정적 신호 합의로 speed=null 경로의 강등.
  describe('#728/#1363 motionStationary consensus downgrade', () => {
    it('speed=null + motionStationary=true 단독은 강등 안 함 (#1363 consensus)', () => {
      mockUseNearest.mockReturnValue(gpsBase(null, 50));
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null, null, true),
      );
      expect(result.current.confidence).toBe('position-train');
    });

    it('speed=null + motionStationary=false → 유지', () => {
      mockUseNearest.mockReturnValue(gpsBase(null, 50));
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null, null, false),
      );
      expect(result.current.confidence).toBe('position-train');
    });

    it('speed=null + motionStationary=true + accuracy noise(>100m) → 유지 (지하 GPS 보호)', () => {
      mockUseNearest.mockReturnValue(gpsBase(null, 1500));
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null, null, true),
      );
      expect(result.current.confidence).toBe('position-train');
    });
  });
});
