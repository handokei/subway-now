/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리.
 */
/**
 * #1678 — accelerometerPattern raw signal dump 브랜치 커버리지.
 *
 * useFusedNearestStation 내부 motionForDump 계산:
 *   - accelerometerPattern !== 'unknown' → 그대로 채택 (신규 브랜치)
 *   - accelerometerPattern === 'unknown' + motionStationary=true → 'stationary' fallback (기존)
 *
 * useAccelerometerFingerprint를 'automotive' / 'walking' / 'stationary'로 mock해
 * 신규 브랜치를 실행한다.
 */
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(() => []),
}));
jest.mock('../../../route/utils/findActiveLines', () => ({
  findActiveLines: jest.fn(() => []),
}));
jest.mock('../../../observability/utils/rawSignalBuffer', () => ({
  pushRawSignal: jest.fn(),
}));
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: jest.fn(() => null),
}));
jest.mock('../useAccelerometerFingerprint');

import { renderHook, act } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { pushRawSignal } from '../../../observability/utils/rawSignalBuffer';
import { useAccelerometerFingerprint } from '../useAccelerometerFingerprint';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import type { AccelerometerPattern } from '../../utils/accelerometerFingerprint';
import { appendBarometerReading, resetBarometerState } from '../../../../shared/utils/barometerState';

const mockUseNearest = useNearestStation as jest.Mock;
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockUsePositions = useTrainPositions as jest.Mock;
const mockUseAccelPattern = useAccelerometerFingerprint as jest.Mock;
const mockPushRawSignal = pushRawSignal as jest.Mock;

function gangnamGps() {
  const station = { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 };
  return {
    result: station,
    liveResult: station,
    stickyDisplayOnly: null,
    variants: [MOCK_STATIONS.gangnam],
    userLocation: { lat: 37.5, lng: 127.0 },
    speedMps: 3,
    accuracyMeters: 50,
    loading: false,
    error: null,
    permissionDenied: false,
    locationUncertain: false,
    gpsActive: 'fg' as const,
    lastFixAtMs: Date.now(),
    refresh: jest.fn(),
  };
}

function chungmuroGps() {
  const station = { station: MOCK_STATIONS.chungmuro, distanceKm: 0.05 };
  return {
    ...gangnamGps(),
    result: station,
    liveResult: station,
    variants: [MOCK_STATIONS.chungmuro],
  };
}

describe('useFusedNearestStation — #1678 accelPattern 반환값 및 motionForDump', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseNearest.mockReturnValue(gangnamGps());
    mockUseArrival.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockUsePositions.mockReturnValue({ positions: null, loading: false, isMock: false });
  });

  it.each<AccelerometerPattern>(['automotive', 'walking', 'stationary'])(
    'accelerometerPattern=%s가 hook 반환값에 포함된다',
    (pattern) => {
      mockUseAccelPattern.mockReturnValue(pattern);

      const { result } = renderHook(() => useFusedNearestStation());

      expect(result.current.accelerometerPattern).toBe(pattern);
    },
  );

  it('accelerometerPattern=unknown이면 hook 반환값도 unknown', () => {
    mockUseAccelPattern.mockReturnValue('unknown');

    const { result } = renderHook(() => useFusedNearestStation());

    expect(result.current.accelerometerPattern).toBe('unknown');
  });

  it.each<[AccelerometerPattern, string]>([
    ['automotive', 'automotive'],
    ['walking', 'walking'],
    ['stationary', 'stationary'],
  ])(
    'accelerometerPattern=%s → pushRawSignal motion=%s (unknown 아닐 때 우선 채택)',
    (pattern, expectedMotion) => {
      mockUseAccelPattern.mockReturnValue(pattern);
      jest.useFakeTimers();

      const { rerender } = renderHook(() => useFusedNearestStation());
      act(() => { jest.advanceTimersByTime(0); });

      // station 변경으로 decisionKey 전환 → useEffect 재실행 → pushRawSignal 호출
      mockUseNearest.mockReturnValue(chungmuroGps());
      rerender({});
      act(() => { jest.advanceTimersByTime(0); });

      jest.useRealTimers();

      const allMotions = mockPushRawSignal.mock.calls.map(
        ([entry]: [{ motion: string | null }]) => entry.motion,
      );
      expect(allMotions.some((m) => m === expectedMotion)).toBe(true);
    },
  );

  it('accelerometerPattern=unknown + motionStationary=true → pushRawSignal motion=stationary fallback', () => {
    mockUseAccelPattern.mockReturnValue('unknown');
    jest.useFakeTimers();

    const { rerender } = renderHook(() =>
      useFusedNearestStation(undefined, undefined, undefined, null, null, true),
    );
    act(() => { jest.advanceTimersByTime(0); });

    mockUseNearest.mockReturnValue(chungmuroGps());
    rerender({});
    act(() => { jest.advanceTimersByTime(0); });

    jest.useRealTimers();

    const allMotions = mockPushRawSignal.mock.calls.map(
      ([entry]: [{ motion: string | null }]) => entry.motion,
    );
    expect(allMotions.some((m) => m === 'stationary')).toBe(true);
  });

  // #2241 (ADR-030 §Replay harness backbone P0-1) — barometerHpaForDump: getBarometerReadings()
  // 최신 reading의 pressureHpa를 rawSignalBuffer entry에 싣는다. readings 0건이면 null(다른
  // 테스트가 이미 이 경로를 커버), 본 테스트는 readings.length > 0 분기를 커버한다.
  it('barometer readings 존재 → pushRawSignal entry.barometerHpa = 최신 reading.pressureHpa', () => {
    resetBarometerState();
    appendBarometerReading({ t: Date.now(), pressureHpa: 1013.25 });
    mockUseAccelPattern.mockReturnValue('unknown');
    jest.useFakeTimers();

    const { rerender } = renderHook(() => useFusedNearestStation());
    act(() => { jest.advanceTimersByTime(0); });

    mockUseNearest.mockReturnValue(chungmuroGps());
    rerender({});
    act(() => { jest.advanceTimersByTime(0); });

    jest.useRealTimers();

    const allHpa = mockPushRawSignal.mock.calls.map(
      ([entry]: [{ barometerHpa: number | null }]) => entry.barometerHpa,
    );
    expect(allHpa.some((hpa) => hpa === 1013.25)).toBe(true);
    resetBarometerState();
  });
});
