import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderHook, waitFor } from '@testing-library/react-native';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import {
  runLaunchTripReconciliation,
  useLaunchTripReconciliation,
} from '../useLaunchTripReconciliation';

const mockFetchTripStatus = jest.fn();
jest.mock('../../api/tripStatus', () => ({
  fetchTripStatus: (...args: unknown[]) => mockFetchTripStatus(...args),
}));

const mockGetSentinel = jest.fn();
const mockSetSentinel = jest.fn();
jest.mock('../../utils/tripEndedSentinel', () => ({
  getTripEndedSentinel: (...args: unknown[]) => mockGetSentinel(...args),
  setTripEndedSentinel: (...args: unknown[]) => mockSetSentinel(...args),
  clearTripEndedSentinel: jest.fn(),
}));

const mockSendTripEnded = jest.fn();
jest.mock('../../utils/stationNotification', () => ({
  sendTripEndedNotification: (...args: unknown[]) => mockSendTripEnded(...args),
}));

const mockTriggerTripEndRecall = jest.fn();
jest.mock('../../utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: (...args: unknown[]) => mockTriggerTripEndRecall(...args),
}));

const mockRunTripBoundCleanups = jest.fn();
jest.mock('../../store/tripBoundCleanups', () => ({
  runTripBoundCleanups: (...args: unknown[]) => mockRunTripBoundCleanups(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockGetSentinel.mockResolvedValue(null);
  mockSetSentinel.mockResolvedValue(undefined);
  mockSendTripEnded.mockResolvedValue(undefined);
  mockTriggerTripEndRecall.mockResolvedValue({ uploaded: false });
  mockRunTripBoundCleanups.mockResolvedValue(undefined);
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
});

describe('runLaunchTripReconciliation', () => {
  it('URL 미설정 → skip (fetch 호출 없음)', async () => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    await runLaunchTripReconciliation();
    expect(mockFetchTripStatus).not.toHaveBeenCalled();
  });

  it('ACTIVE_TRIP_KEY 부재 → skip', async () => {
    await runLaunchTripReconciliation();
    expect(mockFetchTripStatus).not.toHaveBeenCalled();
  });

  it('sentinel 기록 있음 → fetch skip', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockGetSentinel.mockResolvedValue(1_700_000_000_000);
    await runLaunchTripReconciliation();
    expect(mockFetchTripStatus).not.toHaveBeenCalled();
    expect(mockSendTripEnded).not.toHaveBeenCalled();
  });

  it('status ended → notification + recall + cleanup + sentinel + active trip clear', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: 1_700_000_000_000,
      endReason: 'destination-arrived',
    });
    await runLaunchTripReconciliation();
    expect(mockFetchTripStatus).toHaveBeenCalledWith('tk', 'https://api.test.dev');
    expect(mockSendTripEnded).toHaveBeenCalledWith('destination-arrived');
    expect(mockTriggerTripEndRecall).toHaveBeenCalledTimes(1);
    expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
    expect(mockSetSentinel).toHaveBeenCalledWith(1_700_000_000_000);
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
  });

  it('status ended — 호출 순서: sendTripEndedNotification → triggerTripEndRecall → runTripBoundCleanups → setTripEndedSentinel → removeItem(ACTIVE_TRIP_KEY)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: 1_700_000_000_000,
      endReason: 'destination-arrived',
    });

    // jest invocationCallOrder로 mock fn 호출 순서를 검증.
    // ACTIVE_TRIP_KEY removeItem은 AsyncStorage 직접 호출이라 mock fn order에 잡히지 않으므로
    // setSentinel 직후 storage가 비어 있음을 확인.
    await runLaunchTripReconciliation();

    const notifyOrder = mockSendTripEnded.mock.invocationCallOrder[0];
    const recallOrder = mockTriggerTripEndRecall.mock.invocationCallOrder[0];
    const cleanupOrder = mockRunTripBoundCleanups.mock.invocationCallOrder[0];
    const sentinelOrder = mockSetSentinel.mock.invocationCallOrder[0];

    expect(notifyOrder).toBeLessThan(recallOrder);
    expect(recallOrder).toBeLessThan(cleanupOrder);
    expect(cleanupOrder).toBeLessThan(sentinelOrder);
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
  });

  it('status ended + endedAt null → Date.now() fallback', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00Z'));
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: null,
      endReason: 'unknown',
    });
    await runLaunchTripReconciliation();
    expect(mockSetSentinel).toHaveBeenCalledWith(Date.now());
    jest.useRealTimers();
  });

  it('status ended + endReason null → unknown fallback', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: 1,
      endReason: null,
    });
    await runLaunchTripReconciliation();
    expect(mockSendTripEnded).toHaveBeenCalledWith('unknown');
  });

  it('status active → 변경 없음 + cleanup/recall 호출 안 함 (회귀 0)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'active',
      endedAt: null,
      endReason: null,
    });
    await runLaunchTripReconciliation();
    expect(mockSendTripEnded).not.toHaveBeenCalled();
    expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
    expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
    expect(mockSetSentinel).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe('tk');
  });

  it('404/410 (null) → active trip clear만, notification/cleanup/recall X (기존 동작 유지)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue(null);
    await runLaunchTripReconciliation();
    expect(mockSendTripEnded).not.toHaveBeenCalled();
    expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
    expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
    expect(mockSetSentinel).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
  });

  it('네트워크 에러 → silent fail (throw 없음, 상태 변경 없음)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockRejectedValue(new Error('network'));
    await expect(runLaunchTripReconciliation()).resolves.toBeUndefined();
    expect(mockSendTripEnded).not.toHaveBeenCalled();
    expect(mockSetSentinel).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe('tk');
  });

  it('내부 예외(setTripEndedSentinel 실패 등) → silent fail', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockSetSentinel.mockRejectedValueOnce(new Error('boom'));
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: 1,
      endReason: 'expired',
    });
    await expect(runLaunchTripReconciliation()).resolves.toBeUndefined();
  });
});

describe('useLaunchTripReconciliation', () => {
  it('마운트 시 1회 reconciliation 실행', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'active',
      endedAt: null,
      endReason: null,
    });
    renderHook(() => useLaunchTripReconciliation());
    await waitFor(() => expect(mockFetchTripStatus).toHaveBeenCalledTimes(1));
  });
});
