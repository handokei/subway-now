import React from 'react';
import { AppState, Share } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { DebugModal, __test__ } from '../DebugModal';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import { useDestinationStore } from '../../../route/store/useDestinationStore';
import type { AlarmLogEntry } from '../../../../features/alarm/utils/alarmLog';
import type { Station, NearestStationResult } from '../../../../shared/types/station';
import type { StationArrival } from '../../../../shared/types/arrival';

const mockUseFusedNearestStation = jest.fn();
const mockUseArrivalInfo = jest.fn();
const mockUseSilentPushDiagnostics = jest.fn();
const mockGetAlarmLog = jest.fn();
const mockClearAlarmLog = jest.fn();
const mockUseBarometer = jest.fn();
const mockUseLowPowerMode = jest.fn();
// #1235 (D9 wire) — DebugModal이 destinationStore + tripStartStorage SSOT로 trip props 도출.
const mockGetTripStartedAt = jest.fn();
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: () => mockGetTripStartedAt(),
}));

jest.mock('../../../nearest-station/hooks/useFusedNearestStation', () => ({
  useFusedNearestStation: () => mockUseFusedNearestStation(),
}));
jest.mock('../../../arrival/hooks/useArrivalInfo', () => ({
  useArrivalInfo: (name: string | null) => mockUseArrivalInfo(name),
}));
// #1215 (D9) — DebugModal이 직접 useBarometer를 구독해 subsurface row를 렌더한다.
jest.mock('../../../../shared/hooks/useBarometer', () => ({
  useBarometer: () => mockUseBarometer(),
}));
// #1308 — DebugModal이 useLowPowerMode를 구독해 Silent Push 섹션 lowPower row를 렌더한다.
jest.mock('../../../../shared/hooks/useLowPowerMode', () => ({
  useLowPowerMode: () => mockUseLowPowerMode(),
}));
// silentPushTask는 expo-task-manager native module이 필요 — jest 환경에서 chain break.
jest.mock('../../../alarm/hooks/useSilentPushDiagnostics', () => ({
  useSilentPushDiagnostics: () => mockUseSilentPushDiagnostics(),
}));
jest.mock('../../../alarm/utils/alarmLog', () => {
  const actual = jest.requireActual('../../../alarm/utils/alarmLog');
  return {
    ...actual,
    getAlarmLog: () => mockGetAlarmLog(),
    clearAlarmLog: () => mockClearAlarmLog(),
  };
});

const mockDumpScheduledNotifications = jest.fn();
jest.mock('../../../alarm/utils/scheduledNotificationsDump', () => {
  const actual = jest.requireActual('../../../alarm/utils/scheduledNotificationsDump');
  return {
    ...actual,
    dumpScheduledNotifications: () => mockDumpScheduledNotifications(),
  };
});
const station: Station = {
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};

const variantStation: Station = {
  id: '7-220',
  name: '강남구청',
  line: '7',
  lineColor: '#747F00',
  lat: 37.5172,
  lng: 127.0413,
};

const baseResult: NearestStationResult = { station, distanceKm: 0.123 };
const baseUserLocation = { lat: 37.5, lng: 127 };
// #852: GPS section state/lastFix 테스트들이 동일 mock 골격을 반복 — duplication 감지 회피.
// 호출부는 override만 넘기고, 나머지는 기본값으로 채운다.
const fusedReturnFixture = (overrides: Record<string, unknown> = {}) => ({
  result: baseResult,
  gpsResult: baseResult,
  confidence: 'gps-only' as const,
  source: 'gps' as const,
  variants: [],
  userLocation: baseUserLocation,
  speedMps: 1,
  accuracyMeters: 12,
  loading: false,
  error: null,
  permissionDenied: false,
  refresh: jest.fn(),
  // D2(#1208) + D9 wire(#1235) — useFusedNearestStation 신규 노출 필드 기본값.
  currentHopIndex: null,
  arcStations: [],
  detectionTier: 'low' as const,
  detectionSignalMask: '',
  // #1418 — 환경 인지 fusion arbitration 신규 노출 필드 기본값.
  environment: 'unknown' as const,
  surfaceSSOTActive: false,
  undergroundSSOTActive: false,
  // #1421 — PR-AutoLock-1 측정 인프라 신규 노출 필드 기본값.
  surfaceSSOT: null,
  undergroundSSOT: null,
  // #1447 — E4(#1437) 격리 후 별 채널. 기본값은 null(estimator 미산출).
  displayOnlyEstimate: null,
  ...overrides,
});
const arrivalDefaults = {
  line: '1' as const,
  receivedAtMs: 0,
  arrivalCode: -1,
  isLastTrain: false,
  trainType: 'normal' as const,
};
const baseArrival: StationArrival = {
  up: [{ destination: '청량리', arrivalSeconds: 90, statusMessage: '진입', trainCode: 'U1', arrivalMinutes: 1, ...arrivalDefaults }],
  down: [{ destination: '인천', arrivalSeconds: 240, statusMessage: '', trainCode: 'D1', arrivalMinutes: 4, ...arrivalDefaults }],
  isMock: false,
};

const setupHookDefaults = () => {
  mockUseFusedNearestStation.mockReturnValue({
    result: baseResult,
    gpsResult: baseResult,
    confidence: 'gps-only',
    source: 'gps',
    variants: [station, variantStation],
    userLocation: { lat: 37.5, lng: 127 },
    speedMps: 1.5,
    accuracyMeters: 20,
    loading: false,
    error: null,
    permissionDenied: false,
    refresh: jest.fn(),
    // D2(#1208) + D9 wire(#1235) — DebugModal이 hook return으로 fusionDetection/trip 도출.
    // 기본값은 estimator/detection 모두 비어있는 상태 — 미트립 + signalsAvailable=0 시나리오.
    currentHopIndex: null,
    arcStations: [],
    detectionTier: 'low',
    detectionSignalMask: '',
    // #1418 — 환경 인지 fusion arbitration 신규 필드.
    environment: 'unknown',
    surfaceSSOTActive: false,
    undergroundSSOTActive: false,
    // #1421 — PR-AutoLock-1 측정 인프라.
    surfaceSSOT: null,
    undergroundSSOT: null,
    // #1447 — E4(#1437) 격리 후 별 채널. 기본 setupHook은 estimator 미산출(null).
    displayOnlyEstimate: null,
  });
  mockUseArrivalInfo.mockReturnValue({ arrival: baseArrival, loading: false, isMock: false });
  mockUseSilentPushDiagnostics.mockReturnValue({
    apnsToken: null,
    activeTripToken: null,
    apnsEnv: 'sandbox',
    permissionStatus: null,
    taskRegistrationState: 'unknown',
    taskRegistrationError: null,
    lastReceivedAt: null,
    lastFiredAt: null,
    lastSkippedAt: null,
    hasRoute: false,
    destinationId: null,
    lastNotifiedStationId: null,
  });
  mockGetAlarmLog.mockResolvedValue([]);
  mockClearAlarmLog.mockResolvedValue(undefined);
  mockDumpScheduledNotifications.mockResolvedValue([]);
  // #1215 (D9) — 기본은 subsurface=false (지상).
  mockUseBarometer.mockReturnValue({ subsurface: false, stop: undefined });
  // #1308 — 기본은 LPM off.
  mockUseLowPowerMode.mockReturnValue(false);
  // #1235 (D9 wire) — tripStartedAt 기본 null (trip 미시작).
  mockGetTripStartedAt.mockResolvedValue(null);
  // #1235 (D9 wire) — destinationStore/settingsStore SSOT 초기화. 매 테스트 독립.
  useDestinationStore.setState({ destination: null });
  useSettingsStore.setState({ sleepMode: false });
};

// SonarCloud new_duplicated_lines_density 임계 준수 — 여러 describe에 걸친 buildDumpText
// 호출이 동일 baseline(null 좌표/null speed/baseFusion 등)을 반복. outer scope helper로 통합.
const baseFusion = {
  confidence: 'gps-only' as const,
  source: 'gps' as const,
  fusedLabel: '강남(2) · 123m',
  gpsLabel: '강남(2) · 123m',
  differs: false,
  candidateTrains: null as string[] | null,
};
const baseSilentPush = {
  apnsToken: null,
  activeTripToken: null,
  apnsEnv: 'sandbox' as const,
  permissionStatus: null,
  taskRegistrationState: 'unknown' as const,
  taskRegistrationError: null,
  lastReceivedAt: null,
  lastFiredAt: null,
  lastSkippedAt: null,
  hasRoute: false,
  destinationId: null,
  lastNotifiedStationId: null,
};
type DumpArgs = Parameters<typeof __test__.buildDumpText>[0];
const baselineDumpArgs: DumpArgs = {
  userLocation: null,
  speedMps: null,
  accuracyMeters: null,
  nearestName: null,
  nearestDistanceM: null,
  variants: [],
  fusion: baseFusion,
  arrivalSummary: '-',
  isMock: false,
  silentPush: baseSilentPush,
  logs: [],
};
const makeDumpArgs = (overrides: Partial<DumpArgs> = {}): DumpArgs => ({
  ...baselineDumpArgs,
  ...overrides,
});

describe('DebugModal', () => {
  let appStateListener: ((state: string) => void) | null = null;
  const appStateRemove = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    appStateListener = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, l) => {
      appStateListener = l as (state: string) => void;
      return { remove: appStateRemove } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    setupHookDefaults();
  });

  it('__DEV__가 false면 null을 반환한다', () => {
    const g = global as unknown as { __DEV__: boolean };
    const original = g.__DEV__;
    g.__DEV__ = false;
    const { toJSON } = renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(toJSON()).toBeNull();
    g.__DEV__ = original;
  });

  it('GPS / Nearest / Arrival / Alarm log 섹션을 모두 표시한다', async () => {
    const logEntry: AlarmLogEntry = {
      ts: new Date('2026-05-12T10:00:00Z').getTime(),
      source: 'fg',
      outcome: 'fired',
      kind: 'destination',
      phaseId: 'early',
      stationName: '강남',
    };
    mockGetAlarmLog.mockResolvedValue([logEntry]);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    // setLogs(await getAlarmLog())의 await→setState→re-render race를 피하려면
    // mock 호출 시점이 아니라 logs 의존 UI(Alarm log 카운트)가 나타날 때까지 대기.
    expect(await screen.findByText('Alarm log (1)')).toBeTruthy();
    expect(screen.getByText('GPS')).toBeTruthy();
    expect(screen.getByText('Nearest station')).toBeTruthy();
    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.getByTestId('debug-arrival-summary').props.children).toContain('청량리');
    // #1253 — maestro manual flow가 Alarm log 섹션을 testID로 잡는다.
    expect(screen.getByTestId('alarm-log-modal-content')).toBeTruthy();
  });

  it('Alarm log 섹션에 source별 카운트 라인을 표시한다 (#564)', async () => {
    mockGetAlarmLog.mockResolvedValue([
      { ts: 1, source: 'fg', outcome: 'fired' },
      { ts: 2, source: 'alert-fallback-fired', outcome: 'fired' },
      { ts: 3, source: 'alert-fallback-fired', outcome: 'fired' },
    ]);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    const counts = await screen.findByTestId('debug-log-source-counts');
    expect(counts.props.children).toBe('alert-fallback-fired=2, fg=1');
  });

  it('로그가 비어있으면 source 카운트 라인을 렌더링하지 않는다 (#564)', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.queryByTestId('debug-log-source-counts')).toBeNull();
  });

  it('userLocation이 null이면 "no location"을 표시한다', () => {
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({
        result: null,
        gpsResult: null,
        userLocation: null,
        speedMps: null,
        accuracyMeters: null,
      }),
    );
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('(no location)')).toBeTruthy();
    expect(screen.getByText('(no nearest)')).toBeTruthy();
  });

  it('#1418 — surfaceSSOT/undergroundSSOT 활성 시 active 라벨, environment 노출', () => {
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({
        environment: 'surface',
        surfaceSSOTActive: true,
        undergroundSSOTActive: true,
      }),
    );
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('environment')).toBeTruthy();
    expect(screen.getByText('surface')).toBeTruthy();
    // 'active' 라벨이 surfaceSSOT/undergroundSSOT row에 노출.
    expect(screen.getAllByText('active').length).toBeGreaterThanOrEqual(2);
  });

  // #1421 — render-time auto-lock 측정 인프라가 SSOT 객체를 받아 share dump에 흘러간다.
  it('#1421 — surfaceSSOT 객체 활성 시 share dump의 Auto-lock 섹션에 ssot=surface 노출', async () => {
    const ssot = { station: baseResult.station, trainCode: 'U1' };
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({
        surfaceSSOTActive: true,
        surfaceSSOT: ssot,
      }),
    );
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId('debug-share-dump'));
    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const msg = shareSpy.mock.calls[0][0].message;
    expect(msg).toContain('## Auto-lock Candidate');
    expect(msg).toContain('ssot=surface');
    // arcStations 빈 fixture → verifyTrainDirection이 no-route 반환 (matched=false).
    expect(msg).toContain('direction=mismatch reason=no-route');
    shareSpy.mockRestore();
  });

  it('#1421 — undergroundSSOT 객체만 활성 시 ssot=underground 노출', async () => {
    const ssot = { station: baseResult.station, trainCode: 'U1' };
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({
        undergroundSSOTActive: true,
        undergroundSSOT: ssot,
        surfaceSSOT: null,
      }),
    );
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId('debug-share-dump'));
    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const msg = shareSpy.mock.calls[0][0].message;
    expect(msg).toContain('ssot=underground');
    shareSpy.mockRestore();
  });

  it('#1421 — SSOT 모두 null이면 ssot=none, candidate=null reason=no-ssot', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId('debug-share-dump'));
    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const msg = shareSpy.mock.calls[0][0].message;
    expect(msg).toContain('ssot=none');
    expect(msg).toContain('candidate=null reason=no-ssot');
    shareSpy.mockRestore();
  });

  it('arrival이 null이면 no arrival data를 표시한다', () => {
    mockUseArrivalInfo.mockReturnValue({ arrival: null, loading: false, isMock: false });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('(no arrival data)')).toBeTruthy();
  });

  it('isMock일 때 MOCK 배지를 표시한다', () => {
    mockUseArrivalInfo.mockReturnValue({
      arrival: { ...baseArrival, isMock: true },
      loading: false,
      isMock: true,
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('MOCK')).toBeTruthy();
  });

  it('Silent Push 섹션이 taskRegistrationError를 표시한다', () => {
    mockUseSilentPushDiagnostics.mockReturnValue({
      apnsToken: 'abcdef1234567890',
      activeTripToken: null,
      apnsEnv: 'production',
      permissionStatus: null,
      taskRegistrationState: 'failed',
      taskRegistrationError: 'not supported',
      lastReceivedAt: null,
      lastFiredAt: null,
      lastSkippedAt: null,
      hasRoute: false,
      destinationId: null,
      lastNotifiedStationId: null,
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('failed (not supported)')).toBeTruthy();
  });

  it('Silent Push 섹션: LPM off면 lowPower row가 off로 노출된다 (#1308)', () => {
    mockUseLowPowerMode.mockReturnValue(false);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('lowPower')).toBeTruthy();
    expect(screen.getAllByText('off').length).toBeGreaterThan(0);
  });

  it('Silent Push 섹션: LPM on이면 lowPower row가 ON으로 노출된다 (#1308)', () => {
    mockUseLowPowerMode.mockReturnValue(true);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('lowPower')).toBeTruthy();
    expect(screen.getByText('ON')).toBeTruthy();
  });

  it('Silent Push 섹션: trip 입력이 모두 있으면 set/destination id/currStn id 노출 (#506)', () => {
    mockUseSilentPushDiagnostics.mockReturnValue({
      apnsToken: null,
      activeTripToken: null,
      apnsEnv: 'sandbox',
      permissionStatus: null,
      taskRegistrationState: 'success',
      taskRegistrationError: null,
      lastReceivedAt: null,
      lastFiredAt: null,
      lastSkippedAt: null,
      hasRoute: true,
      destinationId: '7-013',
      lastNotifiedStationId: '7-015',
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('set')).toBeTruthy();
    expect(screen.getByText('7-013')).toBeTruthy();
    expect(screen.getByText('7-015')).toBeTruthy();
  });

  it('arrival up/down이 비어있어도 렌더링한다', () => {
    mockUseArrivalInfo.mockReturnValue({
      arrival: { up: [], down: [], isMock: false },
      loading: false,
      isMock: false,
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByTestId('debug-arrival-summary').props.children).toBe('up: -\ndown: -');
  });

  it('speedMps가 null이면 "-"를 표시한다', () => {
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({ speedMps: null, accuracyMeters: null }),
    );
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('알람 로그 비어있으면 (empty) 표시', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    // Fusion log + Alarm log 두 섹션이 비어있을 때 (empty)가 둘.
    expect(screen.getAllByText('(empty)').length).toBeGreaterThanOrEqual(1);
  });

  it('Refresh 버튼이 로그를 다시 불러온다', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(1));
    fireEvent.press(screen.getByTestId('debug-log-refresh'));
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(2));
  });

  it('Clear log 버튼이 로그를 비우고 재조회한다', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.press(screen.getByTestId('debug-clear-log'));
    });
    expect(mockClearAlarmLog).toHaveBeenCalled();
    expect(mockGetAlarmLog).toHaveBeenCalledTimes(2);
  });

  it('Close 버튼이 onClose를 호출한다', () => {
    const onClose = jest.fn();
    renderWithTheme(<DebugModal onClose={onClose} />);
    fireEvent.press(screen.getByTestId('debug-modal-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Share dump 버튼이 Share.share를 호출한다', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId('debug-share-dump'));
    expect(shareSpy).toHaveBeenCalled();
    expect(shareSpy.mock.calls[0][0].message).toContain('Subway debug');
    shareSpy.mockRestore();
  });

  it('AppState active 복귀 시 로그를 다시 불러온다', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(1));
    act(() => {
      appStateListener?.('active');
    });
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(2));
  });

  it('AppState active 외 상태에선 재조회하지 않는다', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalledTimes(1));
    act(() => {
      appStateListener?.('background');
    });
    // 짧게 기다려도 호출 횟수가 늘지 않음
    await new Promise((r) => setTimeout(r, 10));
    expect(mockGetAlarmLog).toHaveBeenCalledTimes(1);
  });

  it('Fusion 섹션에 confidence/source/accuracy를 표시한다', async () => {
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({ confidence: 'arrival-confirmed', source: 'arrival' }),
    );
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('Fusion')).toBeTruthy();
    expect(screen.getByText('arrival-confirmed')).toBeTruthy();
    expect(screen.getByText('arrival')).toBeTruthy();
    expect(screen.getByText('12 m')).toBeTruthy();
    expect(screen.queryByTestId('debug-fusion-diff')).toBeNull();
    expect(screen.getByText('(n/a)')).toBeTruthy();
  });

  it('fused와 gps station id가 다르면 diff 라인을 표시한다', () => {
    const otherStation: Station = { ...station, id: '2-099', name: '역삼' };
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({
        result: { station, distanceKm: 0.05 },
        gpsResult: { station: otherStation, distanceKm: 0.18 },
        confidence: 'arrival-arriving',
        source: 'arrival',
        accuracyMeters: 10,
      }),
    );
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByTestId('debug-fusion-diff')).toBeTruthy();
  });

  it('candidateTrains prop을 받으면 개수와 목록을 표시한다', () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} candidateTrains={['T1', 'T2']} />);
    expect(screen.getByText('2: T1, T2')).toBeTruthy();
  });

  it('candidateTrains가 빈 배열이면 "0: -"으로 표시한다', () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} candidateTrains={[]} />);
    expect(screen.getByText('0: -')).toBeTruthy();
  });

  it('#852: GPS 섹션에 state/lastFix를 항상 표시 (fix 있을 때)', () => {
    const fixTs = new Date(2026, 5, 4, 8, 42, 15).getTime();
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({ gpsActive: 'fg', lastFixAtMs: fixTs }),
    );
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('state')).toBeTruthy();
    expect(screen.getByText('fg')).toBeTruthy();
    expect(screen.getByText('lastFix')).toBeTruthy();
    expect(screen.getByText('08:42:15')).toBeTruthy();
  });

  it('#852: GPS 섹션 state/lastFix — userLocation 없어도 항상 노출 (cold start)', () => {
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({
        result: null,
        gpsResult: null,
        userLocation: null,
        speedMps: null,
        accuracyMeters: null,
        gpsActive: 'bg',
        lastFixAtMs: null,
      }),
    );
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('(no location)')).toBeTruthy();
    // state/lastFix는 userLocation 유무와 무관하게 노출.
    expect(screen.getByText('bg')).toBeTruthy();
    // (never)는 silentPush rows(lastReceived/lastFired/lastSkipped)에도 등장 → 최소 1개 이상.
    expect(screen.getAllByText('(never)').length).toBeGreaterThanOrEqual(1);
  });

  it('#852: hook이 gpsActive/lastFixAtMs를 미제공해도 fg/(never)로 fallback', () => {
    // gpsActive / lastFixAtMs 의도적 미설정.
    mockUseFusedNearestStation.mockReturnValue(fusedReturnFixture({ accuracyMeters: 10 }));
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('fg')).toBeTruthy();
    expect(screen.getAllByText('(never)').length).toBeGreaterThanOrEqual(1);
  });


  it('#1021: Boarding Prompt 섹션에 boardingPrompt 카운터 라벨을 표시한다', async () => {
    const now = Date.now();
    mockGetAlarmLog.mockResolvedValue([
      { ts: now - 60_000, source: 'boarding-prompt', outcome: 'fired' },
    ]);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('Boarding Prompt')).toBeTruthy();
    expect(screen.getByText('boardingPrompt(5m)')).toBeTruthy();
    expect(screen.getByText('boardingPrompt(1h)')).toBeTruthy();
    expect(screen.getByText('boardingPrompt(all)')).toBeTruthy();
  });

  it('#1021: Boarding Prompt 섹션 — boarding-prompt 없으면 카운터 섹션이 0을 표시한다', async () => {
    mockGetAlarmLog.mockResolvedValue([]);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('Boarding Prompt')).toBeTruthy();
  });

  it('#1170: Boarding Prompt Acceptance 섹션이 displayed/responded/rate 라벨을 표시한다', async () => {
    const now = Date.now();
    mockGetAlarmLog.mockResolvedValue([
      { ts: now - 60_000, source: 'boarding-prompt', outcome: 'fired' },
      { ts: now - 30_000, source: 'boarding-prompt', outcome: 'received', reason: 'response-boarded' },
    ]);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('Boarding Prompt Acceptance')).toBeTruthy();
    expect(screen.getByText('displayed')).toBeTruthy();
    expect(screen.getByText('responded')).toBeTruthy();
    expect(screen.getByText('responseRate')).toBeTruthy();
    expect(screen.getByText('boardedRate')).toBeTruthy();
    // 7일 timeline 진입점 header
    expect(screen.getByTestId('debug-boarding-prompt-recent-header')).toBeTruthy();
  });

  it('#1170: 데이터 없으면 rate가 "—" 로 표기된다', async () => {
    mockGetAlarmLog.mockResolvedValue([]);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

    it('unmount 시 AppState listener를 정리한다', async () => {
    const { unmount } = renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    unmount();
    expect(appStateRemove).toHaveBeenCalled();
  });
});

