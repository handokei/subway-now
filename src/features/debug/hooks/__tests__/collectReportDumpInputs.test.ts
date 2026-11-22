/**
 * #3366 — report 모드(버그 신고 자동 첨부) dump 입력 수집.
 * 원칙: 순수 읽기만. watch·폴링·센서 구독·네트워크를 새로 띄우지 않는다(관찰자 효과 차단).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { collectReportDumpInputs } from '../useDebugDumpInputs';
import { hashTripToken } from '../../../../shared/infra/monitoring/tripTokenHash';
import {
  ACTIVE_TRIP_KEY,
  APNS_TOKEN_KEY,
} from '../../../../shared/constants/storageKeys';
import { deviceLocalTripId } from '../../../alarm/utils/safetyNetScheduler';
import { useBoardingLockStore } from '../../../alarm/store/useBoardingLockStore';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import { useDestinationStore } from '../../../route/store/useDestinationStore';

const mockReadSilentPushDiagnostics = jest.fn();
jest.mock('../../../alarm/hooks/useSilentPushDiagnostics', () => ({
  useSilentPushDiagnostics: jest.fn(),
  readSilentPushDiagnostics: () => mockReadSilentPushDiagnostics(),
}));

const mockGetTripStartedAt = jest.fn();
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  ...jest.requireActual('../../../alarm/utils/tripStartStorage'),
  getTripStartedAt: () => mockGetTripStartedAt(),
}));

const mockDumpScheduled = jest.fn();
jest.mock('../../../alarm/utils/scheduledNotificationsDump', () => ({
  ...jest.requireActual('../../../alarm/utils/scheduledNotificationsDump'),
  dumpScheduledNotifications: () => mockDumpScheduled(),
}));

// 부수효과 훅/모듈 — report 모드는 이들을 건드리지 않아야 한다.
const mockWatchPositionAsync = jest.fn();
jest.mock('expo-location', () => ({
  watchPositionAsync: (...a: unknown[]) => mockWatchPositionAsync(...a),
  Accuracy: {},
}));
const mockUseFused = jest.fn();
jest.mock('../../../nearest-station/hooks/useFusedNearestStation', () => ({
  useFusedNearestStation: (...a: unknown[]) => mockUseFused(...a),
}));
const mockUseArrival = jest.fn();
jest.mock('../../../arrival/hooks/useArrivalInfo', () => ({
  useArrivalInfo: (...a: unknown[]) => mockUseArrival(...a),
}));
const mockUseBarometer = jest.fn();
jest.mock('../../../../shared/hooks/useBarometer', () => ({
  useBarometer: (...a: unknown[]) => mockUseBarometer(...a),
}));
const mockUseLowPower = jest.fn();
jest.mock('../../../../shared/hooks/useLowPowerMode', () => ({
  useLowPowerMode: (...a: unknown[]) => mockUseLowPower(...a),
}));
const mockUseArchFlag = jest.fn();
jest.mock('../../../../shared/config/useArchFlagRemote', () => ({
  useArchFlagRemote: (...a: unknown[]) => mockUseArchFlag(...a),
}));

const APNS = '3f9a1c7be24d5086a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
const ACTIVE = '9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d';
const TRIP_START = 1_795_305_300_000;

const DIAG = {
  apnsToken: APNS,
  activeTripToken: ACTIVE,
  apnsEnv: 'production',
  apnsEnvStamped: 'production',
  permissionStatus: null,
  taskRegistrationState: 'unknown',
  taskRegistrationError: null,
  lastReceivedAt: null,
  lastFiredAt: null,
  lastSkippedAt: null,
  hasRoute: true,
  destinationId: '2-222',
  lastNotifiedStationId: null,
};

describe('collectReportDumpInputs (#3366)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockReadSilentPushDiagnostics.mockResolvedValue(DIAG);
    mockGetTripStartedAt.mockResolvedValue(TRIP_START);
    mockDumpScheduled.mockResolvedValue([]);
    await AsyncStorage.setItem(APNS_TOKEN_KEY, APNS);
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, ACTIVE);
    useBoardingLockStore.setState({ lock: null });
    useSettingsStore.setState({ sleepMode: true });
    useDestinationStore.setState({ destination: null, tripOrigin: null });
  });

  it('GPS·fusion·arrival은 report 모드 표기(n/a)로 채우고 좌표를 내지 않는다', async () => {
    const { args } = await collectReportDumpInputs();
    expect(args.userLocation).toBeNull();
    expect(args.speedMps).toBeNull();
    expect(args.accuracyMeters).toBeNull();
    expect(args.fusion.confidence).toBe('n/a(report)');
    expect(args.fusion.source).toBe('n/a(report)');
    expect(args.arrivalSummary).toBe('n/a(report)');
    expect(args.nearestName).toBeNull();
    expect(args.isMock).toBe(false);
  });

  it('trip·sleep은 store/AsyncStorage 읽기로 대체한다', async () => {
    const { args } = await collectReportDumpInputs();
    expect(args.trip).toMatchObject({ lockless: false, tripStartedAt: TRIP_START });
    expect(args.sleep).toEqual({ sleepMode: true, firstHopApproaching: false });
    expect(args.silentPush).toEqual(DIAG);
  });

  it('destination이 있고 lock이 없으면 lockless trip', async () => {
    useDestinationStore.setState({
      destination: { id: '2-222', name: '잠실', line: '2', lineColor: '#000', lat: 0, lng: 0 },
    });
    const { args } = await collectReportDumpInputs();
    expect(args.trip?.lockless).toBe(true);
  });

  it('tokens = APNS · 활성 trip token · device-local trip id', async () => {
    const { tokens } = await collectReportDumpInputs();
    expect(tokens).toEqual(expect.arrayContaining([APNS, ACTIVE, deviceLocalTripId(TRIP_START)]));
    expect(tokens).toHaveLength(3);
  });

  it('tripKey = hashTripToken(APNS token) — 원본 token을 내보내지 않는다', async () => {
    const { tripKey } = await collectReportDumpInputs();
    expect(tripKey).toBe(hashTripToken(APNS));
    expect(tripKey).not.toBe(APNS);
  });

  it('APNS token 없음 → tripKey null, tokens에서도 빠진다', async () => {
    await AsyncStorage.removeItem(APNS_TOKEN_KEY);
    mockReadSilentPushDiagnostics.mockResolvedValue({ ...DIAG, apnsToken: null });
    const { tripKey, tokens } = await collectReportDumpInputs();
    expect(tripKey).toBeNull();
    expect(tokens).not.toContain(APNS);
  });

  it('trip 시작 시각·활성 trip token 모두 없으면 tokens는 APNS만', async () => {
    mockGetTripStartedAt.mockResolvedValue(null);
    await AsyncStorage.removeItem(ACTIVE_TRIP_KEY);
    const { tokens } = await collectReportDumpInputs();
    expect(tokens).toEqual([APNS]);
  });

  it('부수효과 모듈(watchPositionAsync·fusion/arrival/barometer/lowPower/archFlag 훅)을 호출하지 않는다', async () => {
    await collectReportDumpInputs();
    expect(mockWatchPositionAsync).not.toHaveBeenCalled();
    expect(mockUseFused).not.toHaveBeenCalled();
    expect(mockUseArrival).not.toHaveBeenCalled();
    expect(mockUseBarometer).not.toHaveBeenCalled();
    expect(mockUseLowPower).not.toHaveBeenCalled();
    expect(mockUseArchFlag).not.toHaveBeenCalled();
  });

  it('도착정보 등 네트워크 fetch를 하지 않는다', async () => {
    const fetchSpy = jest.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await collectReportDumpInputs();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('archFlag·reeval 등 부수효과 훅 파생 입력은 비워 둔다(n/a)', async () => {
    const { args } = await collectReportDumpInputs();
    expect(args.archFlag).toBeUndefined();
    expect(args.reevalInstrumentation).toBeUndefined();
    expect(args.barometerInstrumentation).toBeUndefined();
    expect(args.accelSnapshot).toBeUndefined();
  });
});
