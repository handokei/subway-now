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

  it('position-train + speed=0 + accuracy 정상이면 gps-only로 강등', () => {
    mockUseNearest.mockReturnValue(gpsBase(0, 50));

    const { result } = renderHook(() => useFusedNearestStation());

    expect(result.current.confidence).toBe('gps-only');
    expect(result.current.source).toBe('gps');
    // result도 GPS 원본(강남)으로 되돌아감 — fusion 채택했던 chungmuro 폐기
    expect(result.current.result?.station.name).toBe(MOCK_STATIONS.gangnam.name);
  });

  it('boarding-lock + speed=0.1 + accuracy 정상이면 gps-only로 강등', () => {
    mockUseNearest.mockReturnValue(gpsBase(0.1, 30));

    const { result } = renderHook(() =>
      useFusedNearestStation(undefined, undefined, undefined, 'T-1'),
    );

    expect(result.current.confidence).toBe('gps-only');
    expect(result.current.source).toBe('gps');
  });

  it('position-train + speed=2.0(이동 중)이면 강등 안 됨', () => {
    mockUseNearest.mockReturnValue(gpsBase(2, 50));

    const { result } = renderHook(() => useFusedNearestStation());

    expect(result.current.confidence).toBe('position-train');
    expect(result.current.source).toBe('position-train');
  });

  it('position-train + speed=0 + accuracy>100m(지하 noise)이면 강등 안 됨', () => {
    mockUseNearest.mockReturnValue(gpsBase(0, 1500));

    const { result } = renderHook(() => useFusedNearestStation());

    expect(result.current.confidence).toBe('position-train');
    expect(result.current.source).toBe('position-train');
  });
});