describe('DebugModal helpers', () => {
  it('formatTokenTail: null/짧은 토큰/긴 토큰', () => {
    expect(__test__.formatTokenTail(null)).toBe('(none)');
    expect(__test__.formatTokenTail('abc')).toBe('abc');
    expect(__test__.formatTokenTail('abcdefgh')).toBe('abcdefgh');
    expect(__test__.formatTokenTail('1234567890abcdef')).toBe('…90abcdef');
  });

  it('formatAt: null이면 (never), 아니면 시각 포맷', () => {
    expect(__test__.formatAt(null)).toBe('(never)');
    const ts = new Date('2026-05-12T10:00:00Z').getTime();
    expect(__test__.formatAt(ts)).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('formatLogLine: location 포함 suppressed 엔트리', () => {
    const entry: AlarmLogEntry = {
      ts: new Date('2026-05-12T10:00:00Z').getTime(),
      source: 'bg',
      outcome: 'suppressed',
      reason: 'gate-accuracy',
      location: { lat: 37.5, lng: 127, accuracy: 80, ageMs: 1500 },
    };
    const line = __test__.formatLogLine(entry);
    expect(line).toContain('bg');
    expect(line).toContain('suppressed');
    expect(line).toContain('gate-accuracy');
    expect(line).toContain('acc=80');
    expect(line).toContain('age=1500ms');
  });

  it('formatLogLine: 최소 fired 엔트리', () => {
    const entry: AlarmLogEntry = {
      ts: Date.now(),
      source: 'fg',
      outcome: 'fired',
    };
    const line = __test__.formatLogLine(entry);
    expect(line).toContain('fg');
    expect(line).toContain('fired');
  });

  function bgScheduledEntry(extra: Partial<AlarmLogEntry>): AlarmLogEntry {
    return { ts: Date.now(), source: 'bg-scheduled', outcome: 'fired', ...extra };
  }

  it('formatLogLine: #372 stamp 필드가 채워지면 dir/train/eta/exp/last를 표기한다', () => {
    const line = __test__.formatLogLine(
      bgScheduledEntry({
        phaseId: 'early',
        kind: 'destination',
        stationName: '강남',
        direction: 'up',
        usedTrainCode: 'T-42',
        selectedArrivalSeconds: 600,
        expectedStationAtFire: '강남',
        actualLastNotifiedStation: '시청',
      }),
    );
    expect(line).toContain('bg-scheduled');
    expect(line).toContain('dir=up');
    expect(line).toContain('train=T-42');
    expect(line).toContain('eta=600s');
    expect(line).toContain('exp=강남');
    expect(line).toContain('last=시청');
  });

  it('formatLogLine: stamp 필드가 null/미존재면 추가 토큰이 붙지 않는다', () => {
    const line = __test__.formatLogLine(
      bgScheduledEntry({
        direction: null,
        usedTrainCode: null,
        selectedArrivalSeconds: null,
        expectedStationAtFire: null,
        actualLastNotifiedStation: null,
      }),
    );
    for (const token of ['dir=', 'train=', 'eta=', 'exp=', 'last=']) {
      expect(line).not.toContain(token);
    }
  });

  it('formatLogLine: selectedArrivalSeconds=0이어도 eta=0s로 표기 (0과 null 구분)', () => {
    expect(
      __test__.formatLogLine(bgScheduledEntry({ selectedArrivalSeconds: 0 })),
    ).toContain('eta=0s');
  });

  it('formatLogLine: accuracy null이면 "-"로 표기', () => {
    const entry: AlarmLogEntry = {
      ts: Date.now(),
      source: 'bg',
      outcome: 'suppressed',
      reason: 'gate-age',
      location: { lat: 37.5, lng: 127, accuracy: null, ageMs: 5000 },
    };
    expect(__test__.formatLogLine(entry)).toContain('acc=-');
  });

  it('buildDumpText: 모든 섹션 포함', () => {
    const dump = __test__.buildDumpText({
      userLocation: { lat: 37.5, lng: 127 },
      speedMps: 2,
      accuracyMeters: 30,
      nearestName: '강남',
      nearestDistanceM: 123,
      variants: ['강남(2)'],
      fusion: baseFusion,
      arrivalSummary: 'up: 청량리 · 90s',
      isMock: true,
      silentPush: baseSilentPush,
      logs: [{ ts: Date.now(), source: 'fg', outcome: 'fired', stationName: '강남' }],
    });
    expect(dump).toContain('## GPS');
    expect(dump).toContain('accuracy=30 m');
    expect(dump).toContain('## Nearest');
    expect(dump).toContain('variants: 강남(2)');
    expect(dump).toContain('## Fusion');
    expect(dump).toContain('confidence=gps-only');
    expect(dump).toContain('source=gps');
    expect(dump).toContain('## Arrival');
    expect(dump).toContain('(MOCK)');
    expect(dump).toContain('## Alarm log (1)');
  });

  it('buildDumpText: lowPowerMode=true면 lowPowerMode=ON 라인을 포함한다 (#1308)', () => {
    const dump = __test__.buildDumpText(makeDumpArgs({ lowPowerMode: true }));
    expect(dump).toContain('lowPowerMode=ON');
  });

  it('buildDumpText: lowPowerMode 미전달이면 lowPowerMode=off로 fallback한다 (#1308)', () => {
    const dump = __test__.buildDumpText(makeDumpArgs());
    expect(dump).toContain('lowPowerMode=off');
  });

  it('buildDumpText: fused != gps이면 diff 라인을 추가한다', () => {
    const dump = __test__.buildDumpText({
      userLocation: { lat: 37.5, lng: 127 },
      speedMps: 2,
      accuracyMeters: 30,
      nearestName: '강남',
      nearestDistanceM: 123,
      variants: [],
      fusion: { ...baseFusion, fusedLabel: '역삼(2) · 200m', differs: true },
      arrivalSummary: 'x',
      isMock: false,
      silentPush: baseSilentPush,
      logs: [],
    });
    expect(dump).toContain('(fused != gps)');
  });

  it('buildDumpText: candidateTrains를 받으면 개수와 목록을 표기한다', () => {
    const dump = __test__.buildDumpText({
      userLocation: null,
      speedMps: null,
      accuracyMeters: null,
      nearestName: null,
      nearestDistanceM: null,
      variants: [],
      fusion: { ...baseFusion, candidateTrains: ['T101', 'T202'] },
      arrivalSummary: 'x',
      isMock: false,
      silentPush: baseSilentPush,
      logs: [],
    });
    expect(dump).toContain('candidateTrains(2): T101, T202');
  });

  it('buildDumpText: candidateTrains가 빈 배열이면 "-"로 표기', () => {
    const dump = __test__.buildDumpText({
      userLocation: null,
      speedMps: null,
      accuracyMeters: null,
      nearestName: null,
      nearestDistanceM: null,
      variants: [],
      fusion: { ...baseFusion, candidateTrains: [] },
      arrivalSummary: 'x',
      isMock: false,
      silentPush: baseSilentPush,
      logs: [],
    });
    expect(dump).toContain('candidateTrains(0): -');
  });

  it('buildDumpText: 빈 상태 표기', () => {
    const dump = __test__.buildDumpText({
      userLocation: null,
      speedMps: null,
      accuracyMeters: null,
      nearestName: null,
      nearestDistanceM: null,
      variants: [],
      fusion: baseFusion,
      arrivalSummary: '(no arrival data)',
      isMock: false,
      silentPush: baseSilentPush,
      logs: [],
    });
    expect(dump).toContain('(no location)');
    expect(dump).toContain('(no nearest station)');
    expect(dump).not.toContain('variants:');
    expect(dump).not.toContain('(MOCK)');
    expect(dump).not.toContain('candidateTrains');
    expect(dump).toContain('## Alarm log (0)');
  });

  it('#852 buildDumpText: gpsActive/lastFixAtMs를 받으면 state= / lastFix= 라인을 추가한다', () => {
    const fixTs = new Date(2026, 5, 4, 8, 42, 15).getTime();
    const dump = __test__.buildDumpText(
      makeDumpArgs({
        userLocation: { lat: 37.5, lng: 127 },
        speedMps: 2,
        accuracyMeters: 30,
        gpsActive: 'bg',
        lastFixAtMs: fixTs,
        nearestName: '강남',
        nearestDistanceM: 123,
        arrivalSummary: 'x',
      }),
    );
    expect(dump).toContain('state=bg, lastFix=08:42:15');
  });

  it('#852 buildDumpText: gpsActive/lastFixAtMs 미전달 시 state=fg, lastFix=(never)로 fallback', () => {
    // gpsActive / lastFixAtMs 의도적 미전달 — baseline 그대로.
    const dump = __test__.buildDumpText(makeDumpArgs());
    expect(dump).toContain('state=fg, lastFix=(never)');
  });

  it('buildDumpText: userLocation은 있고 speedMps/accuracy만 null이면 "-" 표기', () => {
    const dump = __test__.buildDumpText({
      userLocation: { lat: 37.5, lng: 127 },
      speedMps: null,
      accuracyMeters: null,
      nearestName: '강남',
      nearestDistanceM: null,
      variants: [],
      fusion: baseFusion,
      arrivalSummary: 'x',
      isMock: false,
      silentPush: baseSilentPush,
      logs: [],
    });
    expect(dump).toContain('speed=- m/s');
    expect(dump).toContain('accuracy=- m');
    expect(dump).toContain('강남 · - m');
  });

  it('formatSourceCountsLine: 빈 로그면 빈 문자열을 반환한다 (#564)', () => {
    expect(__test__.formatSourceCountsLine([])).toBe('');
  });

  it('formatSourceCountsLine: source별 카운트를 정렬해 표기한다 (#564)', () => {
    const logs: AlarmLogEntry[] = [
      { ts: 1, source: 'fg', outcome: 'fired' },
      { ts: 2, source: 'fg', outcome: 'fired' },
      { ts: 3, source: 'bg-scheduled', outcome: 'fired' },
      { ts: 4, source: 'alert-fallback-fired', outcome: 'fired' },
    ];
    const line = __test__.formatSourceCountsLine(logs);
    expect(line).toBe('alert-fallback-fired=1, bg-scheduled=1, fg=2');
  });

  it('buildDumpText: 로그가 있으면 sources 헤더에 source별 카운트를 표기한다 (#564)', () => {
    const dump = __test__.buildDumpText({
      userLocation: null,
      speedMps: null,
      accuracyMeters: null,
      nearestName: null,
      nearestDistanceM: null,
      variants: [],
      fusion: baseFusion,
      arrivalSummary: '-',
      isMock: false,
      silentPush: baseSilentPush,
      logs: [
        { ts: 1, source: 'bg-scheduled', outcome: 'fired' },
        { ts: 2, source: 'alert-fallback-fired', outcome: 'fired' },
      ],
    });
    expect(dump).toContain('sources: alert-fallback-fired=1, bg-scheduled=1');
  });

  it('buildDumpText: 로그가 없으면 sources 헤더를 추가하지 않는다 (#564)', () => {
    const dump = __test__.buildDumpText({
      userLocation: null,
      speedMps: null,
      accuracyMeters: null,
      nearestName: null,
      nearestDistanceM: null,
      variants: [],
      fusion: baseFusion,
      arrivalSummary: '-',
      isMock: false,
      silentPush: baseSilentPush,
      logs: [],
    });
    expect(dump).not.toContain('sources:');
  });

  it('formatLogLine: location 없는 fired 엔트리는 acc/age를 포함하지 않는다', () => {
    const line = __test__.formatLogLine({
      ts: Date.now(),
      source: 'fg',
      outcome: 'fired',
      stationName: '강남',
    });
    expect(line).not.toContain('acc=');
    expect(line).not.toContain('age=');
  });
});

// #1215 (D9) — 신규 optional formatter 유닛 케이스.
// outer scope factory + it.each — SonarCloud nested function 회피.
describe('DebugModal helpers — D9 optional formatters (#1215)', () => {
  it.each([
    [true, 'true'],
    [false, 'false'],
    [null, '—'],
    [undefined, '—'],
  ])('formatOptionalBool(%p) → %p', (input, expected) => {
    expect(__test__.formatOptionalBool(input as boolean | null | undefined)).toBe(expected);
  });

  it.each([
    ['high', 'high'],
    ['', '—'],
    [null, '—'],
    [undefined, '—'],
  ])('formatOptionalString(%p) → %p', (input, expected) => {
    expect(__test__.formatOptionalString(input as string | null | undefined)).toBe(expected);
  });

  it.each([
    [0, '0'],
    [3, '3'],
    [null, '—'],
    [undefined, '—'],
  ])('formatOptionalNumber(%p) → %p', (input, expected) => {
    expect(__test__.formatOptionalNumber(input as number | null | undefined)).toBe(expected);
  });

  it('formatOptionalTs: 값이 있으면 ISO, null이면 —', () => {
    const ts = Date.UTC(2026, 5, 12, 5, 0, 0);
    expect(__test__.formatOptionalTs(ts)).toBe(new Date(ts).toISOString());
    expect(__test__.formatOptionalTs(null)).toBe('—');
    expect(__test__.formatOptionalTs(undefined)).toBe('—');
  });
});

// #1215 (D9) — buildDumpText의 D9 신규 섹션. makeDumpArgs로 baseline 공유.
describe('DebugModal buildDumpText — D9 sections (#1215)', () => {
  it('미전달 시 subsurface/tier/signalMask/Trip/Sleep 모두 — 표기', () => {
    const dump = __test__.buildDumpText(makeDumpArgs());
    expect(dump).toContain('subsurface=—');
    expect(dump).toContain('tier=—');
    expect(dump).toContain('signalMask=—');
    expect(dump).toContain('## Trip');
    expect(dump).toContain('lockless=—');
    expect(dump).toContain('tripStartedAt=—');
    expect(dump).toContain('currentHopIndex=—');
    expect(dump).toContain('route hop count=—');
    expect(dump).toContain('## Sleep');
    expect(dump).toContain('sleepMode=—');
    expect(dump).toContain('firstHopApproaching=—');
  });

  it('lockless trip + hop index + sleep on 입력을 dump에 반영', () => {
    const tripStartedAt = Date.UTC(2026, 5, 12, 4, 0, 0);
    const dump = __test__.buildDumpText(
      makeDumpArgs({
        barometerSubsurface: true,
        fusionDetection: { tier: 'high', signalMask: 'TFT' },
        trip: {
          lockless: true,
          tripStartedAt,
          currentHopIndex: 2,
          routeHopCount: 7,
          displayOnlyEstimateStrategy: null,
        },
        sleep: { sleepMode: true, firstHopApproaching: false },
      }),
    );
    expect(dump).toContain('subsurface=true');
    expect(dump).toContain('tier=high');
    expect(dump).toContain('signalMask=TFT');
    expect(dump).toContain('lockless=true');
    expect(dump).toContain(`tripStartedAt=${new Date(tripStartedAt).toISOString()}`);
    expect(dump).toContain('currentHopIndex=2');
    expect(dump).toContain('route hop count=7');
    expect(dump).toContain('sleepMode=on');
    expect(dump).toContain('firstHopApproaching=false');
  });

  it('lock 활성 trip(lockless=false) + currentHopIndex=null estimator → currentHopIndex=—', () => {
    const dump = __test__.buildDumpText(
      makeDumpArgs({
        trip: {
          lockless: false,
          tripStartedAt: null,
          currentHopIndex: null,
          routeHopCount: 5,
          displayOnlyEstimateStrategy: null,
        },
        sleep: { sleepMode: false, firstHopApproaching: false },
      }),
    );
    expect(dump).toContain('lockless=false');
    expect(dump).toContain('currentHopIndex=—');
    expect(dump).toContain('route hop count=5');
    expect(dump).toContain('sleepMode=off');
  });

  // #1447 — displayOnlyEstimate strategy 라벨 wire-up + fallback.
  // 5종 strategy + null + trip 미전달 케이스가 모두 항상 노출되는지(라벨 누락 0건).
  describe('#1447 — displayOnlyEstimate strategy 라벨 wire-up + fallback', () => {
    const strategies = [
      'live-position',
      'arrival-eta',
      'reanchored-hop',
      'default-hop',
      'lockless-route-hop',
    ] as const;

    it.each(strategies)('strategy=%s → dump에 그대로 노출', (strategy) => {
      const dump = __test__.buildDumpText(
        makeDumpArgs({
          trip: {
            lockless: true,
            tripStartedAt: null,
            currentHopIndex: 1,
            routeHopCount: 5,
            displayOnlyEstimateStrategy: strategy,
          },
        }),
      );
      expect(dump).toContain(`displayOnlyEstimate=${strategy}`);
    });

    it('displayOnlyEstimateStrategy=null → "(none)" fallback 노출', () => {
      const dump = __test__.buildDumpText(
        makeDumpArgs({
          trip: {
            lockless: false,
            tripStartedAt: null,
            currentHopIndex: null,
            routeHopCount: null,
            displayOnlyEstimateStrategy: null,
          },
        }),
      );
      expect(dump).toContain('displayOnlyEstimate=(none)');
    });

    it('trip 자체 미전달 → "(none)" fallback 노출 (라벨 항상 표시)', () => {
      const dump = __test__.buildDumpText(makeDumpArgs());
      expect(dump).toContain('displayOnlyEstimate=(none)');
    });
  });

  describe('#1398 — 기압계 unavailable 원인 분해 dump', () => {
    it('barometerUnavailableReason="sensor" + readingCount=0 → "(reason=sensor, readings=0)" 표기', () => {
      const dump = __test__.buildDumpText(
        makeDumpArgs({
          barometerSubsurface: false,
          barometerUnavailableReason: 'sensor',
          barometerReadingCount: 0,
        }),
      );
      expect(dump).toContain('subsurface=false (reason=sensor, readings=0)');
    });

    it('barometerUnavailableReason="permission" → "(reason=permission, readings=0)"', () => {
      const dump = __test__.buildDumpText(
        makeDumpArgs({
          barometerSubsurface: false,
          barometerUnavailableReason: 'permission',
          barometerReadingCount: 0,
        }),
      );
      expect(dump).toContain('reason=permission');
    });

    it('barometerUnavailableReason="readings" + readingCount=12 → warm-up 진단', () => {
      const dump = __test__.buildDumpText(
        makeDumpArgs({
          barometerSubsurface: false,
          barometerUnavailableReason: 'readings',
          barometerReadingCount: 12,
        }),
      );
      expect(dump).toContain('reason=readings');
      expect(dump).toContain('readings=12');
    });

    it('정상 (reason=undefined) + readingCount=45 → "(readings=45)" 만 (reason 부분 없음)', () => {
      const dump = __test__.buildDumpText(
        makeDumpArgs({
          barometerSubsurface: true,
          barometerUnavailableReason: undefined,
          barometerReadingCount: 45,
        }),
      );
      expect(dump).toContain('subsurface=true (readings=45)');
      expect(dump).not.toContain('reason=');
    });

    it('두 필드 모두 미전달 → 기존 동작 (reason/readings 부분 없음)', () => {
      const dump = __test__.buildDumpText(
        makeDumpArgs({
          barometerSubsurface: true,
        }),
      );
      // 기존 호출자 호환: 미전달 시 dump 라인은 raw subsurface만.
      expect(dump).toContain('subsurface=true');
      expect(dump).not.toContain('(reason=');
      expect(dump).not.toContain('(readings=');
    });
  });
});

// #1215 (D9) — UI 렌더 분기. setupHookDefaults를 그대로 활용해 hook 입력은 최소화.
describe('DebugModal — D9 UI sections (#1215)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupHookDefaults();
  });

  it.each([
    [true, 'true'],
    [false, 'false'],
  ])('GPS 섹션에 subsurface=%p 노출', async (input, expected) => {
    mockUseBarometer.mockReturnValue({ subsurface: input, stop: undefined });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('subsurface')).toBeTruthy();
    // KeyValue의 value 텍스트로 노출. 정확한 매칭은 row 내 텍스트 검색.
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
  });

  it('#1398 GPS 섹션: subsurface reason / readings row 노출 (unavailableReason="sensor", readingCount=0)', async () => {
    mockUseBarometer.mockReturnValue({
      subsurface: false,
      stop: undefined,
      unavailableReason: 'sensor',
      readingCount: 0,
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('subsurface reason')).toBeTruthy();
    expect(screen.getByText('subsurface readings')).toBeTruthy();
    // reason 값 'sensor' 노출 + readings 값 '0' 노출.
    expect(screen.getAllByText('sensor').length).toBeGreaterThan(0);
    // readings는 String(0) → '0'.
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });

  it('#1398 GPS 섹션: reason=undefined(정상) → "—" 표기', async () => {
    mockUseBarometer.mockReturnValue({
      subsurface: true,
      stop: true,
      unavailableReason: undefined,
      readingCount: 45,
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('subsurface reason')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getAllByText('45').length).toBeGreaterThan(0);
  });

  it('fusionDetection 미전달 시 tier/signalMask = —', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('tier')).toBeTruthy();
    expect(screen.getByText('signalMask')).toBeTruthy();
    // — 표기가 최소 1회 이상 노출되는지 (다른 row도 — 일 수 있음).
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('fusionDetection 전달 시 tier/signalMask 값 표기', async () => {
    renderWithTheme(
      <DebugModal
        onClose={jest.fn()}
        fusionDetection={{ tier: 'medium', signalMask: 'TFU' }}
      />,
    );
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.getByText('TFU')).toBeTruthy();
  });

  it('Trip 섹션: lockless=true + currentHopIndex 정의', async () => {
    const tripStartedAt = Date.UTC(2026, 5, 12, 4, 0, 0);
    renderWithTheme(
      <DebugModal
        onClose={jest.fn()}
        trip={{
          lockless: true,
          tripStartedAt,
          currentHopIndex: 3,
          routeHopCount: 8,
          displayOnlyEstimateStrategy: null,
        }}
      />,
    );
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('Trip')).toBeTruthy();
    // #1253 — maestro manual flow가 Trip 섹션을 testID로 잡는다.
    expect(screen.getByTestId('debug-modal-trip-section')).toBeTruthy();
    expect(screen.getByText('lockless')).toBeTruthy();
    expect(screen.getByText(new Date(tripStartedAt).toISOString())).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('8')).toBeTruthy();
  });

  // #1447 — Trip 섹션에 displayOnlyEstimate row가 항상 노출돼야 한다(라벨/값 wire-up).
  // 5종 strategy + null fallback 둘 다 UI에 나오는지 확인.
  it.each([
    ['live-position'],
    ['arrival-eta'],
    ['reanchored-hop'],
    ['default-hop'],
    ['lockless-route-hop'],
  ] as const)(
    'Trip 섹션 displayOnlyEstimate row: strategy=%s → 값 노출',
    async (strategy) => {
      renderWithTheme(
        <DebugModal
          onClose={jest.fn()}
          trip={{
            lockless: true,
            tripStartedAt: null,
            currentHopIndex: 0,
            routeHopCount: 5,
            displayOnlyEstimateStrategy: strategy,
          }}
        />,
      );
      await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
      expect(screen.getByText('displayOnlyEstimate')).toBeTruthy();
      expect(screen.getByTestId('debug-modal-display-only-estimate').props.children).toBe(strategy);
    },
  );

  it('Trip 섹션 displayOnlyEstimate row: null → "(none)" fallback 노출', async () => {
    renderWithTheme(
      <DebugModal
        onClose={jest.fn()}
        trip={{
          lockless: false,
          tripStartedAt: null,
          currentHopIndex: null,
          routeHopCount: null,
          displayOnlyEstimateStrategy: null,
        }}
      />,
    );
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByTestId('debug-modal-display-only-estimate').props.children).toBe('(none)');
  });

  it('Trip 섹션 displayOnlyEstimate row: trip prop 미전달 → hook displayOnlyEstimate=null SSOT 도출 → "(none)"', async () => {
    // setupHookDefaults가 displayOnlyEstimate=null 주입 → fallback이 노출돼야 한다.
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByTestId('debug-modal-display-only-estimate').props.children).toBe('(none)');
  });

  it('Trip 섹션 displayOnlyEstimate row: hook displayOnlyEstimate.strategy SSOT 도출 → 라벨 노출', async () => {
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({
        displayOnlyEstimate: {
          station: { id: '2-001', name: '강남', line: '2', lineColor: '#009D3E', lat: 37.5, lng: 127 },
          strategy: 'lockless-route-hop',
          index: 2,
        },
      }),
    );
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByTestId('debug-modal-display-only-estimate').props.children).toBe(
      'lockless-route-hop',
    );
  });

  it('Trip 섹션: currentHopIndex undefined(D1 미머지) → —', async () => {
    renderWithTheme(
      <DebugModal
        onClose={jest.fn()}
        trip={{
          lockless: false,
          tripStartedAt: null,
          currentHopIndex: undefined,
          routeHopCount: null,
          displayOnlyEstimateStrategy: null,
        }}
      />,
    );
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('currentHopIndex')).toBeTruthy();
    expect(screen.getAllByText('false').length).toBeGreaterThan(0);
  });

  it.each([
    [{ sleepMode: true, firstHopApproaching: true }, 'on', 'true'],
    [{ sleepMode: false, firstHopApproaching: false }, 'off', 'false'],
  ])('Sleep 섹션 분기: sleep=%p → %p / firstHop=%p', async (input, modeText, hopText) => {
    renderWithTheme(<DebugModal onClose={jest.fn()} sleep={input} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('Sleep')).toBeTruthy();
    expect(screen.getAllByText(modeText).length).toBeGreaterThan(0);
    expect(screen.getAllByText(hopText).length).toBeGreaterThan(0);
  });

  it('Sleep prop 미전달 시 sleepMode = —', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('Sleep')).toBeTruthy();
    expect(screen.getByText('sleepMode')).toBeTruthy();
    expect(screen.getByText('firstHopApproaching')).toBeTruthy();
  });

  it('Share dump가 D9 신규 props를 dump에 포함', async () => {
    mockUseBarometer.mockReturnValue({ subsurface: true, stop: undefined });
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderWithTheme(
      <DebugModal
        onClose={jest.fn()}
        fusionDetection={{ tier: 'high', signalMask: 'TTT' }}
        trip={{
          lockless: true,
          tripStartedAt: null,
          currentHopIndex: 1,
          routeHopCount: 4,
          displayOnlyEstimateStrategy: 'lockless-route-hop',
        }}
        sleep={{ sleepMode: true, firstHopApproaching: true }}
      />,
    );
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId('debug-share-dump'));
    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const { message } = shareSpy.mock.calls[0][0] as { message: string };
    expect(message).toContain('subsurface=true');
    expect(message).toContain('tier=high');
    expect(message).toContain('signalMask=TTT');
    expect(message).toContain('lockless=true');
    expect(message).toContain('currentHopIndex=1');
    expect(message).toContain('route hop count=4');
    expect(message).toContain('sleepMode=on');
    expect(message).toContain('firstHopApproaching=true');
    // #1447 — displayOnlyEstimate strategy 라벨이 Share dump에 포함돼야 한다.
    expect(message).toContain('displayOnlyEstimate=lockless-route-hop');
    shareSpy.mockRestore();
  });

  // #1235 (D9 wire) — props 미전달 시 DebugModal이 hook return + store + tripStartStorage에서
  // fusionDetection/trip/sleep SSOT를 도출하는 분기 검증. 외부 helper로 dup 회피
  // (lesson_sonarcloud_dup_prevention.md: outer scope helper + factory + wrapper).
  describe('SSOT wire (props 미전달 → hook+store 도출)', () => {
    // 공유 픽스처/팩토리 — 각 테스트는 single override만 넘긴다.
    const wireTripDestination: Station = {
      id: '2-022',
      name: '강남',
      line: '2',
      lineColor: '#009D3E',
      lat: 37.4979,
      lng: 127.0276,
    };
    const applyWireHook = (overrides: Record<string, unknown>) => {
      mockUseFusedNearestStation.mockReturnValue(fusedReturnFixture(overrides));
    };
    const renderAndAwaitLog = async () => {
      renderWithTheme(<DebugModal onClose={jest.fn()} />);
      await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    };
    const shareAndReadDump = async (): Promise<string> => {
      const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
      await renderAndAwaitLog();
      fireEvent.press(screen.getByTestId('debug-share-dump'));
      await waitFor(() => expect(shareSpy).toHaveBeenCalled());
      const { message } = shareSpy.mock.calls[0][0] as { message: string };
      shareSpy.mockRestore();
      return message;
    };

    it('hook return의 detectionTier/SignalMask가 Fusion 섹션에 노출된다', async () => {
      applyWireHook({ detectionTier: 'high', detectionSignalMask: 'TFT' });
      await renderAndAwaitLog();
      expect(screen.getByText('high')).toBeTruthy();
      expect(screen.getByText('TFT')).toBeTruthy();
    });

    it('destination null + lock 비활성 → Trip lockless=false, routeHopCount=—', async () => {
      applyWireHook({ detectionTier: 'low', detectionSignalMask: '' });
      await renderAndAwaitLog();
      expect(screen.getAllByText('false').length).toBeGreaterThan(0);
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    });

    // currentHopIndex 분기 — 0이면 firstHopApproaching=true, >0이면 false.
    // arcStations 길이 5 → routeHopCount=5로 DebugModal 내부에서 계산.
    const fiveHopArc: Station[] = Array.from({ length: 5 }, (_, i) => ({
      id: `arc-${i}`,
      name: `역${i}`,
      line: '2',
      lineColor: '#009D3E',
      lat: 37.5,
      lng: 127,
    }));
    it.each([
      [0, 'firstHopApproaching=true'],
      [2, 'firstHopApproaching=false'],
    ])('destination 설정 + currentHopIndex=%i → %s', async (idx, expected) => {
      useDestinationStore.setState({ destination: wireTripDestination });
      applyWireHook({ currentHopIndex: idx, arcStations: fiveHopArc });
      const message = await shareAndReadDump();
      expect(message).toContain('lockless=true');
      expect(message).toContain(`currentHopIndex=${idx}`);
      expect(message).toContain('route hop count=5');
      expect(message).toContain(expected);
    });

    it('useSettingsStore.sleepMode=true → Sleep 섹션 sleepMode=on', async () => {
      useSettingsStore.setState({ sleepMode: true });
      const message = await shareAndReadDump();
      expect(message).toContain('sleepMode=on');
    });

    it('tripStartStorage.getTripStartedAt 값이 Trip 섹션에 흐른다', async () => {
      const tripAt = Date.UTC(2026, 5, 12, 9, 0, 0);
      mockGetTripStartedAt.mockResolvedValue(tripAt);
      useDestinationStore.setState({ destination: wireTripDestination });
      const message = await shareAndReadDump();
      expect(message).toContain(`tripStartedAt=${new Date(tripAt).toISOString()}`);
    });

    it('비동기 hydration 중 unmount 시 setState 호출 안 함', async () => {
      // 영원히 resolve 안 되는 Promise로 cleanup race 강제.
      let resolveFn: (value: number | null) => void = () => undefined;
      mockGetTripStartedAt.mockReturnValueOnce(
        new Promise<number | null>((resolve) => {
          resolveFn = resolve;
        }),
      );
      const { unmount } = renderWithTheme(<DebugModal onClose={jest.fn()} />);
      unmount();
      await act(async () => {
        resolveFn(123456789);
      });
      // throw 없이 통과하면 성공.
      expect(true).toBe(true);
    });
  });
});

