/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: useFusedNearestStation orchestrator 테스트라 직접 import가 본질적.
 */
/**
 * #3191 PR-1 — Raw entry에 holdEligible(정지 fix 유지 술어 판정 결과)을 기록한다.
 * 관측 전용: 현재역 판정(result/source/confidence)은 이 값과 무관하게 동일해야 한다.
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
import {
  appendBarometerReading,
  resetBarometerInstrumentationForTest,
  resetBarometerState,
} from '../../../../shared/utils/barometerState';

const mockUseNearest = useNearestStation as jest.Mock;
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockUsePositions = useTrainPositions as jest.Mock;
const mockUseAccelPattern = useAccelerometerFingerprint as jest.Mock;
const mockPushRawSignal = pushRawSignal as jest.Mock;

function gpsWith(extra: Record<string, unknown>) {
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
    ...extra,
  };
}

type Dumped = { holdEligible?: boolean | null };

function collectWithBarometer(barometer?: Parameters<typeof useFusedNearestStation>[6]) {
  jest.useFakeTimers();
  const hook = renderHook(() =>
    useFusedNearestStation(undefined, undefined, undefined, undefined, undefined, undefined, barometer),
  );
  act(() => {
    jest.advanceTimersByTime(0);
  });
  jest.useRealTimers();
  const entries = mockPushRawSignal.mock.calls.map(([e]: [Dumped]) => e);
  return { hook, holds: entries.map((e) => e.holdEligible) };
}

const baro = { subsurface: false, signal: { subsurface: false, stop: undefined } };
const stillGood = { accuracyMeters: 8, speedMps: null };

describe('useFusedNearestStation — #3191 PR-1 holdEligible 기록 (동작 불변)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetBarometerState();
    resetBarometerInstrumentationForTest();
    mockUseAccelPattern.mockReturnValue('unknown');
    mockUseArrival.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockUsePositions.mockReturnValue({ positions: null, loading: false, isMock: false });
  });

  it('정지 품질 fix + 이동 증거 없음 + 기압계 입력 있음 -> true', () => {
    mockUseNearest.mockReturnValue(gpsWith({ ...stillGood, lastFixAtMs: Date.now() - 20_000 }));
    const { holds } = collectWithBarometer(baro);
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every((h) => h === true)).toBe(true);
  });

  it('기압계 입력 없음(barometer 미전달) -> false', () => {
    mockUseNearest.mockReturnValue(gpsWith({ ...stillGood, lastFixAtMs: Date.now() - 20_000 }));
    const { holds } = collectWithBarometer(undefined);
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every((h) => h === false)).toBe(true);
  });

  it('기압계 unavailableReason 있음 -> false', () => {
    mockUseNearest.mockReturnValue(gpsWith({ ...stillGood, lastFixAtMs: Date.now() - 20_000 }));
    const { holds } = collectWithBarometer({
      subsurface: false,
      signal: { subsurface: false, stop: undefined, unavailableReason: 'sensor' },
    });
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every((h) => h === false)).toBe(true);
  });

  it('subsurface=true -> false', () => {
    mockUseNearest.mockReturnValue(gpsWith({ ...stillGood, lastFixAtMs: Date.now() - 20_000 }));
    const { holds } = collectWithBarometer({ subsurface: true, signal: baro.signal });
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every((h) => h === false)).toBe(true);
  });

  it('정확도 나쁨(44m) -> false', () => {
    mockUseNearest.mockReturnValue(
      gpsWith({ accuracyMeters: 44, speedMps: null, lastFixAtMs: Date.now() - 20_000 }),
    );
    const { holds } = collectWithBarometer(baro);
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every((h) => h === false)).toBe(true);
  });

  it('속도 13.9 m/s -> false', () => {
    mockUseNearest.mockReturnValue(
      gpsWith({ accuracyMeters: 8, speedMps: 13.9, lastFixAtMs: Date.now() - 20_000 }),
    );
    const { holds } = collectWithBarometer(baro);
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every((h) => h === false)).toBe(true);
  });

  it('fix 시각을 알 수 없으면 null (판단 불가)', () => {
    mockUseNearest.mockReturnValue(gpsWith({ ...stillGood, lastFixAtMs: null }));
    const { holds } = collectWithBarometer(baro);
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every((h) => h === null)).toBe(true);
  });

  it('최근 기압 ΔP 이벤트가 있으면 false', () => {
    mockUseNearest.mockReturnValue(gpsWith({ ...stillGood, lastFixAtMs: Date.now() - 20_000 }));
    const t = Date.now();
    appendBarometerReading({ t: t - 10_000, pressureHpa: 1013.0 });
    appendBarometerReading({ t, pressureHpa: 1013.5 });
    const { holds } = collectWithBarometer(baro);
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every((h) => h === false)).toBe(true);
  });

  it('동작 불변 - holdEligible 입력이 달라도 현재역 판정은 동일', () => {
    mockUseNearest.mockReturnValue(gpsWith({ ...stillGood, lastFixAtMs: Date.now() - 20_000 }));
    const a = collectWithBarometer(baro).hook.result.current;
    jest.clearAllMocks();
    mockUseNearest.mockReturnValue(
      gpsWith({ accuracyMeters: 44, speedMps: 13.9, lastFixAtMs: Date.now() - 20_000 }),
    );
    const b = collectWithBarometer(baro).hook.result.current;
    expect(b.result?.station.id).toBe(a.result?.station.id);
    expect(b.source).toBe(a.source);
    expect(b.confidence).toBe(a.confidence);
  });
});
