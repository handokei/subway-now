import React from 'react';
import { AppState, Share } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { DebugModal, __test__ } from '../DebugModal';
import { renderWithTheme } from '../../testUtils/renderWithTheme';
import type { AlarmLogEntry } from '../../utils/alarmLog';
import type { Station, NearestStationResult } from '../../types/station';
import type { StationArrival } from '../../api/arrivalApi';

const mockUseFusedNearestStation = jest.fn();
const mockUseArrivalInfo = jest.fn();
const mockGetAlarmLog = jest.fn();
const mockClearAlarmLog = jest.fn();

jest.mock('../../hooks/useFusedNearestStation', () => ({
  useFusedNearestStation: () => mockUseFusedNearestStation(),
}));
jest.mock('../../hooks/useArrivalInfo', () => ({
  useArrivalInfo: (name: string | null) => mockUseArrivalInfo(name),
}));
jest.mock('../../utils/alarmLog', () => {
  const actual = jest.requireActual('../../utils/alarmLog');
  return {
    ...actual,
    getAlarmLog: () => mockGetAlarmLog(),
    clearAlarmLog: () => mockClearAlarmLog(),
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
const arrivalDefaults = {
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
    userLocation: { lat: 37.5, lng: 127.0 },
    speedMps: 1.5,
    accuracyMeters: 20,
    loading: false,
    error: null,
    permissionDenied: false,
    refresh: jest.fn(),
  });
  mockUseArrivalInfo.mockReturnValue({ arrival: baseArrival, loading: false, isMock: false });
  mockGetAlarmLog.mockResolvedValue([]);
  mockClearAlarmLog.mockResolvedValue(undefined);
};

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
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    expect(screen.getByText('GPS')).toBeTruthy();
    expect(screen.getByText('Nearest station')).toBeTruthy();
    expect(screen.getByText('Arrival')).toBeTruthy();
    expect(screen.getByText('Alarm log (1)')).toBeTruthy();
    expect(screen.getByTestId('debug-arrival-summary').props.children).toContain('청량리');
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
      userLocation: { lat: 37.5, lng: 127.0 },
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
    expect(screen.getByText('(empty)')).toBeTruthy();
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
      userLocation: { lat: 37.5, lng: 127.0 },
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
      userLocation: { lat: 37.5, lng: 127.0 },
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

  it('unmount 시 AppState listener를 정리한다', async () => {
    const { unmount } = renderWithTheme(<DebugModal onClose={jest.fn()} />);
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
    unmount();
    expect(appStateRemove).toHaveBeenCalled();
  });
});

describe('DebugModal helpers', () => {
  it('formatLogLine: location 포함 suppressed 엔트리', () => {
    const entry: AlarmLogEntry = {
      ts: new Date('2026-05-12T10:00:00Z').getTime(),
      source: 'bg',
      outcome: 'suppressed',
      reason: 'gate-accuracy',
      location: { lat: 37.5, lng: 127.0, accuracy: 80, ageMs: 1500 },
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

  it('formatLogLine: #372 stamp 필드가 채워지면 dir/train/eta/exp/last를 표기한다', () => {
    const entry: AlarmLogEntry = {
      ts: Date.now(),
      source: 'bg-scheduled',
      outcome: 'fired',
      phaseId: 'early',
      kind: 'destination',
      stationName: '강남',
      direction: 'up',
      usedTrainCode: 'T-42',
      selectedArrivalSeconds: 600,
      expectedStationAtFire: '강남',
      actualLastNotifiedStation: '시청',
    };
    const line = __test__.formatLogLine(entry);
    expect(line).toContain('bg-scheduled');
    expect(line).toContain('dir=up');
    expect(line).toContain('train=T-42');
    expect(line).toContain('eta=600s');
    expect(line).toContain('exp=강남');
    expect(line).toContain('last=시청');
  });

  it('formatLogLine: stamp 필드가 null/미존재면 추가 토큰이 붙지 않는다', () => {
    const entry: AlarmLogEntry = {
      ts: Date.now(),
      source: 'bg-scheduled',
      outcome: 'fired',
      direction: null,
      usedTrainCode: null,
      selectedArrivalSeconds: null,
      expectedStationAtFire: null,
      actualLastNotifiedStation: null,
    };
    const line = __test__.formatLogLine(entry);
    expect(line).not.toContain('dir=');
    expect(line).not.toContain('train=');
    expect(line).not.toContain('eta=');
    expect(line).not.toContain('exp=');
    expect(line).not.toContain('last=');
  });

  it('formatLogLine: selectedArrivalSeconds=0이어도 eta=0s로 표기 (0과 null 구분)', () => {
    const entry: AlarmLogEntry = {
      ts: Date.now(),
      source: 'bg-scheduled',
      outcome: 'fired',
      selectedArrivalSeconds: 0,
    };
    expect(__test__.formatLogLine(entry)).toContain('eta=0s');
  });

  it('formatLogLine: accuracy null이면 "-"로 표기', () => {
    const entry: AlarmLogEntry = {
      ts: Date.now(),
      source: 'bg',
      outcome: 'suppressed',
      reason: 'gate-age',
      location: { lat: 37.5, lng: 127.0, accuracy: null, ageMs: 5000 },
    };
    expect(__test__.formatLogLine(entry)).toContain('acc=-');
  });

  const baseFusion = {
    confidence: 'gps-only' as const,
    source: 'gps' as const,
    fusedLabel: '강남(2) · 123m',
    gpsLabel: '강남(2) · 123m',
    differs: false,
    candidateTrains: null as string[] | null,
  };

  it('buildDumpText: 모든 섹션 포함', () => {
    const dump = __test__.buildDumpText({
      userLocation: { lat: 37.5, lng: 127.0 },
      speedMps: 2,
      accuracyMeters: 30,
      nearestName: '강남',
      nearestDistanceM: 123,
      variants: ['강남(2)'],
      fusion: baseFusion,
      arrivalSummary: 'up: 청량리 · 90s',
      isMock: true,
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
      userLocation: { lat: 37.5, lng: 127.0 },
      speedMps: 2,
      accuracyMeters: 30,
      nearestName: '강남',
      nearestDistanceM: 123,
      variants: [],
      fusion: { ...baseFusion, fusedLabel: '역삼(2) · 200m', differs: true },
      arrivalSummary: 'x',
      isMock: false,
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
      logs: [],
    });
    expect(dump).toContain('(no location)');
    expect(dump).toContain('(no nearest station)');
    expect(dump).not.toContain('variants:');
    expect(dump).not.toContain('(MOCK)');
    expect(dump).not.toContain('candidateTrains');
    expect(dump).toContain('## Alarm log (0)');
  });

  it('buildDumpText: userLocation은 있고 speedMps/accuracy만 null이면 "-" 표기', () => {
    const dump = __test__.buildDumpText({
      userLocation: { lat: 37.5, lng: 127.0 },
      speedMps: null,
      accuracyMeters: null,
      nearestName: '강남',
      nearestDistanceM: null,
      variants: [],
      fusion: baseFusion,
      arrivalSummary: 'x',
      isMock: false,
      logs: [],
    });
    expect(dump).toContain('speed=- m/s');
    expect(dump).toContain('accuracy=- m');
    expect(dump).toContain('강남 · - m');
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
    userLocation: { lat: 37.5, lng: 127.0 },
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