describe('DebugModal arrival edge cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAlarmLog.mockResolvedValue([]);
    mockUseFusedNearestStation.mockReturnValue(fusedReturnFixture({ accuracyMeters: 15 }));
  });

  it('up.statusMessage가 빈 문자열이면 괄호를 붙이지 않는다', () => {
    mockUseArrivalInfo.mockReturnValue({
      arrival: {
        up: [{ destination: '청량리', arrivalSeconds: 60, statusMessage: '', trainCode: 'U', arrivalMinutes: 1, ...arrivalDefaults }],
        down: [{ destination: '인천', arrivalSeconds: 120, statusMessage: '도착', trainCode: 'D', arrivalMinutes: 2, ...arrivalDefaults }],
        isMock: false,
      },
      loading: false,
      isMock: false,
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    const text = screen.getByTestId('debug-arrival-summary').props.children;
    expect(text).toBe('up: 청량리 · 60s\ndown: 인천 · 120s (도착)');
  });
});

describe('DebugModal share with null nearest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAlarmLog.mockResolvedValue([]);
    mockClearAlarmLog.mockResolvedValue(undefined);
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({
        result: null,
        gpsResult: null,
        userLocation: null,
        speedMps: null,
        accuracyMeters: null,
      }),
    );
    mockUseArrivalInfo.mockReturnValue({ arrival: null, loading: false, isMock: false });
  });

  it('result null인 상태로 Share dump를 호출해도 동작한다', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId('debug-share-dump'));
    expect(shareSpy).toHaveBeenCalled();
    expect(shareSpy.mock.calls[0][0].message).toContain('(no nearest station)');
    shareSpy.mockRestore();
  });
});

