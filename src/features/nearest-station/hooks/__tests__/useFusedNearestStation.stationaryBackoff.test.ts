/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #2418 (perf) — 정지+유휴 fusion backoff 회귀 가드.
 *
 * 정지(motionStationary===true OR gps speed < STATIC_SPEED_THRESHOLD_MPS) && lockless(lock 없음)
 * && route 없음(trip 비활성)일 때 candidate enumeration(findTopNearestStations)과
 * train-position poll(useTrainPositions 대상 line)이 skip되는지, 그리고 움직임 재개 /
 * lock·route 활성 시 backoff가 절대 적용되지 않는지를 검증한다.
 */
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../useAccelerometerFingerprint', () => ({
  useAccelerometerFingerprint: jest.fn(() => 'automotive'),
}));
jest.mock('../useCellularTech', () => ({
  useCellularTech: jest.fn(() => 'surface'),
}));
jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../../../observability/utils/rawSignalBuffer', () => ({
  pushRawSignal: jest.fn(),
}));
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: jest.fn(() => null),
}));

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const mockUseNearest = useNearestStation as jest.Mock;
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockUsePositions = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

function gpsBase(speedMps: number | null, userLocation = { lat: 37.5, lng: 127.0 }) {
  const live = { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 };
  return {
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [MOCK_STATIONS.gangnam],
    userLocation,
    speedMps,
    accuracyMeters: 50,
    loading: false,
    error: null,
    permissionDenied: false,
    locationUncertain: false,
    refresh: jest.fn(),
  };
}

const lockFixture: BoardingLock = {
  destinationId: 'dest-2',
  trainCode: 'T-1',
  boardingLine: '2',
  boardingStationId: MOCK_STATIONS.gangnam.id,
  boardedAt: Date.now(),
  expectedDurationMs: 10 * 60_000,
};

describe('useFusedNearestStation — #2418 정지 backoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);
    mockUseArrival.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockUsePositions.mockReturnValue({ positions: null, loading: false, isMock: false });
  });

  it('정지(speed=0) + lockless + route 없음 → candidate enumeration/train-position poll skip', () => {
    mockUseNearest.mockReturnValue(gpsBase(2));
    const { rerender } = renderHook(
      ({ speed }: { speed: number }) =>
        useFusedNearestStation(undefined, undefined, undefined, null, null, undefined),
      { initialProps: { speed: 2 } },
    );
    expect(mockFindTop).toHaveBeenCalledTimes(1);

    // 정지 상태로 전환 — userLocation 참조도 매 tick 바뀐다고 가정(GPS jitter)해도 skip 유지.
    mockUseNearest.mockReturnValue(gpsBase(0, { lat: 37.50001, lng: 127.00001 }));
    rerender({ speed: 0 });
    rerender({ speed: 0 });

    // backoff 활성 이후엔 findTopNearestStations가 더 이상 호출되지 않아야 한다(직전 결과 재사용).
    expect(mockFindTop).toHaveBeenCalledTimes(1);

    // useTrainPositions 최근 호출들은 line=null(폴링 비활성)이어야 한다.
    const recentPositionCalls = mockUsePositions.mock.calls.slice(-3);
    for (const call of recentPositionCalls) {
      expect(call[0]).toBeNull();
    }
  });

  it('motionStationary===true 단독으로도 backoff 적용 (speed=null)', () => {
    mockUseNearest.mockReturnValue(gpsBase(null));
    const { rerender } = renderHook(
      ({ motion }: { motion: boolean | undefined }) =>
        useFusedNearestStation(undefined, undefined, undefined, null, null, motion),
      { initialProps: { motion: false } },
    );
    expect(mockFindTop).toHaveBeenCalledTimes(1);

    rerender({ motion: true });
    rerender({ motion: true });

    expect(mockFindTop).toHaveBeenCalledTimes(1);
    const recentPositionCalls = mockUsePositions.mock.calls.slice(-3);
    for (const call of recentPositionCalls) {
      expect(call[0]).toBeNull();
    }
  });

  it('이동 재개(speed 상승) 시 다음 렌더에서 즉시 정상 주기로 복귀', () => {
    // 1) 이동 중 — 정상 baseline.
    mockUseNearest.mockReturnValue(gpsBase(2));
    const { rerender } = renderHook(
      ({ speed }: { speed: number }) =>
        useFusedNearestStation(undefined, undefined, undefined, null, null, undefined),
      { initialProps: { speed: 2 } },
    );
    expect(mockFindTop).toHaveBeenCalledTimes(1);

    // 2) 정지 전환 — backoff 활성, 재계산 skip (userLocation 참조가 바뀌어도).
    mockUseNearest.mockReturnValue(gpsBase(0, { lat: 37.50002, lng: 127.00002 }));
    rerender({ speed: 0 });
    expect(mockFindTop).toHaveBeenCalledTimes(1);

    // 3) 이동 재개 — 지연 없이 즉시 재계산 + train-position poll 재개.
    mockUseNearest.mockReturnValue(gpsBase(5, { lat: 37.50003, lng: 127.00003 }));
    rerender({ speed: 5 });
    expect(mockFindTop).toHaveBeenCalledTimes(2);

    const recentPositionCalls = mockUsePositions.mock.calls.slice(-3);
    expect(recentPositionCalls.some((call) => call[0] === MOCK_STATIONS.gangnam.line)).toBe(true);
  });

  it('boardingLock 활성 trip은 정지 상태여도 backoff 미적용(정확도 우선)', () => {
    mockUseNearest.mockReturnValue(gpsBase(0));
    const { rerender } = renderHook(
      () => useFusedNearestStation(undefined, undefined, undefined, null, lockFixture, true),
      { initialProps: {} },
    );
    expect(mockFindTop).toHaveBeenCalledTimes(1);

    // userLocation을 매 렌더 바꿔 lock 활성 중엔 backoff 없이 매번 재계산됨을 확인.
    mockUseNearest.mockReturnValue(gpsBase(0, { lat: 37.50004, lng: 127.00004 }));
    rerender({});
    mockUseNearest.mockReturnValue(gpsBase(0, { lat: 37.50005, lng: 127.00005 }));
    rerender({});

    // lock 활성이면 매 렌더 재계산 — backoff 미적용.
    expect(mockFindTop).toHaveBeenCalledTimes(3);
    const recentPositionCalls = mockUsePositions.mock.calls.slice(-3);
    expect(recentPositionCalls.some((call) => call[0] === MOCK_STATIONS.gangnam.line)).toBe(true);
  });

  it('이동 중(speed=2)에는 매 렌더 정상 재계산 — backoff 미적용', () => {
    mockUseNearest.mockReturnValue(gpsBase(2));
    const { rerender } = renderHook(
      () => useFusedNearestStation(undefined, undefined, undefined, null, null, false),
      { initialProps: {} },
    );
    expect(mockFindTop).toHaveBeenCalledTimes(1);

    mockUseNearest.mockReturnValue(gpsBase(3, { lat: 37.50006, lng: 127.00006 }));
    rerender({});
    mockUseNearest.mockReturnValue(gpsBase(3, { lat: 37.50007, lng: 127.00007 }));
    rerender({});

    expect(mockFindTop).toHaveBeenCalledTimes(3);
    const recentPositionCalls = mockUsePositions.mock.calls.slice(-3);
    expect(recentPositionCalls.some((call) => call[0] === MOCK_STATIONS.gangnam.line)).toBe(true);
  });
});
