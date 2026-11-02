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
  baroLastAt?: number | null;
  baroFirstAt?: number | null;
  baroObs?: boolean | null;
  baroEvtKind?: string | null;
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

// #3191 PR-0 — 기압계 관측 필드(B 원인 확정용). 관측 전용: 판정 입력 아님.
describe('useFusedNearestStation — #3191 PR-0 Raw 기압 관측 필드', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetBarometerState();
    resetBarometerInstrumentationForTest();
    mockUseAccelPattern.mockReturnValue('unknown');
    mockUseArrival.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockUsePositions.mockReturnValue({ positions: null, loading: false, isMock: false });
    mockUseNearest.mockReturnValue(gpsWith({}));
  });

  function renderWithBaro(signal: { unavailableReason?: string } | null) {
    jest.useFakeTimers();
    const barometer = signal === null ? undefined : { subsurface: false, signal };
    renderHook(() =>
      useFusedNearestStation(
        undefined, undefined, undefined, undefined, undefined,
        barometer as never,
      ),
    );
    act(() => {
      jest.advanceTimersByTime(0);
    });
    jest.useRealTimers();
    return mockPushRawSignal.mock.calls.map(([e]: [Dumped]) => e);
  }

  it('reading이 없으면 baroLastAt/baroFirstAt/baroEvtKind=null, baroObs=false', () => {
    const entries = renderWithBaro({});
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.baroLastAt).toBeNull();
      expect(e.baroFirstAt).toBeNull();
      expect(e.baroObs).toBe(false);
      expect(e.baroEvtKind).toBeNull();
    }
  });

  it('baroLastAt/baroFirstAt = 마지막/첫 reading 시각', () => {
    const t = Date.now();
    appendBarometerReading({ t: t - 50_000, pressureHpa: 1013.0 });
    appendBarometerReading({ t: t - 5_000, pressureHpa: 1013.05 });
    const entries = renderWithBaro({});
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.baroFirstAt).toBe(t - 50_000);
      expect(e.baroLastAt).toBe(t - 5_000);
    }
  });

  it('baroObs=true — 실패 사유 없음 + 첫 reading 30s 경과 + 마지막 reading 30s 이내', () => {
    const t = Date.now();
    appendBarometerReading({ t: t - 50_000, pressureHpa: 1013.0 });
    appendBarometerReading({ t: t - 5_000, pressureHpa: 1013.05 });
    const entries = renderWithBaro({});
    expect(entries.every((e) => e.baroObs === true)).toBe(true);
  });

  it('baroObs=false — 워밍업(첫 reading 30s 미만)', () => {
    const t = Date.now();
    appendBarometerReading({ t: t - 10_000, pressureHpa: 1013.0 });
    appendBarometerReading({ t: t - 1_000, pressureHpa: 1013.05 });
    const entries = renderWithBaro({});
    expect(entries.every((e) => e.baroObs === false)).toBe(true);
  });

  it('baroObs=false — 공백(마지막 reading 30s 초과)', () => {
    const t = Date.now();
    appendBarometerReading({ t: t - 90_000, pressureHpa: 1013.0 });
    appendBarometerReading({ t: t - 60_000, pressureHpa: 1013.05 });
    const entries = renderWithBaro({});
    expect(entries.every((e) => e.baroObs === false)).toBe(true);
  });

  it('baroObs=false — 센서 실패 사유가 있으면', () => {
    const t = Date.now();
    appendBarometerReading({ t: t - 50_000, pressureHpa: 1013.0 });
    appendBarometerReading({ t: t - 5_000, pressureHpa: 1013.05 });
    const entries = renderWithBaro({ unavailableReason: 'sensor' });
    expect(entries.every((e) => e.baroObs === false)).toBe(true);
  });

  it('baroObs=false — barometer 인자 자체가 없으면', () => {
    const entries = renderWithBaro(null);
    expect(entries.every((e) => e.baroObs === false)).toBe(true);
  });

  it("baroEvtKind='window' — 30s 창 안 |ΔP|>=0.3 이벤트", () => {
    const t = Date.now();
    appendBarometerReading({ t: t - 20_000, pressureHpa: 1013.0 });
    appendBarometerReading({ t: t - 10_000, pressureHpa: 1013.5 });
    const entries = renderWithBaro({});
    expect(entries.every((e) => e.baroEvtKind === 'window')).toBe(true);
  });

  it("baroEvtKind='gap' — 직전 reading이 30s 밖인 |ΔP|>=0.3 이벤트", () => {
    const t = Date.now();
    appendBarometerReading({ t: t - 100_000, pressureHpa: 1013.0 });
    appendBarometerReading({ t: t - 10_000, pressureHpa: 1013.5 });
    const entries = renderWithBaro({});
    expect(entries.every((e) => e.baroEvtKind === 'gap')).toBe(true);
  });

  it('동작 불변 — 기압 관측 필드 값이 달라도 현재역 판정은 동일', () => {
    jest.useFakeTimers();
    const a = renderHook(() => useFusedNearestStation()).result.current;
    const t = Date.now();
    appendBarometerReading({ t: t - 100_000, pressureHpa: 1013.0 });
    appendBarometerReading({ t: t - 10_000, pressureHpa: 1013.5 });
    const b = renderHook(() => useFusedNearestStation()).result.current;
    jest.useRealTimers();
    expect(b.result?.station.id).toBe(a.result?.station.id);
    expect(b.source).toBe(a.source);
  });
});