describe('DebugModal fusion log section', () => {
  const { pushFusionDebugEntry, clearFusionDebugEntries } =
    jest.requireActual('../../../nearest-station/utils/fusionDebugBuffer');

  beforeEach(() => {
    jest.clearAllMocks();
    clearFusionDebugEntries();
    setupHookDefaults();
  });

  it('비어있으면 (empty) 표시, 엔트리 push 시 라인을 노출한다', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('Fusion log (0)')).toBeTruthy();
    act(() => {
      pushFusionDebugEntry({
        kind: 'fusion',
        ts: new Date('2026-05-20T14:30:00Z').getTime(),
        source: 'position-train',
        confidence: 'position-train',
        stationName: '사가정',
        line: '7',
        distanceKm: 0.817,
        gpsAccuracyAtPushMeters: 25,
        candidates: [
          { key: 'positionTrain', stationName: '사가정', line: '7' },
          { key: 'gps', stationName: '용마산', line: '7', extra: { distanceKm: 0.04 } },
        ],
      });
    });
    expect(screen.getByText('Fusion log (1)')).toBeTruthy();
    const entries = screen.getAllByTestId('debug-fusion-log-entry');
    expect(entries[0].props.children).toContain('src=position-train');
    expect(entries[0].props.children).toContain('pt=사가정');
    expect(entries[0].props.children).toContain('gp=용마산');
  });

  it('Clear 버튼이 fusion 로그를 비운다', async () => {
    pushFusionDebugEntry({
      kind: 'gps',
      event: 'gps-fix',
      ts: Date.now(),
      lat: 37.5,
      lng: 127,
      accuracyMeters: 20,
      speedMps: 0,
      nearestStation: '용마산',
      nearestLine: '7',
      nearestDistanceKm: 0.05,
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Fusion log (1)')).toBeTruthy());
    act(() => {
      fireEvent.press(screen.getByTestId('debug-fusion-log-clear'));
    });
    expect(screen.getByText('Fusion log (0)')).toBeTruthy();
  });
});

describe('DebugModal backend calls section — #1518', () => {
  const {
    pushBackendCallEntry,
    clearBackendCallEntries,
  } = jest.requireActual('../../../../shared/utils/backendCallBuffer');

  beforeEach(() => {
    jest.clearAllMocks();
    clearBackendCallEntries();
    setupHookDefaults();
  });

  it('비어있으면 (0) 헤더, push 시 라인을 노출한다', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('Backend Calls (0)')).toBeTruthy();
    act(() => {
      pushBackendCallEntry({
        kind: 'call',
        ts: Date.now(),
        callId: 'ui-test',
        corrId: 't-ui',
        url: 'https://api.example.com/trips',
        method: 'POST',
      });
    });
    expect(screen.getByText('Backend Calls (1)')).toBeTruthy();
    const entries = screen.getAllByTestId('debug-backend-calls-entry');
    expect(entries[0].props.children).toContain('CALL');
    expect(entries[0].props.children).toContain('corrId=t-ui');
  });

  it('Clear 버튼이 backend call 로그를 비운다', async () => {
    pushBackendCallEntry({
      kind: 'call',
      ts: Date.now(),
      callId: 'ui-clear',
      corrId: null,
      url: 'https://api.example.com/x',
      method: 'GET',
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Backend Calls (1)')).toBeTruthy());
    act(() => {
      fireEvent.press(screen.getByTestId('debug-backend-calls-clear'));
    });
    expect(screen.getByText('Backend Calls (0)')).toBeTruthy();
  });
});

describe('formatFusionDebugLine', () => {
  const { formatFusionDebugLine } = __test__;

  it('gps-fix 엔트리: station/distance/accuracy 포함', () => {
    const line = formatFusionDebugLine({
      kind: 'gps',
      event: 'gps-fix',
      ts: new Date('2026-05-20T14:30:00Z').getTime(),
      lat: 37.5,
      lng: 127,
      accuracyMeters: 25,
      speedMps: 0,
      nearestStation: '용마산',
      nearestLine: '7',
      nearestDistanceKm: 0.04,
    });
    expect(line).toContain('gps-fix');
    expect(line).toContain('용마산(7)');
    expect(line).toContain('d=40m');
    expect(line).toContain('acc=25m');
    expect(line).not.toContain('reason=');
  });

  it('gps-drop 엔트리: 이벤트와 reason 표기', () => {
    const line = formatFusionDebugLine({
      kind: 'gps',
      event: 'gps-drop',
      ts: 0,
      lat: 0,
      lng: 0,
      accuracyMeters: 1500,
      speedMps: null,
      nearestStation: null,
      nearestLine: null,
      nearestDistanceKm: null,
      dropReason: 'low-accuracy-display',
    });
    expect(line).toContain('gps-drop');
    expect(line).toContain('reason=low-accuracy-display');
  });

  it.each([
    ['locked', 50, 0.3, 'sticky:locked', 'acc=50m', 'sp=0.3m/s'],
    ['unlocked-distance', null, null, 'sticky:unlocked-distance', 'acc=-', 'sp=-'],
    ['unlocked-motion', 30, null, 'sticky:unlocked-motion', 'acc=30m', 'sp=-'],
    ['unlocked-ttl', null, 0, 'sticky:unlocked-ttl', 'acc=-', 'sp=0.0m/s'],
    ['unlocked-better-fix', 20, 0.5, 'sticky:unlocked-better-fix', 'acc=20m', 'sp=0.5m/s'],
  ] as const)(
    'sticky 엔트리(%s): event/station/acc/speed 포함',
    (event, acc, sp, expectedEvent, expectedAcc, expectedSp) => {
      const line = formatFusionDebugLine({
        kind: 'sticky',
        event,
        ts: 0,
        stationName: '서울역',
        line: '1',
        accuracyMeters: acc,
        speedMps: sp,
      });
      expect(line).toContain(expectedEvent);
      expect(line).toContain('서울역(1)');
      expect(line).toContain(expectedAcc);
      expect(line).toContain(expectedSp);
    },
  );

  it('gps 엔트리: nearestStation/distance/accuracy 누락 시 "-" 표기', () => {
    const line = formatFusionDebugLine({
      kind: 'gps',
      event: 'gps-fix',
      ts: 0,
      lat: 0,
      lng: 0,
      accuracyMeters: null,
      speedMps: null,
      nearestStation: null,
      nearestLine: null,
      nearestDistanceKm: null,
    });
    expect(line).toContain('| - d=- acc=-');
  });

  it('fusion 엔트리: source/conf/station/cands 포함', () => {
    const line = formatFusionDebugLine({
      kind: 'fusion',
      ts: 0,
      source: 'gps',
      confidence: 'gps-only',
      stationName: '용마산',
      line: '7',
      distanceKm: 0.04,
      gpsAccuracyAtPushMeters: 30,
      candidates: [
        { key: 'fused', stationName: '사가정', line: '7', extra: { source: 'arrival' } },
        { key: 'route', stationName: '건대입구', line: '7' },
        { key: 'gps', stationName: '용마산', line: '7', extra: { distanceKm: 0.04 } },
      ],
    });
    expect(line).toContain('src=gps conf=gps-only');
    expect(line).toContain('용마산(7)');
    expect(line).toContain('fu=사가정');
    expect(line).toContain('rt=건대입구');
    expect(line).toContain('gp=용마산');
  });

  it('fusion 엔트리: positionTrain candidate에 lockMatch=true면 [LOCK] 뱃지', () => {
    const line = formatFusionDebugLine({
      kind: 'fusion',
      ts: 0,
      source: 'boarding-lock',
      confidence: 'boarding-lock',
      stationName: '사가정',
      line: '7',
      distanceKm: 0.1,
      gpsAccuracyAtPushMeters: 30,
      candidates: [
        {
          key: 'positionTrain',
          stationName: '사가정',
          line: '7',
          extra: { trainNo: 'T-LOCKED', lockedTrainCode: 'T-LOCKED', lockMatch: true },
        },
      ],
    });
    expect(line).toContain('pt=사가정[LOCK]');
  });

  it('fusion 엔트리: positionTrain lockMatch=false면 [LOCK] 뱃지 없음', () => {
    const line = formatFusionDebugLine({
      kind: 'fusion',
      ts: 0,
      source: 'position-train',
      confidence: 'position-train',
      stationName: '사가정',
      line: '7',
      distanceKm: 0.1,
      gpsAccuracyAtPushMeters: 30,
      candidates: [
        {
          key: 'positionTrain',
          stationName: '사가정',
          line: '7',
          extra: { trainNo: 'T-OTHER', lockedTrainCode: 'T-LOCKED', lockMatch: false },
        },
      ],
    });
    expect(line).toContain('pt=사가정');
    expect(line).not.toContain('[LOCK]');
  });

  it('fusion 엔트리: 알 수 없는 candidate key는 raw key 그대로 표기', () => {
    const line = formatFusionDebugLine({
      kind: 'fusion',
      ts: 0,
      source: 'gps',
      confidence: 'gps-only',
      stationName: '용마산',
      line: '7',
      distanceKm: 0.04,
      gpsAccuracyAtPushMeters: 30,
      // @ts-expect-error — 미래 신호 추가를 가정한 unknown key
      candidates: [{ key: 'future', stationName: 'X', line: '?' }],
    });
    expect(line).toContain('future=X');
  });

  it('gps 엔트리: nearestStation 있고 nearestLine 없으면 "-" 표기', () => {
    const line = formatFusionDebugLine({
      kind: 'gps',
      event: 'gps-fix',
      ts: 0,
      lat: 0,
      lng: 0,
      accuracyMeters: 30,
      speedMps: null,
      nearestStation: '용마산',
      nearestLine: null,
      nearestDistanceKm: 0.04,
    });
    expect(line).toContain('용마산(-)');
  });

  it('fusion 엔트리: stationName 있고 line 없으면 "-" 표기', () => {
    const line = formatFusionDebugLine({
      kind: 'fusion',
      ts: 0,
      source: 'gps',
      confidence: 'gps-only',
      stationName: '용마산',
      line: null,
      distanceKm: 0.04,
      gpsAccuracyAtPushMeters: 30,
      candidates: [],
    });
    expect(line).toContain('용마산(-)');
  });

  it('fusion 엔트리: candidates 빈 배열이면 "-" placeholder, 다른 필드 null이면 "-"만', () => {
    const line = formatFusionDebugLine({
      kind: 'fusion',
      ts: 0,
      source: 'gps',
      confidence: 'gps-only',
      stationName: null,
      line: null,
      distanceKm: null,
      gpsAccuracyAtPushMeters: null,
      candidates: [],
    });
    expect(line).toContain('- d=- acc=-');
    // 의미 단위: 후보 섹션은 "-" placeholder, 후보 접두어는 없음.
    expect(line).toContain('| -');
    expect(line).not.toContain('pt=');
    expect(line).not.toContain('fu=');
    expect(line).not.toContain('rt=');
    expect(line).not.toContain('gp=');
  });
});

