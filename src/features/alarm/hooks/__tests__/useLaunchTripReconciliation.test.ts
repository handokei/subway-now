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

  it('status ended → notification + sentinel + active trip clear', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: 1_700_000_000_000,
      endReason: 'destination-arrived',
    });
    await runLaunchTripReconciliation();
    expect(mockFetchTripStatus).toHaveBeenCalledWith('tk', 'https://api.test.dev');
    expect(mockSendTripEnded).toHaveBeenCalledWith('destination-arrived');
    expect(mockSetSentinel).toHaveBeenCalledWith(1_700_000_000_000);
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

  it('status active → 변경 없음', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'active',
      endedAt: null,
      endReason: null,
    });
    await runLaunchTripReconciliation();
    expect(mockSendTripEnded).not.toHaveBeenCalled();
    expect(mockSetSentinel).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe('tk');
  });

  it('404/410 (null) → active trip clear만, notification X', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue(null);
    await runLaunchTripReconciliation();
    expect(mockSendTripEnded).not.toHaveBeenCalled();
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
