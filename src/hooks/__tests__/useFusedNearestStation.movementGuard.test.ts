/**
 * #727 정적 misfire 가드의 *작동 분기*를 격리 검증.
 *
 * trackTrainProgress / fusionDistanceGate는 stations.json 실좌표를 보거나 distanceKm 조건이
 * 복잡해 본 가드만 cover하기 어렵다. 여기선 fusionDistanceGate를 항상 통과 mock하고
 * trackTrainProgress 결과를 직접 mock해 fusion이 position-train으로 채택되는 상태에서
 * speed=0이면 gps-only로 강등되는지만 본다.
 */
jest.mock('../useNearestStation');
jest.mock('../useArrivalInfo');
jest.mock('../useTrainPositions');
jest.mock('../../utils/findNearestStation');
jest.mock('../../utils/findActiveLines');
jest.mock('../../utils/fusionDistanceGate', () => ({
  passesFusionDistanceGate: () => true,
}));
jest.mock('../../utils/trackTrainProgress', () => ({
  trackTrainProgress: jest.fn(),
}));
jest.mock('../../utils/pickCandidateTrains', () => ({
  pickCandidateTrains: jest.fn(),
}));
jest.mock('../../utils/boardingLockInterpolation', () => ({
  arcIndexOfStation: () => -1,
  interpolateBoardingLockStation: () => null,
}));
jest.mock('../../utils/routeProgress', () => ({
  computeRouteArc: () => null,
}));

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../useArrivalInfo';
import { useTrainPositions } from '../useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findActiveLines } from '../../utils/findActiveLines';
import { trackTrainProgress } from '../../utils/trackTrainProgress';
import { pickCandidateTrains } from '../../utils/pickCandidateTrains';
import { MOCK_STATIONS } from '../../testUtils/fixtures';

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

  // 강등 동작은 confidence/source 한 쌍 결과만 본다. result 검증(gangnam으로 복원)은 첫 케이스만.
  it.each([
    ['speed=0 + accuracy 정상 → 강등', 0, 50, null, 'gps-only', 'gps'],
    ['speed=0.1 + accuracy 정상 + boarding-lock → 강등', 0.1, 30, 'T-1', 'gps-only', 'gps'],
    ['speed=2 이동 중 → 유지', 2, 50, null, 'position-train', 'position-train'],
    ['speed=0 + accuracy>100m 지하 noise → 유지', 0, 1500, null, 'position-train', 'position-train'],
  ])(
    '%s',
    (
      _label,
      speed: number,
      accuracy: number,
      lockedTrainCode: string | null,
      expectedConfidence: string,
      expectedSource: string,
    ) => {
      mockUseNearest.mockReturnValue(gpsBase(speed, accuracy));

      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, lockedTrainCode),
      );

      expect(result.current.confidence).toBe(expectedConfidence);
      expect(result.current.source).toBe(expectedSource);
    },
  );

  it('강등 시 result도 GPS 원본(강남)으로 복원', () => {
    mockUseNearest.mockReturnValue(gpsBase(0, 50));

    const { result } = renderHook(() => useFusedNearestStation());

    expect(result.current.result?.station.name).toBe(MOCK_STATIONS.gangnam.name);
  });

  // #728 — motionStationary 신호로 speed=null 경로의 강등.
  // useFusedNearestStation 6번째 positional 인자: motionStationary.
  describe('#728 motionStationary downgrade', () => {
    it('speed=null + motionStationary=true → 강등 (positionStability 없이)', () => {
      mockUseNearest.mockReturnValue(gpsBase(null, 50));
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, null, null, true),
      );
      expect(result.current.confidence).toBe('gps-only');
      expect(result.current.source).toBe('gps');
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