describe('DebugModal — Silent Push 진단 섹션 (#506)', () => {
  const baseSilentPushFull = {
    apnsToken: '0123456789abcdef0123456789abcdef',
    activeTripToken: 'abcd1234ef567890',
    apnsEnv: 'sandbox' as const,
    permissionStatus: null,
    taskRegistrationState: 'success' as const,
    taskRegistrationError: null,
    lastReceivedAt: new Date('2026-05-22T01:23:45Z').getTime(),
    lastFiredAt: new Date('2026-05-22T01:24:00Z').getTime(),
    lastSkippedAt: new Date('2026-05-22T01:22:00Z').getTime(),
    hasRoute: true,
    destinationId: '7-013',
    lastNotifiedStationId: '7-015',
  };

  // 본 describe 4개 호출은 fusion.fusedLabel/gpsLabel을 '-'로 쓰는 변형이 필요. dash fusion 헬퍼.
  const dashFusion = { ...baseFusion, fusedLabel: '-', gpsLabel: '-' };

  it('buildDumpText: Silent Push 섹션을 모든 필드와 함께 포함', () => {
    const dump = __test__.buildDumpText(
      makeDumpArgs({ fusion: dashFusion, silentPush: baseSilentPushFull }),
    );
    expect(dump).toContain('## Silent Push');
    expect(dump).toContain('apnsToken=…89abcdef'); // 끝 8자만
    expect(dump).toContain('activeTrip=…ef567890');
    expect(dump).toContain('apnsEnv=sandbox');
    expect(dump).toContain('taskRegistration=success');
    // #856 — lastReceived/lastFired는 received/fired 카운트 row로 흡수.
    expect(dump).toContain('received=0 (last ');
    expect(dump).toContain('fired=0 (last ');
    expect(dump).toContain('lastSkipped=');
    // #856 — lockless toggle 기본 OFF(미전달 시 false).
    expect(dump).toContain('toggle=off');
  });

  it('buildDumpText: token 없으면 (none), 시각 null이면 (never)', () => {
    const dump = __test__.buildDumpText(
      makeDumpArgs({
        fusion: dashFusion,
        silentPush: { ...baseSilentPush, apnsEnv: 'production' },
      }),
    );
    expect(dump).toContain('apnsToken=(none)');
    expect(dump).toContain('activeTrip=(none)');
    expect(dump).toContain('apnsEnv=production');
    expect(dump).toContain('taskRegistration=unknown');
    // #856 — received/fired 카운트 row가 lastReceived/lastFired 시각을 흡수.
    expect(dump).toContain('received=0 (last (never))');
    expect(dump).toContain('fired=0 (last (never))');
    expect(dump).toContain('lastSkipped=(never)');
  });

  it('buildDumpText: 짧은 토큰(8자 이하)은 그대로 노출', () => {
    const dump = __test__.buildDumpText(
      makeDumpArgs({
        fusion: dashFusion,
        silentPush: { ...baseSilentPushFull, apnsToken: 'short12' },
      }),
    );
    expect(dump).toContain('apnsToken=short12');
  });

  it('buildDumpText: taskRegistrationError 있으면 괄호 안에 메시지 표기', () => {
    const dump = __test__.buildDumpText(
      makeDumpArgs({
        fusion: dashFusion,
        silentPush: {
          ...baseSilentPushFull,
          permissionStatus: null,
          taskRegistrationState: 'failed',
          taskRegistrationError: 'not supported',
        },
      }),
    );
    expect(dump).toContain('taskRegistration=failed (not supported)');
  });

  // #756: 사전예약 큐 dump — stale `bl:` 알람 진단용 새 섹션.
  // 3개 테스트가 동일 baseline args를 공유 — CPD 중복 회피용 helper.
  type DumpArgs = Parameters<typeof __test__.buildDumpText>[0];
  function scheduledDumpArgs(scheduledDump?: DumpArgs['scheduledDump']): DumpArgs {
    return {
      userLocation: null,
      speedMps: null,
      accuracyMeters: null,
      nearestName: null,
      nearestDistanceM: null,
      variants: [],
      fusion: {
        confidence: 'gps-only',
        source: 'gps',
        fusedLabel: '-',
        gpsLabel: '-',
        differs: false,
        candidateTrains: null,
      },
      arrivalSummary: '-',
      isMock: false,
      silentPush: baseSilentPushFull,
      logs: [],
      ...(scheduledDump !== undefined ? { scheduledDump } : {}),
    };
  }

  it('buildDumpText: scheduledDump null이면 "(not loaded)" 노출', () => {
    const dump = __test__.buildDumpText(scheduledDumpArgs(null));
    expect(dump).toContain('## Scheduled queue');
    expect(dump).toContain('(not loaded)');
    expect(dump).not.toMatch(/## Scheduled queue \(\d+\)/);
  });

  it('buildDumpText: scheduledDump optional 미전달 시에도 "(not loaded)" 노출', () => {
    const dump = __test__.buildDumpText(scheduledDumpArgs());
    expect(dump).toContain('## Scheduled queue');
    expect(dump).toContain('(not loaded)');
  });

  it('buildDumpText: scheduledDump 엔트리가 있으면 카운트와 라인 노출', () => {
    const dump = __test__.buildDumpText(
      scheduledDumpArgs([
        {
          identifier: 'bl:T:1:early:군자',
          fireAtMs: new Date('2026-06-02T11:30:00Z').getTime(),
          title: '환승 알림',
          body: '...',
        },
        {
          identifier: 'bl:T:1:imminent:군자',
          fireAtMs: null,
          title: '환승 임박',
          body: '',
        },
      ]),
    );
    expect(dump).toContain('## Scheduled queue (2)');
    expect(dump).toContain('bl:T:1:early:군자');
    expect(dump).toContain('bl:T:1:imminent:군자');
    expect(dump).not.toContain('(not loaded)');
  });
});

describe('DebugModal — Scheduled queue UI (#756)', () => {
  let appStateListener: ((state: string) => void) | null = null;
  const appStateRemove = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    appStateListener = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, l) => {
      appStateListener = l as (state: string) => void;
      return { remove: appStateRemove } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    setupHookDefaults();
  });

  it('#1525 — 마운트 즉시 dumpScheduledNotifications가 1회 호출돼 share dump 좀비 추적 가능', async () => {
    // 직전 동작은 (not loaded) placeholder + 사용자가 Refresh 눌러야 dump. 그 사이에
    // share dump하면 항상 "(not loaded)"로 박혀 좀비 알림(#1525) 추적 불가. 마운트 시점
    // 자동 1회 dump로 share에 항상 실제 OS 큐 스냅샷이 들어가야 한다.
    mockDumpScheduledNotifications.mockResolvedValue([]);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockDumpScheduledNotifications).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Scheduled queue (0)')).toBeTruthy());
  });

  it('Refresh 누르면 dumpScheduledNotifications 호출 + 빈 결과면 "(empty)" 표시', async () => {
    mockDumpScheduledNotifications.mockResolvedValue([]);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    // #1525 — 마운트 자동 dump 1회.
    await waitFor(() => expect(mockDumpScheduledNotifications).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.press(screen.getByTestId('debug-scheduled-dump-refresh'));
    });

    await waitFor(() => expect(screen.getByText('Scheduled queue (0)')).toBeTruthy());
    // "(empty)"는 Alarm log 섹션에도 등장 (logs=[])하므로 getByText 다중매칭 회피 — 카운트만 검증.
    expect(screen.getAllByText('(empty)').length).toBeGreaterThanOrEqual(1);
    // 마운트 자동 1회 + Refresh 1회 = 2회.
    expect(mockDumpScheduledNotifications).toHaveBeenCalledTimes(2);
    expect(appStateListener).toBeTruthy();
  });

  it('Refresh 누르면 엔트리 라인이 렌더링된다', async () => {
    mockDumpScheduledNotifications.mockResolvedValue([
      {
        identifier: 'bl:T:1:early:군자',
        fireAtMs: new Date('2026-06-02T11:30:00Z').getTime(),
        title: '환승 알림',
        body: '...',
      },
    ]);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('debug-scheduled-dump-refresh'));
    });

    await waitFor(() => expect(screen.getByText('Scheduled queue (1)')).toBeTruthy());
    const entries = screen.getAllByTestId('debug-scheduled-dump-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].props.children).toContain('bl:T:1:early:군자');
  });

  it('Refresh 후 Share dump 라인에 Scheduled queue 섹션 포함', async () => {
    mockDumpScheduledNotifications.mockResolvedValue([
      {
        identifier: 'bl:T:0:imminent:장한평',
        fireAtMs: 1000,
        title: '목적지 임박',
        body: '',
      },
    ]);
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('debug-scheduled-dump-refresh'));
    });
    await waitFor(() => expect(screen.getByText('Scheduled queue (1)')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('debug-share-dump'));
    });

    expect(shareSpy).toHaveBeenCalled();
    const sharedMessage = shareSpy.mock.calls[0][0].message;
    expect(sharedMessage).toContain('## Scheduled queue (1)');
    expect(sharedMessage).toContain('bl:T:0:imminent:장한평');
  });
});

describe('DebugModal — Silent Push UX 카운트/토글 (#856)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupHookDefaults();
    act(() => {
      useSettingsStore.setState({ locklessStationPassed: false });
    });
  });

  afterEach(() => {
    act(() => {
      useSettingsStore.setState({ locklessStationPassed: false });
    });
  });

  it('alarm log에 silent-push-received/fired/skipped가 있으면 received/fired 카운트 row가 노출된다', async () => {
    mockGetAlarmLog.mockResolvedValue([
      { ts: 1, source: 'silent-push-received', outcome: 'received' },
      { ts: 2, source: 'silent-push-received', outcome: 'received' },
      { ts: 3, source: 'silent-push-fired', outcome: 'fired' },
      { ts: 4, source: 'silent-push-skipped', outcome: 'suppressed' },
    ]);
    mockUseSilentPushDiagnostics.mockReturnValue({
      apnsToken: null,
      activeTripToken: null,
      apnsEnv: 'sandbox',
      permissionStatus: null,
      taskRegistrationState: 'success',
      taskRegistrationError: null,
      lastReceivedAt: new Date('2026-06-04T01:23:45Z').getTime(),
      lastFiredAt: new Date('2026-06-04T01:24:00Z').getTime(),
      lastSkippedAt: null,
      hasRoute: false,
      destinationId: null,
      lastNotifiedStationId: null,
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    // logs 도착 후 row가 갱신될 때까지 대기. value에 카운트(2/1)와 시간이 함께 노출.
    await waitFor(() => expect(screen.getByText(/^2 \(last \d{2}:\d{2}:\d{2}\)$/)).toBeTruthy());
    expect(screen.getByText(/^1 \(last \d{2}:\d{2}:\d{2}\)$/)).toBeTruthy();
  });

  it('locklessStationPassed=false면 toggle row가 OFF 안내 문구로 노출된다', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText(/lockless station-passed 비활성/)).toBeTruthy();
  });

  it('locklessStationPassed=true면 toggle row가 "on"으로 노출된다', async () => {
    act(() => {
      useSettingsStore.setState({ locklessStationPassed: true });
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('on')).toBeTruthy();
  });

  it('Share dump에 received/fired 카운트와 toggle 라벨이 포함된다', async () => {
    mockGetAlarmLog.mockResolvedValue([
      { ts: 1, source: 'silent-push-received', outcome: 'received' },
      { ts: 2, source: 'silent-push-fired', outcome: 'fired' },
    ]);
    act(() => {
      useSettingsStore.setState({ locklessStationPassed: true });
    });
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    // logs 반영(Alarm log 카운트로 검증) 후 share — useCallback closure가 신규 logs 캡처.
    await waitFor(() => expect(screen.getByText('Alarm log (2)')).toBeTruthy());
    fireEvent.press(screen.getByTestId('debug-share-dump'));
    const msg = shareSpy.mock.calls[0][0].message;
    expect(msg).toContain('received=1');
    expect(msg).toContain('fired=1');
    expect(msg).toContain('toggle=on');
    shareSpy.mockRestore();
  });

  it('빈 log + lastReceived null이면 received=0 (last (never)) 노출', async () => {
    mockUseSilentPushDiagnostics.mockReturnValue({
      apnsToken: null,
      activeTripToken: null,
      apnsEnv: 'sandbox',
      permissionStatus: null,
      taskRegistrationState: 'unknown',
      taskRegistrationError: null,
      lastReceivedAt: null,
      lastFiredAt: null,
      lastSkippedAt: null,
      hasRoute: false,
      destinationId: null,
      lastNotifiedStationId: null,
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getAllByText('0 (last (never))').length).toBeGreaterThanOrEqual(2);
  });
});

describe('DebugModal — fusedSpeed fallback (#853)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupHookDefaults();
  });

  const fusedRowFor = (
    label: string,
    rows: ReturnType<typeof __test__.buildGpsRows>,
  ): string => rows.find((r) => r.label === label)?.value ?? '';

  // SonarCloud CPD 회피: 4개 buildGpsRows 테스트가 동일 baseline. helper로 공통 args 묶음.
  type GpsArgs = Parameters<typeof __test__.buildGpsRows>[0];
  const gpsRowsArgs = (overrides: Partial<GpsArgs> = {}): GpsArgs => ({
    userLocation: { lat: 37.5, lng: 127 },
    speedMps: null,
    accuracyMeters: null,
    fusedSpeed: null,
    ...overrides,
  });

  // SonarCloud CPD 회피: 3개 buildDumpText 테스트가 동일 baseline. silentPush/fusion 블록 helper로 묶음.
  const baselineSilentPush = {
    apnsToken: null,
    activeTripToken: null,
    apnsEnv: 'sandbox' as const,
    permissionStatus: null,
    taskRegistrationState: 'unknown' as const,
    taskRegistrationError: null,
    lastReceivedAt: null,
    lastFiredAt: null,
    lastSkippedAt: null,
    hasRoute: false,
    destinationId: null,
    lastNotifiedStationId: null,
  };
  type DumpArgs = Parameters<typeof __test__.buildDumpText>[0];
  const fusedDumpArgs = (overrides: Partial<DumpArgs> = {}): DumpArgs => ({
    userLocation: { lat: 37.5, lng: 127 },
    speedMps: null,
    accuracyMeters: null,
    nearestName: '강남',
    nearestDistanceM: 100,
    variants: [],
    fusion: {
      confidence: 'gps-only',
      source: 'gps',
      fusedLabel: '-',
      gpsLabel: '-',
      differs: false,
      candidateTrains: null,
    },
    arrivalSummary: '-',
    isMock: false,
    silentPush: baselineSilentPush,
    logs: [],
    ...overrides,
  });

  it('buildGpsRows: userLocation 없으면 빈 배열', () => {
    const rows = __test__.buildGpsRows(
      gpsRowsArgs({ userLocation: null, speedMps: 1, accuracyMeters: 10 }),
    );
    expect(rows).toEqual([]);
  });

  it('buildGpsRows: GPS speed 정상 + fused 미전달이면 fused 라벨이 (no fused signal)', () => {
    const rows = __test__.buildGpsRows(
      gpsRowsArgs({ speedMps: 1.13, accuracyMeters: 12 }),
    );
    expect(fusedRowFor('speed', rows)).toBe('1.13 m/s');
    expect(fusedRowFor('fused', rows)).toBe(__test__.NO_FUSED_SIGNAL_LABEL);
    expect(fusedRowFor('accuracy', rows)).toBe('12 m');
  });

  it('buildGpsRows: GPS speed=null이어도 fused signal 전달되면 km/h + source 노출', () => {
    const rows = __test__.buildGpsRows(
      gpsRowsArgs({ fusedSpeed: { kmh: 18.4, source: 'position-train' } }),
    );
    expect(fusedRowFor('speed', rows)).toBe('-');
    expect(fusedRowFor('fused', rows)).toBe('18.4 km/h (position-train)');
    expect(fusedRowFor('accuracy', rows)).toBe('-');
  });

  it('buildGpsRows: fused signal source는 FusionSource enum 그대로 노출(kalman/mapMatched 등 후속 확장 시 라벨 변경 불필요)', () => {
    const rows = __test__.buildGpsRows(
      gpsRowsArgs({ fusedSpeed: { kmh: 0, source: 'gps' } }),
    );
    expect(fusedRowFor('fused', rows)).toBe('0.0 km/h (gps)');
  });

  it('buildDumpText: fused signal 미전달이면 fused=(no fused signal) 라인', () => {
    const dump = __test__.buildDumpText(fusedDumpArgs());
    expect(dump).toContain(`fused=${__test__.NO_FUSED_SIGNAL_LABEL}`);
  });

  it('buildDumpText: fused signal 전달 시 km/h + source 라인', () => {
    const dump = __test__.buildDumpText(
      fusedDumpArgs({
        speedMps: 1.5,
        accuracyMeters: 10,
        fusedSpeed: { kmh: 22.7, source: 'position' },
      }),
    );
    expect(dump).toContain('fused=22.7 km/h (position)');
  });

  it('buildDumpText: userLocation=null이면 fused 라인 자체 미노출 ("(no location)"만)', () => {
    const dump = __test__.buildDumpText(
      fusedDumpArgs({
        userLocation: null,
        nearestName: null,
        nearestDistanceM: null,
        fusedSpeed: { kmh: 5, source: 'gps' },
      }),
    );
    expect(dump).toContain('(no location)');
    expect(dump).not.toContain('fused=');
  });

  it('GPS 섹션 렌더링: fusedSpeed prop 미전달이면 "(no fused signal)" 노출', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    // 기본 mock: speedMps=1.5, userLocation 존재.
    expect(await screen.findByText(__test__.NO_FUSED_SIGNAL_LABEL)).toBeTruthy();
  });

  it('GPS 섹션 렌더링: fusedSpeed prop 전달 시 "km/h (source)" 라벨 노출', async () => {
    renderWithTheme(
      <DebugModal onClose={jest.fn()} fusedSpeed={{ kmh: 35.2, source: 'arrival' }} />,
    );
    expect(await screen.findByText('35.2 km/h (arrival)')).toBeTruthy();
  });

  it('GPS 섹션 렌더링: GPS speed=null + fusedSpeed 전달 시 두 줄 분리 노출', async () => {
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({ speedMps: null }),
    );
    renderWithTheme(
      <DebugModal onClose={jest.fn()} fusedSpeed={{ kmh: 18, source: 'position-train' }} />,
    );
    // GPS speed가 "-"로 노출되더라도 fused 라인이 별도로 사용자 인지 가능해야 함.
    expect(await screen.findByText('18.0 km/h (position-train)')).toBeTruthy();
  });
  describe('formatReasonCountsLine (#1019)', () => {
    it('빈 로그이면 빈 문자열', () => { expect(__test__.formatReasonCountsLine([])).toBe(''); });
    it('fired/received는 제외', () => {
      expect(__test__.formatReasonCountsLine([{ ts: 1, source: 'fg' as const, outcome: 'fired' as const }])).toBe('');
    });
    it('suppressed reason별 내림차순', () => {
      const logs = [
        { ts: 1, source: 'fg' as const, outcome: 'suppressed' as const, reason: 'gate-phase-accuracy' as const },
        { ts: 2, source: 'fg' as const, outcome: 'suppressed' as const, reason: 'gate-phase-accuracy' as const },
        { ts: 3, source: 'fg' as const, outcome: 'suppressed' as const, reason: 'movement-static-speed' as const },
      ];
      expect(__test__.formatReasonCountsLine(logs)).toBe('gate-phase-accuracy=2, movement-static-speed=1');
    });
    it('카운트 같으면 이름 오름차순', () => {
      const logs = [
        { ts: 1, source: 'fg' as const, outcome: 'suppressed' as const, reason: 'movement-static-speed' as const },
        { ts: 2, source: 'fg' as const, outcome: 'suppressed' as const, reason: 'gate-phase-accuracy' as const },
      ];
      expect(__test__.formatReasonCountsLine(logs)).toBe('gate-phase-accuracy=1, movement-static-speed=1');
    });
  });
  describe('buildDumpText ## Gates (#1019)', () => {
    it('suppressed 없으면 ## Gates 없음', () => {
      const dump = __test__.buildDumpText(makeDumpArgs({ logs: [{ ts: 1, source: 'fg' as const, outcome: 'fired' as const }] }));
      expect(dump).not.toContain('## Gates');
    });
    it('suppressed 있으면 ## Gates 섹션 포함', () => {
      const dump = __test__.buildDumpText(makeDumpArgs({
        logs: [
          { ts: 1, source: 'fg-evaluated' as const, outcome: 'suppressed' as const, reason: 'gate-phase-accuracy' as const },
          { ts: 2, source: 'fg-evaluated' as const, outcome: 'suppressed' as const, reason: 'gate-phase-accuracy' as const },
        ],
      }));
      expect(dump).toContain('## Gates');
      expect(dump).toContain('gate-phase-accuracy=2');
    });
  });
  describe('UI Gates section (#1019)', () => {
    it('억제 없으면 Gates 섹션 없음', async () => {
      mockGetAlarmLog.mockResolvedValue([{ ts: 1, source: 'fg', outcome: 'fired' }]);
      renderWithTheme(<DebugModal onClose={jest.fn()} />);
      await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
      expect(screen.queryByTestId('debug-gate-reason-counts')).toBeNull();
    });
    it('억제 있으면 Gates 섹션 표시', async () => {
      mockGetAlarmLog.mockResolvedValue([
        { ts: 1, source: 'fg-evaluated', outcome: 'suppressed', reason: 'gate-phase-accuracy' },
        { ts: 2, source: 'fg-evaluated', outcome: 'suppressed', reason: 'gate-phase-accuracy' },
      ]);
      renderWithTheme(<DebugModal onClose={jest.fn()} />);
      const el = await screen.findByTestId('debug-gate-reason-counts');
      expect(el.props.children).toContain('gate-phase-accuracy=2');
    });
  });

});

