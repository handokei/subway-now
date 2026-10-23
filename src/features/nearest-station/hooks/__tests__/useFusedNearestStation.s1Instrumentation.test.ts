/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: useFusedNearestStation orchestrator 테스트라 직접 import가 본질적.
 */
/**
 * #3191 PR-0 — Raw signal에 watch 상태 / appState / 기압 ΔP 이벤트 시각을 싣는다.
 * 관측 전용: 현재역 판정(result/source/confidence)은 이 필드 값과 무관하게 동일해야 한다.
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

import { AppState } from 'react-native';
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

type Dumped = {
  watch?: string | null;
  appState?: string | null;
  baroEventAtMs?: number | null;
};

function renderAndCollect() {
  jest.useFakeTimers();
  const hook = renderHook(() => useFusedNearestStation());
  act(() => {
    jest.advanceTimersByTime(0);
  });
  jest.useRealTimers();
  return {
    hook,
    entries: mockPushRawSignal.mock.calls.map(([e]: [Dumped]) => e),
  };
}

describe('useFusedNearestStation — #3191 PR-0 Raw 계측 필드', () => {
  const originalAppState = AppState.currentState;

  beforeEach(() => {
    jest.clearAllMocks();
    resetBarometerState();
    resetBarometerInstrumentationForTest();
    mockUseAccelPattern.mockReturnValue('unknown');
    mockUseArrival.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockUsePositions.mockReturnValue({ positions: null, loading: false, isMock: false });
  });

  afterEach(() => {
    Object.defineProperty(AppState, 'currentState', { value: originalAppState, configurable: true });
  });

  it('FG watch 구독 중이면 watch=active', () => {
    mockUseNearest.mockReturnValue(gpsWith({ isWatchActive: () => true }));
    const { entries } = renderAndCollect();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.watch === 'active')).toBe(true);
  });

  it('구독이 없으면 watch=inactive', () => {
    mockUseNearest.mockReturnValue(gpsWith({ isWatchActive: () => false }));
    const { entries } = renderAndCollect();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.watch === 'inactive')).toBe(true);
  });

  it('watch 상태를 알 수 없으면(훅이 제공 안 함) watch=null', () => {
    mockUseNearest.mockReturnValue(gpsWith({}));
    const { entries } = renderAndCollect();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.watch === null)).toBe(true);
  });

  it('appState는 AppState.currentState 그대로 기록', () => {
    Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
    mockUseNearest.mockReturnValue(gpsWith({}));
    const { entries } = renderAndCollect();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.appState === 'background')).toBe(true);
  });

  it('ΔP 이벤트가 있으면 baroEventAtMs에 그 시각, 없으면 null', () => {
    mockUseNearest.mockReturnValue(gpsWith({}));
    const none = renderAndCollect();
    expect(none.entries.length).toBeGreaterThan(0);
    expect(none.entries.every((e) => e.baroEventAtMs === null)).toBe(true);

    jest.clearAllMocks();
    const t = Date.now();
    appendBarometerReading({ t: t - 10_000, pressureHpa: 1013.0 });
    appendBarometerReading({ t, pressureHpa: 1013.5 });
    const some = renderAndCollect();
    expect(some.entries.length).toBeGreaterThan(0);
    expect(some.entries.every((e) => e.baroEventAtMs === t)).toBe(true);
  });

  it('동작 불변 — 계측 입력(watch/appState/ΔP)이 달라도 현재역 판정 결과는 동일', () => {
    mockUseNearest.mockReturnValue(gpsWith({ isWatchActive: () => true }));
    const a = renderAndCollect().hook.result.current;

    jest.clearAllMocks();
    Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
    const t = Date.now();
    appendBarometerReading({ t: t - 10_000, pressureHpa: 1013.0 });
    appendBarometerReading({ t, pressureHpa: 1013.5 });
    mockUseNearest.mockReturnValue(gpsWith({ isWatchActive: () => false }));
    const b = renderAndCollect().hook.result.current;

    expect(b.result?.station.id).toBe(a.result?.station.id);
    expect(b.source).toBe(a.source);
    expect(b.confidence).toBe(a.confidence);
  });
});
