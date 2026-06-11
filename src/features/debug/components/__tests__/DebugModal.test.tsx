import React from 'react';
import { AppState, Share } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { DebugModal, __test__ } from '../DebugModal';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import {
  countGateReasons,
  type AlarmLogEntry,
} from '../../../../features/alarm/utils/alarmLog';
import type { Station, NearestStationResult } from '../../../../shared/types/station';
import type { StationArrival } from '../../../../shared/types/arrival';

const mockUseFusedNearestStation = jest.fn();
const mockUseArrivalInfo = jest.fn();
const mockUseSilentPushDiagnostics = jest.fn();
const mockGetAlarmLog = jest.fn();
const mockClearAlarmLog = jest.fn();

jest.mock('../../../nearest-station/hooks/useFusedNearestStation', () => ({
  useFusedNearestStation: () => mockUseFusedNearestStation(),
}));
jest.mock('../../../arrival/hooks/useArrivalInfo', () => ({
  useArrivalInfo: (name: string | null) => mockUseArrivalInfo(name),
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
    mockUseFusedNearestStation.mockReturnValue({
      result: null,
      gpsResult: null,
      confidence: 'gps-only',
      source: 'gps',
      variants: [],
      userLocation: null,
      speedMps: null,
      accuracyMeters: null,
      loading: false,
      error: null,
      permissionDenied: false,
      refresh: jest.fn(),
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('(no location)')).toBeTruthy();
    expect(screen.getByText('(no nearest)')).toBeTruthy();
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
    mockUseFusedNearestStation.mockReturnValue({
      result: baseResult,
      gpsResult: baseResult,
      confidence: 'gps-only',
      source: 'gps',
      variants: [],
      userLocation: { lat: 37.5, lng: 127 },
      speedMps: null,
      accuracyMeters: null,
      loading: false,
      error: null,
      permissionDenied: false,
      refresh: jest.fn(),
    });
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
    mockUseFusedNearestStation.mockReturnValue({
      result: baseResult,
      gpsResult: baseResult,
      confidence: 'arrival-confirmed',
      source: 'arrival',
      variants: [],
      userLocation: { lat: 37.5, lng: 127 },
      speedMps: 1,
      accuracyMeters: 12,
      loading: false,
      error: null,
      permissionDenied: false,
      refresh: jest.fn(),
    });
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
    mockUseFusedNearestStation.mockReturnValue({
      result: { station, distanceKm: 0.05 },
      gpsResult: { station: otherStation, distanceKm: 0.18 },
      confidence: 'arrival-arriving',
      source: 'arrival',
      variants: [],
      userLocation: { lat: 37.5, lng: 127 },
      speedMps: 1,
      accuracyMeters: 10,
      loading: false,
      error: null,
      permissionDenied: false,
      refresh: jest.fn(),
    });
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

describe('DebugModal arrival edge cases', () => {
  const baseHooks = {
    result: baseResult,
    gpsResult: baseResult,
    confidence: 'gps-only' as const,
    source: 'gps' as const,
    variants: [],
    userLocation: { lat: 37.5, lng: 127 },
    speedMps: 1,
    accuracyMeters: 15,
    loading: false,
    error: null,
    permissionDenied: false,
    refresh: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAlarmLog.mockResolvedValue([]);
    mockUseFusedNearestStation.mockReturnValue(baseHooks);
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
    mockUseFusedNearestStation.mockReturnValue({
      result: null,
      gpsResult: null,
      confidence: 'gps-only',
      source: 'gps',
      variants: [],
      userLocation: null,
      speedMps: null,
      accuracyMeters: null,
      loading: false,
      error: null,
      permissionDenied: false,
      refresh: jest.fn(),
    });
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

  it('초기 마운트 상태에서는 "(tap Refresh to load)" placeholder', () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    expect(screen.getByText('(tap Refresh to load)')).toBeTruthy();
    expect(screen.getByText('Scheduled queue')).toBeTruthy();
  });

  it('Refresh 누르면 dumpScheduledNotifications 호출 + 빈 결과면 "(empty)" 표시', async () => {
    mockDumpScheduledNotifications.mockResolvedValue([]);
    renderWithTheme(<DebugModal onClose={jest.fn()} />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('debug-scheduled-dump-refresh'));
    });

    await waitFor(() => expect(screen.getByText('Scheduled queue (0)')).toBeTruthy());
    // "(empty)"는 Alarm log 섹션에도 등장 (logs=[])하므로 getByText 다중매칭 회피 — 카운트만 검증.
    expect(screen.getAllByText('(empty)').length).toBeGreaterThanOrEqual(1);
    expect(mockDumpScheduledNotifications).toHaveBeenCalledTimes(1);
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
    mockUseFusedNearestStation.mockReturnValue({
      result: baseResult,
      gpsResult: baseResult,
      confidence: 'gps-only',
      source: 'gps',
      variants: [],
      userLocation: { lat: 37.5, lng: 127.0 },
      speedMps: null,
      accuracyMeters: 12,
      loading: false,
      error: null,
      permissionDenied: false,
      refresh: jest.fn(),
    });
    renderWithTheme(
      <DebugModal onClose={jest.fn()} fusedSpeed={{ kmh: 18, source: 'position-train' }} />,
    );
    // GPS speed가 "-"로 노출되더라도 fused 라인이 별도로 사용자 인지 가능해야 함.
    expect(await screen.findByText('18.0 km/h (position-train)')).toBeTruthy();
  });
});

describe('DebugModal — BoardingLock 섹션 (#1025)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupHookDefaults();
  });

  it('lock이 없으면 active=no를 표시한다', async () => {
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('BoardingLock')).toBeTruthy();
    expect(screen.getByText('no')).toBeTruthy();
  });

  it('lock이 활성이면 active=yes + trainCode/line을 표시한다', async () => {
    const { useBoardingLockStore } = jest.requireActual('../../../alarm/store/useBoardingLockStore');
    act(() => {
      useBoardingLockStore.setState({
        lock: {
          destinationId: 'dest-1',
          trainCode: 'T-101',
          boardingStationId: 'stn-1',
          boardingLine: '2',
          boardedAt: Date.now(),
          expectedDurationMs: 30 * 60 * 1000,
        },
      });
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('T-101')).toBeTruthy();
    expect(screen.getByText('yes')).toBeTruthy();
    act(() => {
      useBoardingLockStore.setState({ lock: null });
    });
  });

  it('lock이 sentinel이면 sentinel=yes를 표시한다', async () => {
    const { useBoardingLockStore } = jest.requireActual('../../../alarm/store/useBoardingLockStore');
    act(() => {
      useBoardingLockStore.setState({
        lock: {
          destinationId: 'FREE_TRIP_SENTINEL',
          trainCode: 'T-999',
          boardingStationId: 'stn-2',
          boardingLine: '7',
          boardedAt: Date.now(),
          expectedDurationMs: 30 * 60 * 1000,
          hydratedFromSentinel: {
            destinationId: 'FREE_TRIP_SENTINEL',
            sentinelAt: Date.now(),
          },
        },
      });
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('sentinel')).toBeTruthy();
    act(() => {
      useBoardingLockStore.setState({ lock: null });
    });
  });
});