describe('DebugModal — BoardingLock 섹션 (#1025)', () => {
  // useBoardingLockStore는 jest.requireActual을 사용하므로 describe 스코프에서 1회 resolve.
  const { useBoardingLockStore } = jest.requireActual('../../../alarm/store/useBoardingLockStore');
  // boardedAt은 테스트 실행 시점 기준 — Date.now()를 직접 사용해야 만료 판정을 피한다.
  const activeLockBase = () => ({
    boardedAt: Date.now(),
    expectedDurationMs: 30 * 60 * 1000,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    setupHookDefaults();
    act(() => { useBoardingLockStore.setState({ lock: null }); });
  });

  const renderAndWait = async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
  };

  it('lock이 없으면 active=no를 표시한다', async () => {
    await renderAndWait();
    expect(screen.getByText('BoardingLock')).toBeTruthy();
    expect(screen.getByText('no')).toBeTruthy();
  });

  it('lock이 활성이면 active=yes + trainCode/line을 표시한다', async () => {
    act(() => {
      useBoardingLockStore.setState({
        lock: { ...activeLockBase(), destinationId: 'dest-1', trainCode: 'T-101', boardingStationId: 'stn-1', boardingLine: '2' },
      });
    });
    await renderAndWait();
    expect(screen.getByText('T-101')).toBeTruthy();
    expect(screen.getByText('yes')).toBeTruthy();
  });

  it('lock이 sentinel이면 sentinel=yes를 표시한다', async () => {
    act(() => {
      useBoardingLockStore.setState({
        lock: {
          ...activeLockBase(),
          destinationId: 'FREE_TRIP_SENTINEL',
          trainCode: 'T-999',
          boardingStationId: 'stn-2',
          boardingLine: '7',
          hydratedFromSentinel: { destinationId: 'FREE_TRIP_SENTINEL', sentinelAt: Date.now() },
        },
      });
    });
    await renderAndWait();
    expect(screen.getByText('sentinel')).toBeTruthy();
  });
});

describe('DebugModal — Estimator State 섹션 (#1025)', () => {
  const { pushEstimatorEntry, clearEstimatorEntries } =
    jest.requireActual('../../../route/utils/estimatorDebugBuffer');

  // 반복되는 pushEstimatorEntry 호출 baseline — strategy/station/arcIndex만 오버라이드.
  type EstimatorEntryArgs = Parameters<typeof pushEstimatorEntry>[0];
  const pushEntry = (overrides: Partial<EstimatorEntryArgs> = {}) =>
    pushEstimatorEntry({ ts: Date.now(), strategy: 'live-position', stationName: '강남', stationLine: '2', arcIndex: 1, ...overrides });

  beforeEach(() => {
    jest.clearAllMocks();
    clearEstimatorEntries();
    setupHookDefaults();
  });

  it('비어있으면 (empty) 표시', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('Estimator State (0)')).toBeTruthy();
  });

  it('엔트리가 있으면 라인을 노출한다', async () => {
    act(() => { pushEntry({ ts: new Date('2026-06-01T10:00:00Z').getTime(), strategy: 'live-position', stationName: '강남', stationLine: '2', arcIndex: 3 }); });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Estimator State (1)')).toBeTruthy());
    const entries = screen.getAllByTestId('debug-estimator-entry');
    expect(entries[0].props.children).toContain('live-position');
    expect(entries[0].props.children).toContain('강남(2)');
    expect(entries[0].props.children).toContain('idx=3');
  });

  it('Clear 버튼이 estimator 로그를 비운다', async () => {
    act(() => { pushEntry({ strategy: 'default-hop', stationName: '역삼', arcIndex: 1 }); });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Estimator State (1)')).toBeTruthy());
    act(() => { fireEvent.press(screen.getByTestId('debug-estimator-clear')); });
    expect(screen.getByText('Estimator State (0)')).toBeTruthy();
  });
});

describe('DebugModal — Gates 섹션 (#1025)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupHookDefaults();
  });

  it('gate block이 없으면 "(no gate blocks)"를 표시한다', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('Gates')).toBeTruthy();
    expect(screen.getByText('(no gate blocks)')).toBeTruthy();
  });

  it('gate/movement reason이 있는 로그가 있으면 카운트를 표시한다', async () => {
    mockGetAlarmLog.mockResolvedValue([
      { ts: 1, source: 'bg', outcome: 'suppressed', reason: 'gate-out-of-range' },
      { ts: 2, source: 'bg', outcome: 'suppressed', reason: 'gate-out-of-range' },
      { ts: 3, source: 'fg', outcome: 'suppressed', reason: 'movement-static-speed' },
    ]);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Alarm log (3)')).toBeTruthy());
    // Gates 섹션에 gate-out-of-range/movement-static-speed 카운트 노출 확인.
    // CountersSection도 같은 reason을 표시하므로 getAllByText로 최소 1건 존재를 확인.
    expect(screen.getAllByText('gate-out-of-range').length).toBeGreaterThan(0);
    expect(screen.getAllByText('movement-static-speed').length).toBeGreaterThan(0);
  });
});

// #1346 — Share build SSOT. 모든 섹션이 한 배열에서 enumerate되므로 누락 없이 출력된다.
describe('DebugModal share SSOT (#1346)', () => {
  // outer scope factory — SonarCloud nested function 회피.
  type DumpArgs = Parameters<typeof __test__.buildDumpText>[0];
  const ssotBaseline: DumpArgs = {
    userLocation: null,
    speedMps: null,
    accuracyMeters: null,
    nearestName: null,
    nearestDistanceM: null,
    variants: [],
    fusion: {
      confidence: 'gps-only' as const,
      source: 'gps' as const,
      fusedLabel: '-',
      gpsLabel: '-',
      differs: false,
      candidateTrains: null,
    },
    arrivalSummary: '-',
    isMock: false,
    silentPush: {
      apnsToken: null,
      activeTripToken: null,
      apnsEnv: 'sandbox' as const,
      permissionStatus: null,
      taskRegistrationState: 'unknown' as const,
      taskRegistrationError: null,
      lastReceivedAt: null,
      lastFiredAt: null,
      lastSkippedAt: null,
      hasRoute: false,
      destinationId: null,
      lastNotifiedStationId: null,
    },
    logs: [],
  };
  const makeSsotArgs = (overrides: Partial<DumpArgs> = {}): DumpArgs => ({
    ...ssotBaseline,
    ...overrides,
  });

  it('모든 SSOT 섹션 헤더가 share 텍스트에 포함된다 (Gates 제외, suppressed 없음 시)', () => {
    const dump = __test__.buildDumpText(makeSsotArgs());
    expect(dump).toContain('## GPS');
    expect(dump).toContain('## Nearest');
    expect(dump).toContain('## Fusion');
    expect(dump).toContain('## Trip');
    expect(dump).toContain('## Sleep');
    expect(dump).toContain('## Arrival');
    expect(dump).toContain('## Silent Push');
    expect(dump).toContain('## Scheduled queue');
    expect(dump).toContain('## Alarm log');
    expect(dump).toContain('## Fusion log');
    // #1413 — UI에만 노출되던 5개 섹션이 share dump에 포함되어야 한다.
    expect(dump).toContain('## BoardingLock');
    expect(dump).toContain('## Estimator State');
    expect(dump).toContain('## Boarding Prompt');
    expect(dump).toContain('## Boarding Prompt Acceptance');
    expect(dump).toContain('## Counters');
    // #1421 — PR-AutoLock-1 측정 인프라.
    expect(dump).toContain('## Auto-lock Candidate');
    // suppressed reason 없으면 Gates 헤더 자체 생략(omitIfEmpty=true).
    expect(dump).not.toContain('## Gates');
  });

  it('Fusion log 섹션이 Alarm log 섹션 *다음*에 위치한다', () => {
    const dump = __test__.buildDumpText(makeSsotArgs());
    const alarmIdx = dump.indexOf('## Alarm log');
    const fusionLogIdx = dump.indexOf('## Fusion log');
    expect(alarmIdx).toBeGreaterThan(-1);
    expect(fusionLogIdx).toBeGreaterThan(alarmIdx);
  });

  it('Fusion log: fusionLog 미전달 시 카운트 0 + (empty) 표시', () => {
    const dump = __test__.buildDumpText(makeSsotArgs());
    expect(dump).toContain('## Fusion log (0)');
    // 본문 라인 — Alarm log 비어있을 때도 (empty)이지만 fusion log 섹션은 항상 한 줄.
    const fusionSection = dump.slice(dump.indexOf('## Fusion log'));
    expect(fusionSection).toContain('(empty)');
  });

  it('Fusion log: fusionLog 빈 배열도 (empty) 출력', () => {
    const dump = __test__.buildDumpText(makeSsotArgs({ fusionLog: [] }));
    expect(dump).toContain('## Fusion log (0)');
    const fusionSection = dump.slice(dump.indexOf('## Fusion log'));
    expect(fusionSection).toContain('(empty)');
  });

  it('Fusion log: 3건 데이터 → 3줄로 직렬화(최신 먼저)', () => {
    const ts1 = new Date('2026-06-15T10:00:00Z').getTime();
    const ts2 = new Date('2026-06-15T10:00:10Z').getTime();
    const ts3 = new Date('2026-06-15T10:00:20Z').getTime();
    const dump = __test__.buildDumpText(
      makeSsotArgs({
        fusionLog: [
          {
            kind: 'gps',
            event: 'gps-fix',
            ts: ts1,
            lat: 37.5,
            lng: 127,
            accuracyMeters: 20,
            speedMps: 0,
            nearestStation: '용마산',
            nearestLine: '7',
            nearestDistanceKm: 0.05,
          },
          {
            kind: 'sticky',
            event: 'locked',
            ts: ts2,
            stationName: '용마산',
            line: '7',
            accuracyMeters: 50,
            speedMps: 0.2,
          },
          {
            kind: 'fusion',
            ts: ts3,
            source: 'position-train',
            confidence: 'position-train',
            stationName: '사가정',
            line: '7',
            distanceKm: 0.8,
            gpsAccuracyAtPushMeters: 25,
            candidates: [
              { key: 'positionTrain', stationName: '사가정', line: '7' },
            ],
          },
        ],
      }),
    );
    expect(dump).toContain('## Fusion log (3)');
    // 최신(ts3) 먼저 — Alarm log와 동일 정렬.
    // #1413 — Fusion log 뒤에 추가된 섹션과 격리 위해 다음 `## ` 헤더까지로 자른다.
    const fusionStart = dump.indexOf('## Fusion log');
    const nextHeader = dump.indexOf('\n## ', fusionStart + 1);
    const fusionSection = nextHeader === -1 ? dump.slice(fusionStart) : dump.slice(fusionStart, nextHeader);
    expect(fusionSection).toContain('src=position-train');
    expect(fusionSection).toContain('gps-fix');
    expect(fusionSection).toContain('sticky:locked');
    // 본문 라인 3건 — 헤더 다음의 줄 수가 3.
    const bodyLines = fusionSection.split('\n').slice(1).filter((l) => l.length > 0);
    expect(bodyLines).toHaveLength(3);
  });

  // #1413 — 누락된 5개 섹션이 dump 본문에 정확한 값으로 흐르는지 검증.
  describe('#1413 누락 섹션', () => {
    it('BoardingLock: lock=null이면 active=no만 출력', () => {
      const dump = __test__.buildDumpText(makeSsotArgs());
      const section = dump.slice(dump.indexOf('## BoardingLock'));
      expect(section).toContain('active=no');
      expect(section).not.toContain('trainCode=');
    });

    it('BoardingLock: lock 활성이면 trainCode/line/expiresAt/boardedAt 노출', () => {
      const boardedAt = new Date('2026-06-17T13:00:00Z').getTime();
      const dump = __test__.buildDumpText(
        makeSsotArgs({
          nowMs: boardedAt + 60_000,
          boardingLock: {
            trainCode: '7152',
            boardingLine: '7',
            boardedAt,
            expectedDurationMs: 30 * 60 * 1000,
            boardingStationId: '728',
            destinationId: '2-022',
          },
        }),
      );
      const section = dump.slice(
        dump.indexOf('## BoardingLock'),
        dump.indexOf('## Estimator State'),
      );
      expect(section).toContain('active=yes');
      expect(section).toContain('trainCode=7152');
      expect(section).toContain('line=7');
      expect(section).toContain('expiresAt=');
      expect(section).toContain('boardedAt=');
      expect(section).not.toContain('sentinel=yes');
    });

    it('BoardingLock: hydratedFromSentinel=true면 sentinel=yes 라인 추가', () => {
      const boardedAt = new Date('2026-06-17T13:00:00Z').getTime();
      const dump = __test__.buildDumpText(
        makeSsotArgs({
          nowMs: boardedAt + 60_000,
          boardingLock: {
            trainCode: '7152',
            boardingLine: '7',
            boardedAt,
            expectedDurationMs: 30 * 60 * 1000,
            boardingStationId: '728',
            destinationId: '2-022',
            hydratedFromSentinel: { destinationId: 'FREE_TRIP_SENTINEL', sentinelAt: 0 },
          },
        }),
      );
      const section = dump.slice(
        dump.indexOf('## BoardingLock'),
        dump.indexOf('## Estimator State'),
      );
      expect(section).toContain('sentinel=yes');
    });

    it('BoardingLock: lock 만료되었으면 active=no', () => {
      const boardedAt = new Date('2026-06-17T13:00:00Z').getTime();
      // expectedDurationMs * 1.5 = 45분. 1시간 후면 만료.
      const dump = __test__.buildDumpText(
        makeSsotArgs({
          nowMs: boardedAt + 60 * 60 * 1000,
          boardingLock: {
            trainCode: '7152',
            boardingLine: '7',
            boardedAt,
            expectedDurationMs: 30 * 60 * 1000,
            boardingStationId: '728',
            destinationId: '2-022',
          },
        }),
      );
      const section = dump.slice(
        dump.indexOf('## BoardingLock'),
        dump.indexOf('## Estimator State'),
      );
      expect(section).toContain('active=no');
      // 만료여도 lock 본문은 출력 — 진단용.
      expect(section).toContain('trainCode=7152');
    });

    it('Estimator State: 빈 buffer면 (empty) + 카운트 0', () => {
      const dump = __test__.buildDumpText(makeSsotArgs());
      expect(dump).toContain('## Estimator State (0)');
      const section = dump.slice(
        dump.indexOf('## Estimator State'),
        dump.indexOf('## Alarm log'),
      );
      expect(section).toContain('(empty)');
    });

    it('Estimator State: 2건 데이터 → 최신이 위 (Fusion log와 동일 컨벤션)', () => {
      const ts1 = new Date('2026-06-17T13:00:00Z').getTime();
      const ts2 = new Date('2026-06-17T13:00:10Z').getTime();
      const dump = __test__.buildDumpText(
        makeSsotArgs({
          estimatorLog: [
            { ts: ts1, strategy: 'default-hop', stationName: '용마산', stationLine: '7', arcIndex: 0 },
            { ts: ts2, strategy: 'reanchored-hop', stationName: '사가정', stationLine: '7', arcIndex: 1 },
          ],
        }),
      );
      expect(dump).toContain('## Estimator State (2)');
      const section = dump.slice(
        dump.indexOf('## Estimator State'),
        dump.indexOf('## Alarm log'),
      );
      const lines = section.split('\n').filter((l) => l.includes('idx='));
      expect(lines).toHaveLength(2);
      // 최신(reanchored-hop / 사가정)이 위쪽.
      expect(lines[0]).toContain('reanchored-hop');
      expect(lines[1]).toContain('default-hop');
    });

    it('Boarding Prompt: 5m/1h/all 카운터를 dump에 노출', () => {
      const now = new Date('2026-06-17T13:00:00Z').getTime();
      const dump = __test__.buildDumpText(
        makeSsotArgs({
          nowMs: now,
          logs: [
            // 1m 전 fired (5m, 1h, all 모두 +1)
            { ts: now - 60_000, source: 'boarding-prompt', outcome: 'fired', stationName: '7·용마산' },
            // 30m 전 fired (1h, all +1)
            { ts: now - 30 * 60_000, source: 'boarding-prompt', outcome: 'fired', stationName: '7·중곡' },
          ],
        }),
      );
      const section = dump.slice(
        dump.indexOf('## Boarding Prompt\n'),
        dump.indexOf('## Boarding Prompt Acceptance'),
      );
      expect(section).toContain('boardingPrompt(5m)=1');
      expect(section).toContain('boardingPrompt(1h)=2');
      expect(section).toContain('boardingPrompt(all)=2');
    });

    it('Boarding Prompt Acceptance: 응답률·탑승률 + 최근 7일 시계열', () => {
      const now = new Date('2026-06-17T13:00:00Z').getTime();
      const dump = __test__.buildDumpText(
        makeSsotArgs({
          nowMs: now,
          logs: [
            // 2 displayed, 1 boarded, 0 dismissed → responseRate=50%, boardedRate=100%
            { ts: now - 60_000, source: 'boarding-prompt', outcome: 'fired', stationName: '7·용마산' },
            { ts: now - 90_000, source: 'boarding-prompt', outcome: 'fired', stationName: '7·중곡' },
            { ts: now - 30_000, source: 'boarding-prompt', outcome: 'received', reason: 'response-boarded' },
          ],
        }),
      );
      const section = dump.slice(
        dump.indexOf('## Boarding Prompt Acceptance'),
        dump.indexOf('## Counters'),
      );
      expect(section).toContain('displayed=2');
      expect(section).toContain('responded=1');
      expect(section).toContain('boarded=1');
      expect(section).toContain('dismissed=0');
      expect(section).toContain('responseRate=50.0%');
      expect(section).toContain('boardedRate=100.0%');
      expect(section).toContain('recent 7d (day / disp / resp / brd / dis):');
      // 7일치 → 7줄 노출 (모두 출력, 0건 포함).
      const dayLines = section.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2} \|/.test(l));
      expect(dayLines).toHaveLength(7);
    });

    it('Boarding Prompt Acceptance: displayed=0이면 rate 모두 — 표기', () => {
      const dump = __test__.buildDumpText(makeSsotArgs());
      const section = dump.slice(
        dump.indexOf('## Boarding Prompt Acceptance'),
        dump.indexOf('## Counters'),
      );
      expect(section).toContain('displayed=0');
      expect(section).toContain('responseRate=—');
      expect(section).toContain('boardedRate=—');
    });

    it('Counters: 비어있으면 (empty) 출력', () => {
      const dump = __test__.buildDumpText(makeSsotArgs());
      const section = dump.slice(dump.indexOf('## Counters'));
      expect(section).toContain('(empty)');
    });

    it('Counters: reason별 누적 + 마지막 발생 시각 출력', () => {
      const ts1 = new Date('2026-06-17T13:00:00Z').getTime();
      const ts2 = new Date('2026-06-17T13:00:10Z').getTime();
      const dump = __test__.buildDumpText(
        makeSsotArgs({
          logs: [
            { ts: ts1, source: 'bg', outcome: 'suppressed', reason: 'gate-out-of-range' },
            { ts: ts2, source: 'bg', outcome: 'suppressed', reason: 'gate-out-of-range' },
            { ts: ts2, source: 'fg', outcome: 'suppressed', reason: 'movement-static-speed' },
          ],
        }),
      );
      const section = dump.slice(dump.indexOf('## Counters'));
      expect(section).toContain('gate-out-of-range=2x');
      expect(section).toContain('movement-static-speed=1x');
    });
  });

  // #1421 — PR-AutoLock-1 측정 인프라. SSOT/stability/direction/candidate 4줄 dump.
  // CPD 회피 (lesson_sonarcloud_dup_prevention): it.each + factory + wrapper 패턴.
  describe('#1421 Auto-lock Candidate 섹션', () => {
    const STABLE_SNAPSHOT = { stable: true, stationId: '0201', count: 3 };
    const PENDING_SNAPSHOT = { stable: false, stationId: '0201', count: 1 };
    const EMPTY_SNAPSHOT = { stable: false, stationId: null, count: 0 };
    const FORWARD = { matched: true, reason: 'forward' as const };
    const REVERSE = { matched: false, reason: 'reverse' as const };
    const SAMPLE_CANDIDATE = {
      candidate: { trainCode: '2001', line: '2', subwayId: '1002' },
      source: 'device-ssot' as const,
      stationId: '0201',
    };

    type AutoLockMeta = NonNullable<Parameters<typeof __test__.buildDumpText>[0]['autoLockMeta']>;
    const dumpAutoLockSection = (meta?: AutoLockMeta): string => {
      const dump = __test__.buildDumpText(
        makeSsotArgs(meta ? { autoLockMeta: meta } : undefined),
      );
      return dump.slice(dump.indexOf('## Auto-lock Candidate'));
    };

    it.each<{
      readonly name: string;
      readonly meta: AutoLockMeta | undefined;
      readonly contains: readonly string[];
    }>([
      {
        name: 'autoLockMeta 미전달 시 (n/a) 출력',
        meta: undefined,
        contains: ['(n/a)'],
      },
      {
        name: 'SSOT none + stability empty → ssot=none, candidate=null reason=no-ssot',
        meta: {
          surfaceSSOTActive: false,
          undergroundSSOTActive: false,
          stability: EMPTY_SNAPSHOT,
          direction: null,
          candidate: null,
          nullReason: 'no-ssot',
        },
        contains: ['ssot=none', 'stability=pending count=0', 'candidate=null reason=no-ssot'],
      },
      {
        name: 'surface SSOT 활성 + stability pending → reason=stability-pending',
        meta: {
          surfaceSSOTActive: true,
          undergroundSSOTActive: false,
          stability: PENDING_SNAPSHOT,
          direction: FORWARD,
          candidate: null,
          nullReason: 'stability-pending',
        },
        contains: [
          'ssot=surface',
          'stability=pending count=1 stationId=0201',
          'direction=matched reason=forward',
          'reason=stability-pending',
        ],
      },
      {
        name: 'underground SSOT 활성 + 모든 게이트 통과 → candidate 노출',
        meta: {
          surfaceSSOTActive: false,
          undergroundSSOTActive: true,
          stability: STABLE_SNAPSHOT,
          direction: FORWARD,
          candidate: SAMPLE_CANDIDATE,
          nullReason: null,
        },
        contains: [
          'ssot=underground',
          'stability=stable count=3',
          'candidate=trainCode=2001 line=2 source=device-ssot',
        ],
      },
      {
        name: '두 SSOT 모두 활성이면 ssot=surface+underground',
        meta: {
          surfaceSSOTActive: true,
          undergroundSSOTActive: true,
          stability: STABLE_SNAPSHOT,
          direction: FORWARD,
          candidate: SAMPLE_CANDIDATE,
          nullReason: null,
        },
        contains: ['ssot=surface+underground'],
      },
      {
        name: 'direction mismatch → reason=direction-mismatch',
        meta: {
          surfaceSSOTActive: true,
          undergroundSSOTActive: false,
          stability: STABLE_SNAPSHOT,
          direction: REVERSE,
          candidate: null,
          nullReason: 'direction-mismatch',
        },
        contains: ['direction=mismatch reason=reverse', 'reason=direction-mismatch'],
      },
      {
        name: 'direction=null (SSOT 미합의)이면 direction=—',
        meta: {
          surfaceSSOTActive: false,
          undergroundSSOTActive: false,
          stability: EMPTY_SNAPSHOT,
          direction: null,
          candidate: null,
          nullReason: 'no-ssot',
        },
        contains: ['direction=—'],
      },
      {
        name: 'stability stationId=null이면 stationId=— (빈 buffer)',
        meta: {
          surfaceSSOTActive: false,
          undergroundSSOTActive: false,
          stability: EMPTY_SNAPSHOT,
          direction: null,
          candidate: null,
          nullReason: 'no-ssot',
        },
        contains: ['stationId=—'],
      },
      {
        // 호출자가 inconsistent state 주입 시 graceful 표기 보장 (cascade 어디서도 분류 안 됐을 때).
        name: 'nullReason=null + candidate=null 동시(방어 fallback) → reason=—',
        meta: {
          surfaceSSOTActive: false,
          undergroundSSOTActive: false,
          stability: EMPTY_SNAPSHOT,
          direction: null,
          candidate: null,
          nullReason: null,
        },
        contains: ['candidate=null reason=—'],
      },
    ])('$name', ({ meta, contains }) => {
      const section = dumpAutoLockSection(meta);
      for (const expected of contains) {
        expect(section).toContain(expected);
      }
    });
  });

  it('DebugModal share button: fusion log buffer가 share 텍스트에 흐른다 (#1346)', async () => {
    const { pushFusionDebugEntry, clearFusionDebugEntries } = jest.requireActual(
      '../../../nearest-station/utils/fusionDebugBuffer',
    );
    clearFusionDebugEntries();
    setupHookDefaults();
    pushFusionDebugEntry({
      kind: 'sticky',
      event: 'locked',
      ts: new Date('2026-06-15T10:00:00Z').getTime(),
      stationName: '용마산',
      line: '7',
      accuracyMeters: 50,
      speedMps: 0.2,
    });

    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId('debug-share-dump'));
    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const msg = shareSpy.mock.calls[0][0].message;
    expect(msg).toContain('## Fusion log (1)');
    expect(msg).toContain('sticky:locked');
    expect(msg).toContain('용마산(7)');
    shareSpy.mockRestore();
    clearFusionDebugEntries();
  });
});

