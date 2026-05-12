import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../useArrivalInfo';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { ARRIVAL_CODE } from '../../constants/arrivalCodes';
import { MOCK_STATIONS } from '../../testUtils/fixtures';
import type { StationArrival, ArrivalInfo } from '../../api/arrivalApi';

jest.mock('../useNearestStation');
jest.mock('../useArrivalInfo');
jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));

const mockUseNearest = useNearestStation as jest.Mock;
const mockUseArrival = useArrivalInfo as jest.Mock;
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
    ...overrides,
  };
}

function arrivalRet(stationArrival: StationArrival | null = null) {
  return { arrival: stationArrival, loading: false, isMock: false };
}

describe('useFusedNearestStation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseArrival.mockReturnValue(arrivalRet(null));
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

  it('GPS pass-through 필드들(loading/error/permissionDenied/refresh 등)이 보존된다', () => {
    const refresh = jest.fn();
    mockUseNearest.mockReturnValue(
      gpsBase({ loading: true, error: 'GPS err', permissionDenied: true, refresh }),
    );
    mockFindTop.mockReturnValue([]);

    const { result } = renderHook(() => useFusedNearestStation());

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe('GPS err');
    expect(result.current.permissionDenied).toBe(true);
    expect(result.current.refresh).toBe(refresh);
    expect(result.current.variants).toEqual([MOCK_STATIONS.gangnam]);
    expect(result.current.userLocation).toEqual({ lat: 37.5, lng: 127.0 });
    expect(result.current.speedMps).toBe(1);
    expect(result.current.accuracyMeters).toBe(50);
  });
});