describe('DebugModal — Estimator State 섹션 (#1025)', () => {
  const { pushEstimatorEntry, clearEstimatorEntries } =
    jest.requireActual('../../../route/utils/estimatorDebugBuffer');

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
    act(() => {
      pushEstimatorEntry({
        ts: new Date('2026-06-01T10:00:00Z').getTime(),
        strategy: 'live-position',
        stationName: '강남',
        stationLine: '2',
        arcIndex: 3,
      });
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Estimator State (1)')).toBeTruthy());
    const entries = screen.getAllByTestId('debug-estimator-entry');
    expect(entries[0].props.children).toContain('live-position');
    expect(entries[0].props.children).toContain('강남(2)');
    expect(entries[0].props.children).toContain('idx=3');
  });

  it('Clear 버튼이 estimator 로그를 비운다', async () => {
    act(() => {
      pushEstimatorEntry({
        ts: Date.now(),
        strategy: 'default-hop',
        stationName: '역삼',
        stationLine: '2',
        arcIndex: 1,
      });
    });
    renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Estimator State (1)')).toBeTruthy());
    act(() => {
      fireEvent.press(screen.getByTestId('debug-estimator-clear'));
    });
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
    expect(screen.getByText('gate-out-of-range')).toBeTruthy();
    expect(screen.getByText('movement-static-speed')).toBeTruthy();
  });
});

describe('DebugModal helpers — countGateReasons (#1025)', () => {
  it('매칭 없으면 빈 객체 반환', () => {
    expect(countGateReasons([], ['gate-age', 'gate-accuracy'] as never[])).toEqual({});
  });

  it('매칭되는 reason만 집계한다', () => {
    const logs: AlarmLogEntry[] = [
      { ts: 1, source: 'bg', outcome: 'suppressed', reason: 'gate-out-of-range' },
      { ts: 2, source: 'bg', outcome: 'suppressed', reason: 'gate-out-of-range' },
      { ts: 3, source: 'fg', outcome: 'suppressed', reason: 'movement-static-speed' },
      { ts: 4, source: 'fg', outcome: 'fired' }, // reason 없음 — 집계 안 됨
      { ts: 5, source: 'bg', outcome: 'suppressed', reason: 'dedup-station' }, // 목록 밖 — 집계 안 됨
    ];
    const result = countGateReasons(logs, ['gate-out-of-range', 'movement-static-speed'] as never[]);
    expect(result).toEqual({ 'gate-out-of-range': 2, 'movement-static-speed': 1 });
  });
});

describe('DebugModal helpers — formatEstimatorLine (#1025)', () => {
  const { formatEstimatorLine: fmt } = __test__;

  it('strategy + station + idx 포함', () => {
    const line = fmt({
      ts: new Date('2026-06-01T10:00:00Z').getTime(),
      strategy: 'reanchored-hop',
      stationName: '강남',
      stationLine: '2',
      arcIndex: 5,
    });
    expect(line).toContain('reanchored-hop');
    expect(line).toContain('강남(2)');
    expect(line).toContain('idx=5');
  });

  it('strategy null이면 "none"으로 표기', () => {
    const line = fmt({
      ts: Date.now(),
      strategy: null,
      stationName: null,
      stationLine: null,
      arcIndex: null,
    });
    expect(line).toContain('none');
    expect(line).toContain('idx=-');
  });

  it('stationLine null이면 "-"로 표기', () => {
    const line = fmt({
      ts: Date.now(),
      strategy: 'default-hop',
      stationName: '역삼',
      stationLine: null,
      arcIndex: 2,
    });
    expect(line).toContain('역삼(-)');
    expect(line).toContain('idx=2');
  });
});