// #1421 — Auto-lock 측정 인프라 내부 헬퍼. DebugModalInner의 render-time 산출 로직 단위 검증.
describe('DebugModal helpers — #1421 auto-lock', () => {
  const { findArrivalTerminal, computeAutoLockNullReason } = __test__;

  describe('findArrivalTerminal', () => {
    it('arrival null이면 null 반환', () => {
      expect(findArrivalTerminal(null, 'X')).toBeNull();
    });

    it('matching trainCode의 destination 반환 (up 슬롯)', () => {
      const arrival: StationArrival = {
        up: [
          { ...arrivalDefaults, destination: '한성대입구', arrivalSeconds: 30, statusMessage: '', trainCode: 'T1', arrivalMinutes: 1 },
        ],
        down: [],
      };
      expect(findArrivalTerminal(arrival, 'T1')).toBe('한성대입구');
    });

    it('matching trainCode의 destination 반환 (down 슬롯)', () => {
      const arrival: StationArrival = {
        up: [],
        down: [
          { ...arrivalDefaults, destination: '오이도', arrivalSeconds: 60, statusMessage: '', trainCode: 'T2', arrivalMinutes: 1 },
        ],
      };
      expect(findArrivalTerminal(arrival, 'T2')).toBe('오이도');
    });

    it('matching trainCode 없으면 null', () => {
      const arrival: StationArrival = {
        up: [{ ...arrivalDefaults, destination: '한성대입구', arrivalSeconds: 30, statusMessage: '', trainCode: 'T1', arrivalMinutes: 1 }],
        down: [],
      };
      expect(findArrivalTerminal(arrival, 'OTHER')).toBeNull();
    });

    it('destination이 빈 문자열이면 null (falsy fallback)', () => {
      const arrival: StationArrival = {
        up: [{ ...arrivalDefaults, destination: '', arrivalSeconds: 30, statusMessage: '', trainCode: 'T1', arrivalMinutes: 1 }],
        down: [],
      };
      expect(findArrivalTerminal(arrival, 'T1')).toBeNull();
    });
  });

  describe('computeAutoLockNullReason', () => {
    it('candidate 있으면 null 반환', () => {
      expect(computeAutoLockNullReason(true, true, true, true)).toBeNull();
    });

    it('SSOT 없으면 no-ssot', () => {
      expect(computeAutoLockNullReason(false, false, false, false)).toBe('no-ssot');
    });

    it('SSOT 있고 stable 아니면 stability-pending', () => {
      expect(computeAutoLockNullReason(true, false, false, false)).toBe('stability-pending');
    });

    it('SSOT + stable이지만 direction 미일치면 direction-mismatch', () => {
      expect(computeAutoLockNullReason(true, true, false, false)).toBe('direction-mismatch');
    });

    it('3 게이트 모두 통과 + hasCandidate=false (inconsistent state) → fallback null', () => {
      // buildCandidate가 lineToSubwayId null 반환 시 도달 가능 — valid LineNumber에선 미도달.
      // 방어 fallback 분기 자체를 검증.
      expect(computeAutoLockNullReason(true, true, true, false)).toBeNull();
    });
  });
});

describe('DebugModal helpers — formatEstimatorLine (#1025)', () => {
  const { formatEstimatorLine: fmt } = __test__;
  // 3개 케이스가 동일 구조 — it.each로 묶어 CPD 토큰 반복 제거.
  it.each([
    ['strategy + station + idx 포함', { strategy: 'reanchored-hop' as const, stationName: '강남', stationLine: '2', arcIndex: 5 }, ['reanchored-hop', '강남(2)', 'idx=5']],
    ['strategy null이면 "none"으로 표기', { strategy: null, stationName: null, stationLine: null, arcIndex: null }, ['none', 'idx=-']],
    ['stationLine null이면 "-"로 표기', { strategy: 'default-hop' as const, stationName: '역삼', stationLine: null, arcIndex: 2 }, ['역삼(-)', 'idx=2']],
  ] as const)('%s', (_label, args, expected) => {
    const line = fmt({ ts: Date.now(), ...args });
    for (const token of expected) expect(line).toContain(token);
  });
});

// #1430 — Environment Distribution 측정 인프라. PR #1427 (Auto-lock) 패턴과 동일하게
// CPD 회피 (lesson_sonarcloud_dup_prevention): outer scope factory + it.each + wrapper.
describe('DebugModal helpers — #1430 environment distribution', () => {
  const { deriveEnvironmentState, formatPercentage, formatDurationMs } = __test__;

  describe('deriveEnvironmentState', () => {
    it.each([
      [{ surfaceSSOTActive: true, undergroundSSOTActive: true }, 'hybrid'],
      [{ surfaceSSOTActive: true, undergroundSSOTActive: false }, 'surface'],
      [{ surfaceSSOTActive: false, undergroundSSOTActive: true }, 'underground'],
      [{ surfaceSSOTActive: false, undergroundSSOTActive: false }, 'unknown'],
    ] as const)('%j → %p', (input, expected) => {
      expect(deriveEnvironmentState(input)).toBe(expected);
    });
  });

  describe('formatPercentage', () => {
    it.each([
      [0, '0.0%'],
      [42.3, '42.3%'],
      [100, '100.0%'],
      [99.999, '100.0%'],
    ])('%p → %p', (input, expected) => {
      expect(formatPercentage(input)).toBe(expected);
    });
  });

  describe('formatDurationMs', () => {
    it.each([
      [0, '0s'],
      [999, '0s'], // sub-second → 0s
      [58_000, '58s'],
      [60_000, '1m0s'],
      [90_500, '1m30s'],
      [3_600_000, '60m0s'],
      [1_800_000, '30m0s'],
    ])('%p ms → %p', (input, expected) => {
      expect(formatDurationMs(input)).toBe(expected);
    });
  });
});

// #1430 — buildDumpText Environment Distribution 섹션. PR #1427 Auto-lock 섹션과 동일하게
// it.each + wrapper로 CPD 회피.
describe('DebugModal buildDumpText — #1430 Environment Distribution 섹션', () => {
  type DumpArgs = Parameters<typeof __test__.buildDumpText>[0];
  type EnvSnapshot = NonNullable<DumpArgs['envDistribution']>;

  const baseDumpArgs: DumpArgs = {
    userLocation: null,
    speedMps: null,
    accuracyMeters: null,
    nearestName: null,
    nearestDistanceM: null,
    variants: [],
    fusion: baseFusion,
    arrivalSummary: '-',
    isMock: false,
    silentPush: baseSilentPush,
    logs: [],
  };

  const dumpEnvSection = (envDistribution?: EnvSnapshot): string => {
    const dump = __test__.buildDumpText({
      ...baseDumpArgs,
      ...(envDistribution ? { envDistribution } : {}),
    });
    return dump.slice(dump.indexOf('## Environment Distribution'));
  };

  it.each<{
    readonly name: string;
    readonly envDistribution: EnvSnapshot | undefined;
    readonly contains: readonly string[];
  }>([
    {
      name: 'envDistribution 미전달 시 (n/a) 출력',
      envDistribution: undefined,
      contains: ['(n/a)'],
    },
    {
      name: 'observedMs=0 + 빈 totals → 모든 state 0.0% + observed=0s',
      envDistribution: {
        totals: { surface: 0, underground: 0, hybrid: 0, unknown: 0 },
        percentages: { surface: 0, underground: 0, hybrid: 0, unknown: 0 },
        transitions: 0,
        observedMs: 0,
      },
      contains: [
        'surface=0.0% underground=0.0% hybrid=0.0% unknown=0.0%',
        'totals: surface=0s underground=0s hybrid=0s unknown=0s',
        'transitions=0',
        'observed=0s',
      ],
    },
    {
      name: '4 state 분포 (예시 시나리오) → percentages + totals + transitions + observed',
      envDistribution: {
        totals: {
          surface: 12 * 60_000 + 30_000, // 12m30s
          underground: 5 * 60_000 + 24_000, // 5m24s
          hybrid: 58_000, // 58s
          unknown: 10 * 60_000 + 54_000, // 10m54s
        },
        percentages: { surface: 42.3, underground: 18.1, hybrid: 3.2, unknown: 36.4 },
        transitions: 5,
        observedMs: 30 * 60_000 + 46_000, // 30m46s
      },
      contains: [
        'surface=42.3% underground=18.1% hybrid=3.2% unknown=36.4%',
        'totals: surface=12m30s underground=5m24s hybrid=58s unknown=10m54s',
        'transitions=5',
        'observed=30m46s',
      ],
    },
    {
      name: 'surface 100% 단일 state → 다른 state 0.0%',
      envDistribution: {
        totals: { surface: 60_000, underground: 0, hybrid: 0, unknown: 0 },
        percentages: { surface: 100, underground: 0, hybrid: 0, unknown: 0 },
        transitions: 0,
        observedMs: 60_000,
      },
      contains: ['surface=100.0% underground=0.0% hybrid=0.0% unknown=0.0%', 'transitions=0'],
    },
  ])('$name', ({ envDistribution, contains }) => {
    const section = dumpEnvSection(envDistribution);
    for (const expected of contains) {
      expect(section).toContain(expected);
    }
  });

  it('SHARE_SECTIONS에 Environment Distribution 헤더가 한 번만 등장 + Auto-lock Candidate 다음에 위치', () => {
    const dump = __test__.buildDumpText(baseDumpArgs);
    const autoLockIdx = dump.indexOf('## Auto-lock Candidate');
    const envIdx = dump.indexOf('## Environment Distribution');
    expect(autoLockIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeGreaterThan(autoLockIdx);
    // 헤더가 한 번만 노출되는지(중복 등록 회귀 방지).
    expect(dump.split('## Environment Distribution').length - 1).toBe(1);
  });
});

// #1430 — DebugModalInner render time SSOT cascade로 env counter tick → snapshot이 share dump에
// 흘러가는 통합 케이스. PR #1421 Auto-lock과 동일한 mock 패턴.
describe('DebugModal — #1430 환경 분포 share dump 통합', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupHookDefaults();
    jest.spyOn(AppState, 'addEventListener').mockReturnValue({
      remove: jest.fn(),
    } as unknown as ReturnType<typeof AppState.addEventListener>);
  });

  // SSOT 활성 → state 분류 → share text에 토큰 노출. it.each + 헬퍼로 CPD 회피.
  it.each([
    {
      name: 'surface SSOT 활성',
      surfaceSSOTActive: true,
      undergroundSSOTActive: false,
      // 첫 tick은 진입 기록만 → 누적은 0이지만 헤더와 4줄은 항상 dump.
    },
    {
      name: 'underground SSOT 활성',
      surfaceSSOTActive: false,
      undergroundSSOTActive: true,
    },
    {
      name: 'hybrid (둘 다 활성)',
      surfaceSSOTActive: true,
      undergroundSSOTActive: true,
    },
    {
      name: 'unknown (둘 다 비활성)',
      surfaceSSOTActive: false,
      undergroundSSOTActive: false,
    },
  ])('Environment Distribution 섹션이 share dump에 노출 ($name)', async ({
    surfaceSSOTActive,
    undergroundSSOTActive,
  }) => {
    mockUseFusedNearestStation.mockReturnValue(
      fusedReturnFixture({ surfaceSSOTActive, undergroundSSOTActive }),
    );
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId('debug-share-dump'));
    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const msg = shareSpy.mock.calls[0][0].message;
    expect(msg).toContain('## Environment Distribution');
    expect(msg).toContain('transitions=');
    expect(msg).toContain('observed=');
    shareSpy.mockRestore();
  });
});

describe('formatBackendCallLine — #1518', () => {
  const { formatBackendCallLine } = __test__;

  it('call entry: method/url/corrId/callId', () => {
    const line = formatBackendCallLine({
      kind: 'call',
      ts: 0,
      callId: 'cid1',
      corrId: 't-abc',
      url: 'https://api/trips',
      method: 'POST',
    });
    expect(line).toContain('CALL');
    expect(line).toContain('POST');
    expect(line).toContain('https://api/trips');
    expect(line).toContain('corrId=t-abc');
    expect(line).toContain('callId=cid1');
  });

  it('response entry: status + latency', () => {
    const line = formatBackendCallLine({
      kind: 'response',
      ts: 0,
      callId: 'cid1',
      corrId: null,
      url: 'https://api/x',
      method: 'GET',
      status: 200,
      latencyMs: 42,
    });
    expect(line).toContain('RESP');
    expect(line).toContain('status=200');
    expect(line).toContain('42ms');
    expect(line).not.toContain('corrId=');
  });

  it('response entry: status/latency 누락 시 "-"/"0ms"', () => {
    const line = formatBackendCallLine({
      kind: 'response',
      ts: 0,
      callId: 'cid1',
      corrId: null,
      url: 'https://api/x',
      method: 'GET',
    });
    expect(line).toContain('status=-');
    expect(line).toContain('0ms');
  });

  it('error entry: errorMessage + latency', () => {
    const line = formatBackendCallLine({
      kind: 'error',
      ts: 0,
      callId: 'cid1',
      corrId: 't-x',
      url: 'https://api/y',
      method: 'POST',
      latencyMs: 4999,
      errorMessage: 'aborted',
    });
    expect(line).toContain('ERR');
    expect(line).toContain('err="aborted"');
    expect(line).toContain('4999ms');
  });

  it('error entry: errorMessage 누락 시 "(no message)"', () => {
    const line = formatBackendCallLine({
      kind: 'error',
      ts: 0,
      callId: 'cid1',
      corrId: null,
      url: 'https://api/y',
      method: 'POST',
    });
    expect(line).toContain('err="(no message)"');
  });
});

describe('buildBackendCallsSection — #1518', () => {
  const { buildBackendCallsSection } = __test__;
  const baseArgs = {
    userLocation: null,
    speedMps: null,
    accuracyMeters: null,
    nearestName: null,
    nearestDistanceM: null,
    variants: [],
    fusion: {
      confidence: 'low' as const,
      source: 'gps' as const,
      fusedLabel: '',
      gpsLabel: '',
      differs: false,
      candidateTrains: null,
    },
    arrivalSummary: '',
    isMock: false,
    silentPush: {} as never,
    logs: [],
  };

  it('미전달 시 (empty) 1줄', () => {
    expect(buildBackendCallsSection(baseArgs as never)).toEqual(['(empty)']);
  });

  it('빈 배열도 (empty)', () => {
    expect(buildBackendCallsSection({ ...baseArgs, backendCalls: [] } as never)).toEqual([
      '(empty)',
    ]);
  });

  it('entries는 최신이 위로 정렬', () => {
    const result = buildBackendCallsSection({
      ...baseArgs,
      backendCalls: [
        {
          kind: 'call',
          ts: 1,
          callId: 'a',
          corrId: null,
          url: 'https://x/1',
          method: 'POST',
        },
        {
          kind: 'response',
          ts: 2,
          callId: 'a',
          corrId: null,
          url: 'https://x/1',
          method: 'POST',
          status: 200,
          latencyMs: 10,
        },
      ],
    } as never);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('RESP');
    expect(result[1]).toContain('CALL');
  });
});

// #1501 — PR-C. Raw signal 라인 포맷 + share dump 섹션 + UI 자동 표시 / Clear 통합.
describe('DebugModal — #1501 Raw Signal 섹션', () => {
  const { formatRawSignalLine, buildDumpText, RAW_SIGNAL_DISPLAY_LIMIT } = __test__;
  type RawEntry = import('../../../observability/utils/rawSignalBuffer').RawSignalEntry;

  // 단일 entry 빌더 — 테스트마다 override 필드만 지정해 표시/dump 케이스를 격리한다.
  const makeRawEntry = (overrides: Partial<RawEntry> = {}): RawEntry => ({
    ts: new Date('2026-06-19T08:00:00Z').getTime(),
    corrId: null,
    kind: 'cycle',
    gps: { lat: 37.5, lng: 127, accM: 25, speedMps: 8.3 },
    motion: 'automotive',
    subsurface: false,
    arvlCd: 99,
    line: '7',
    dir: 'up',
    arcIdx: 3,
    arcProgress: 0.42,
    stationId: '7-220',
    source: 'gps',
    confidence: 'gps-only',
    ...overrides,
  });

  describe('formatRawSignalLine', () => {
    it.each<{ readonly name: string; readonly entry: RawEntry; readonly contains: readonly string[] }>([
      {
        name: '전체 필드 채워진 cycle entry → 9개 토큰 직렬화',
        entry: makeRawEntry(),
        contains: [
          'cycle',
          '7-220',
          'gps/gps-only',
          'gps(25m/8.3m/s)',
          'automotive',
          'sub=false',
          'arvlCd=99',
          'arc=0.42',
        ],
      },
      {
        name: 'enter kind + stationId/source/confidence null → kind만 표시 + 나머지 -/—',
        entry: makeRawEntry({
          kind: 'enter',
          stationId: null,
          source: null,
          confidence: null,
          arvlCd: null,
          arcProgress: null,
        }),
        contains: ['enter', '-/-', 'arvlCd=-', 'arc=-'],
      },
      {
        name: 'gps null + motion null + subsurface true → gps(-/-)·motion=-·sub=true',
        entry: makeRawEntry({
          gps: null,
          motion: null,
          subsurface: true,
        }),
        contains: ['gps(-/-)', '| - |', 'sub=true'],
      },
      {
        name: 'gps.accM/speedMps null → 개별 토큰만 -',
        entry: makeRawEntry({
          gps: { lat: 37.5, lng: 127, accM: null, speedMps: null },
        }),
        contains: ['gps(-/-)'],
      },
      {
        name: 'subsurface null → sub=— (unknown sentinel)',
        entry: makeRawEntry({ subsurface: null }),
        contains: ['sub=—'],
      },
      {
        name: 'exit kind + arvlCd=0 → arvlCd=0 (truthy 분기 회귀 방지)',
        entry: makeRawEntry({ kind: 'exit', arvlCd: 0, arcProgress: 0 }),
        contains: ['exit', 'arvlCd=0', 'arc=0.00'],
      },
    ])('$name', ({ entry, contains }) => {
      const line = formatRawSignalLine(entry);
      for (const expected of contains) {
        expect(line).toContain(expected);
      }
    });
  });

  describe('buildDumpText ## Raw Signal', () => {
    const dumpRawSection = (rawSignalLog?: readonly RawEntry[]): string => {
      const dump = buildDumpText(
        makeDumpArgs(rawSignalLog === undefined ? {} : { rawSignalLog }),
      );
      return dump.slice(dump.indexOf('## Raw Signal'));
    };

    it('rawSignalLog 미전달 → 헤더(0) + (empty)', () => {
      const section = dumpRawSection();
      expect(section).toContain('## Raw Signal (0)');
      expect(section).toContain('(empty)');
    });

    it('빈 배열도 (empty) 출력 (Fusion log 컨벤션)', () => {
      const section = dumpRawSection([]);
      expect(section).toContain('## Raw Signal (0)');
      expect(section).toContain('(empty)');
    });

    it('3건 → 최신이 위 (역순) + suffix는 buffer 전체 길이', () => {
      const entries: RawEntry[] = [
        makeRawEntry({ ts: 1000, stationId: 'A' }),
        makeRawEntry({ ts: 2000, stationId: 'B' }),
        makeRawEntry({ ts: 3000, stationId: 'C' }),
      ];
      const section = dumpRawSection(entries);
      expect(section).toContain('## Raw Signal (3)');
      const stationCIdx = section.indexOf('| C |');
      const stationBIdx = section.indexOf('| B |');
      const stationAIdx = section.indexOf('| A |');
      expect(stationCIdx).toBeGreaterThan(-1);
      expect(stationCIdx).toBeLessThan(stationBIdx);
      expect(stationBIdx).toBeLessThan(stationAIdx);
    });

    it(`상위 ${RAW_SIGNAL_DISPLAY_LIMIT}건만 dump (overflow 분리)`, () => {
      const entries: RawEntry[] = Array.from({ length: RAW_SIGNAL_DISPLAY_LIMIT + 5 }, (_, i) =>
        makeRawEntry({ ts: i * 1000, stationId: `S${i}` }),
      );
      const dump = buildDumpText(makeDumpArgs({ rawSignalLog: entries }));
      // suffix는 buffer 전체 (35) — display limit과 분리.
      expect(dump).toContain(`## Raw Signal (${RAW_SIGNAL_DISPLAY_LIMIT + 5})`);
      const section = dump.slice(dump.indexOf('## Raw Signal'));
      // 가장 오래된 entry(S0)는 dump에서 잘림.
      expect(section).not.toContain('| S0 |');
      // 가장 최신(S34)은 포함.
      expect(section).toContain(`| S${RAW_SIGNAL_DISPLAY_LIMIT + 4} |`);
    });

    it('SHARE_SECTIONS에 Raw Signal 헤더 1회 + Environment Distribution 다음에 위치', () => {
      const dump = buildDumpText(makeDumpArgs());
      const envIdx = dump.indexOf('## Environment Distribution');
      const rawIdx = dump.indexOf('## Raw Signal');
      expect(envIdx).toBeGreaterThan(-1);
      expect(rawIdx).toBeGreaterThan(envIdx);
      expect(dump.split('## Raw Signal').length - 1).toBe(1);
    });
  });

  describe('DebugModal UI 자동 표시 + Clear', () => {
    const {
      pushRawSignal,
      clearRawSignalEntries,
      __resetRawSignalForTests__,
    } = jest.requireActual('../../../observability/utils/rawSignalBuffer');

    beforeEach(() => {
      jest.clearAllMocks();
      __resetRawSignalForTests__();
      setupHookDefaults();
      jest.spyOn(AppState, 'addEventListener').mockReturnValue({
        remove: jest.fn(),
      } as unknown as ReturnType<typeof AppState.addEventListener>);
    });

    afterEach(() => {
      __resetRawSignalForTests__();
    });

    it('모달 진입 시 buffer 스냅샷 표시 (toggle 없음, 직전 entry 자동 노출)', async () => {
      pushRawSignal(makeRawEntry({ ts: 1000, stationId: 'PRE-MOUNT' }));
      renderWithTheme(<DebugModal onClose={jest.fn()} />);
      await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
      expect(screen.getByText('Raw Signal (1)')).toBeTruthy();
      const entries = screen.getAllByTestId('debug-raw-signal-entry');
      expect(entries[0].props.children).toContain('PRE-MOUNT');
    });

    it('마운트 이후 push 시 listener가 UI 갱신', async () => {
      renderWithTheme(<DebugModal onClose={jest.fn()} />);
      await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
      expect(screen.getByText('Raw Signal (0)')).toBeTruthy();
      act(() => {
        pushRawSignal(makeRawEntry({ ts: 5000, stationId: 'POST-MOUNT' }));
      });
      expect(screen.getByText('Raw Signal (1)')).toBeTruthy();
      const entries = screen.getAllByTestId('debug-raw-signal-entry');
      expect(entries[0].props.children).toContain('POST-MOUNT');
    });

    it('Clear 버튼이 buffer와 UI를 동시에 비운다', async () => {
      pushRawSignal(makeRawEntry({ stationId: 'TO-CLEAR' }));
      renderWithTheme(<DebugModal onClose={jest.fn()} />);
      await waitFor(() => expect(screen.getByText('Raw Signal (1)')).toBeTruthy());
      act(() => {
        fireEvent.press(screen.getByTestId('debug-raw-signal-clear'));
      });
      expect(screen.getByText('Raw Signal (0)')).toBeTruthy();
      // buffer SSOT까지 비웠는지 확인 — getRawSignalEntries는 listener와 동일 buffer.
      const { getRawSignalEntries } = jest.requireActual(
        '../../../observability/utils/rawSignalBuffer',
      );
      expect(getRawSignalEntries()).toEqual([]);
      // 직접 clearRawSignalEntries도 호출 가능(idempotent 확인).
      clearRawSignalEntries();
      expect(getRawSignalEntries()).toEqual([]);
    });

    it('share dump가 SSOT raw signal entries를 포함한다', async () => {
      pushRawSignal(makeRawEntry({ stationId: 'SHARE-INTEGRATION' }));
      const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
      renderWithTheme(<DebugModal onClose={jest.fn()} />);
      await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText('Raw Signal (1)')).toBeTruthy());
      fireEvent.press(screen.getByTestId('debug-share-dump'));
      await waitFor(() => expect(shareSpy).toHaveBeenCalled());
      const msg = shareSpy.mock.calls[0][0].message;
      expect(msg).toContain('## Raw Signal (1)');
      expect(msg).toContain('SHARE-INTEGRATION');
      shareSpy.mockRestore();
    });
  });

  // #1540 (S7) — gps-drop 별 buffer. fusion log cap 점령 회귀 차단용 별 채널.
  describe('GPS drops 섹션 (#1540)', () => {
    const { formatGpsDropLine, buildGpsDropLogSection, buildDumpText } = __test__;
    type DropEntry = import('../../../nearest-station/utils/gpsDropBuffer').GpsDropEntry;

    const makeDrop = (overrides: Partial<DropEntry> = {}): DropEntry => ({
      ts: 1_700_000_000_000,
      lat: 37.5,
      lng: 127,
      accuracyMeters: 1414,
      speedMps: null,
      dropReason: 'low-accuracy-display',
      ...overrides,
    });

    it('formatGpsDropLine: acc/speed/reason 모두 노출', () => {
      const line = formatGpsDropLine(
        makeDrop({ accuracyMeters: 1414, speedMps: 1.5, dropReason: 'low-accuracy-display' }),
      );
      expect(line).toContain('gps-drop');
      expect(line).toContain('acc=1414m');
      expect(line).toContain('sp=1.5m/s');
      expect(line).toContain('reason=low-accuracy-display');
    });

    it('formatGpsDropLine: null acc/speed는 "-"로 표기', () => {
      const line = formatGpsDropLine(
        makeDrop({ accuracyMeters: null, speedMps: null, dropReason: 'rate-limited:5' }),
      );
      expect(line).toContain('acc=-');
      expect(line).toContain('sp=-');
      expect(line).toContain('reason=rate-limited:5');
    });

    it('buildGpsDropLogSection: 미전달/빈 배열 모두 (empty)', () => {
      expect(buildGpsDropLogSection(baselineDumpArgs)).toEqual(['(empty)']);
      expect(
        buildGpsDropLogSection({ ...baselineDumpArgs, gpsDropLog: [] }),
      ).toEqual(['(empty)']);
    });

    it('buildGpsDropLogSection: 최신이 위로 정렬', () => {
      const result = buildGpsDropLogSection({
        ...baselineDumpArgs,
        gpsDropLog: [
          makeDrop({ ts: 1000, accuracyMeters: 800 }),
          makeDrop({ ts: 2000, accuracyMeters: 900 }),
        ],
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('acc=900m');
      expect(result[1]).toContain('acc=800m');
    });

    it('share dump가 GPS drops 섹션을 포함한다 (suffix는 buffer 길이)', () => {
      const dump = buildDumpText(
        makeDumpArgs({
          gpsDropLog: [makeDrop({ accuracyMeters: 1234 })],
        }),
      );
      expect(dump).toContain('## GPS drops (1)');
      expect(dump).toContain('acc=1234m');
    });

    it('share dump: gpsDropLog 미전달 시 헤더(0) + (empty)', () => {
      const dump = buildDumpText(makeDumpArgs());
      expect(dump).toContain('## GPS drops (0)');
      const section = dump.slice(dump.indexOf('## GPS drops'));
      expect(section).toContain('(empty)');
    });

    it('UI: 비어있으면 (0) 표시, push 시 entry 노출, Clear가 비운다', async () => {
      const {
        clearGpsDropEntries,
        pushGpsDropEntry,
      } = jest.requireActual('../../../nearest-station/utils/gpsDropBuffer');
      clearGpsDropEntries();
      renderWithTheme(<DebugModal onClose={jest.fn()} />);
      await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
      expect(screen.getByText('GPS drops (0)')).toBeTruthy();
      act(() => {
        pushGpsDropEntry({
          ts: new Date('2026-06-19T15:42:00Z').getTime(),
          lat: 37.5,
          lng: 127,
          accuracyMeters: 1414,
          speedMps: null,
          dropReason: 'low-accuracy-display',
        });
      });
      expect(screen.getByText('GPS drops (1)')).toBeTruthy();
      const entries = screen.getAllByTestId('debug-gps-drop-log-entry');
      expect(entries[0].props.children).toContain('acc=1414m');
      act(() => {
        fireEvent.press(screen.getByTestId('debug-gps-drop-log-clear'));
      });
      expect(screen.getByText('GPS drops (0)')).toBeTruthy();
    });
  });
});
