import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ACTIVE_TRIP_KEY,
  TRIP_DEATH_PULL_LAST_CHECK_AT_KEY,
} from '../../../../shared/constants/storageKeys';
import { TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS } from '../../../../shared/constants/realtime';
import {
  checkTripDeathByPull,
  shouldCheckTripDeathOnSilentPush,
  getBackendUrl,
} from '../tripDeathPullBackstop';

const mockFetchTripStatus = jest.fn();
jest.mock('../../api/tripStatus', () => ({
  fetchTripStatus: (...args: unknown[]) => mockFetchTripStatus(...args),
}));

const mockCancelTripBoundOsQueue = jest.fn();
jest.mock('../../store/tripBoundCleanups', () => ({
  cancelTripBoundOsQueue: (...args: unknown[]) => mockCancelTripBoundOsQueue(...args),
}));

const mockCleanupBackendConfirmedEndedTrip = jest.fn();
jest.mock('../tripEndedCleanupSequence', () => ({
  cleanupBackendConfirmedEndedTrip: (...args: unknown[]) =>
    mockCleanupBackendConfirmedEndedTrip(...args),
}));

const mockAppendAlarmLog = jest.fn();
jest.mock('../alarmLog', () => ({
  appendAlarmLog: (...args: unknown[]) => mockAppendAlarmLog(...args),
}));

const BASE_URL = 'https://api.test.dev';

describe('getBackendUrl', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  });

  it('EXPO_PUBLIC_ALARM_BACKEND_URL 미설정 → null', () => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    expect(getBackendUrl()).toBeNull();
  });

  it('trailing slash 제거', () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    expect(getBackendUrl()).toBe('https://api.test.dev');
  });
});

describe('shouldCheckTripDeathOnSilentPush', () => {
  it('active trip 없으면 false', () => {
    expect(
      shouldCheckTripDeathOnSilentPush({
        activeTripToken: null,
        payloadTripToken: 'other',
        priorLastReceivedAt: null,
        now: 1000,
      }),
    ).toBe(false);
  });

  it('payload tripToken이 active와 불일치 → true', () => {
    expect(
      shouldCheckTripDeathOnSilentPush({
        activeTripToken: 'tk',
        payloadTripToken: 'other',
        priorLastReceivedAt: null,
        now: 1000,
      }),
    ).toBe(true);
  });

  it('payload tripToken이 active와 일치 → 불일치 아님(다른 조건 없으면 false)', () => {
    expect(
      shouldCheckTripDeathOnSilentPush({
        activeTripToken: 'tk',
        payloadTripToken: 'tk',
        priorLastReceivedAt: null,
        now: 1000,
      }),
    ).toBe(false);
  });

  it('payload tripToken undefined(구 backend 호환) → mismatch 판정 skip', () => {
    expect(
      shouldCheckTripDeathOnSilentPush({
        activeTripToken: 'tk',
        payloadTripToken: undefined,
        priorLastReceivedAt: null,
        now: 1000,
      }),
    ).toBe(false);
  });

  it('마지막 접촉이 threshold 이상 지남 → true', () => {
    expect(
      shouldCheckTripDeathOnSilentPush({
        activeTripToken: 'tk',
        payloadTripToken: 'tk',
        priorLastReceivedAt: 0,
        now: TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS,
      }),
    ).toBe(true);
  });

  it('마지막 접촉이 threshold 미만 → false', () => {
    expect(
      shouldCheckTripDeathOnSilentPush({
        activeTripToken: 'tk',
        payloadTripToken: 'tk',
        priorLastReceivedAt: 0,
        now: TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS - 1,
      }),
    ).toBe(false);
  });

  it('priorLastReceivedAt null(첫 push) → staleness 판정 skip', () => {
    expect(
      shouldCheckTripDeathOnSilentPush({
        activeTripToken: 'tk',
        payloadTripToken: 'tk',
        priorLastReceivedAt: null,
        now: 999_999_999,
      }),
    ).toBe(false);
  });
});

describe('checkTripDeathByPull', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  it('active trip 없음 → skip, fetch 호출 안 함', async () => {
    const result = await checkTripDeathByPull(BASE_URL, 'silent-push');
    expect(result).toBe('skipped');
    expect(mockFetchTripStatus).not.toHaveBeenCalled();
  });

  it('쿨다운 내 재호출 → skip (fetch 호출 안 함)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    const now = 1_000_000;
    await AsyncStorage.setItem(
      TRIP_DEATH_PULL_LAST_CHECK_AT_KEY,
      String(now - (TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS - 1)),
    );
    jest.useFakeTimers().setSystemTime(now);

    const result = await checkTripDeathByPull(BASE_URL, 'bg-location-tick');

    expect(result).toBe('skipped');
    expect(mockFetchTripStatus).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('쿨다운 경과 후 재호출 → fetch 진행', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    const now = 1_000_000;
    await AsyncStorage.setItem(
      TRIP_DEATH_PULL_LAST_CHECK_AT_KEY,
      String(now - TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS),
    );
    jest.useFakeTimers().setSystemTime(now);
    mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });

    const result = await checkTripDeathByPull(BASE_URL, 'bg-location-tick');

    expect(result).toBe('alive');
    expect(mockFetchTripStatus).toHaveBeenCalledWith('tk', BASE_URL);
    jest.useRealTimers();
  });

  it('404/410(null) → 보수적으로 무시(alive 취급), cleanup 호출 안 함', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue(null);

    const result = await checkTripDeathByPull(BASE_URL, 'silent-push');

    expect(result).toBe('alive');
    expect(mockCleanupBackendConfirmedEndedTrip).not.toHaveBeenCalled();
    expect(mockCancelTripBoundOsQueue).not.toHaveBeenCalled();
    expect(mockAppendAlarmLog).not.toHaveBeenCalled();
  });

  it("status active → 무동작", async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });

    const result = await checkTripDeathByPull(BASE_URL, 'silent-push');

    expect(result).toBe('alive');
    expect(mockCleanupBackendConfirmedEndedTrip).not.toHaveBeenCalled();
  });

  it("status ended → death 확정: OS queue cancel + cleanup + alarmLog", async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: 1_700_000_000_000,
      endReason: 'expired',
    });

    const result = await checkTripDeathByPull(BASE_URL, 'silent-push');

    expect(result).toBe('ended');
    expect(mockCancelTripBoundOsQueue).toHaveBeenCalledTimes(1);
    expect(mockCleanupBackendConfirmedEndedTrip).toHaveBeenCalledWith(1_700_000_000_000);
    expect(mockAppendAlarmLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'lifecycle-backstop',
        outcome: 'fired',
        reason: 'trip-dead-pull-detected',
      }),
    );
  });

  it('status ended + endedAt null → Date.now() fallback', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    jest.useFakeTimers().setSystemTime(5_000_000);
    mockFetchTripStatus.mockResolvedValue({ status: 'ended', endedAt: null, endReason: null });

    await checkTripDeathByPull(BASE_URL, 'silent-push');

    expect(mockCleanupBackendConfirmedEndedTrip).toHaveBeenCalledWith(5_000_000);
    jest.useRealTimers();
  });

  it('쿨다운 저장값이 NaN(손상된 storage) → 쿨다운 무시하고 fetch 진행', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    await AsyncStorage.setItem(TRIP_DEATH_PULL_LAST_CHECK_AT_KEY, 'not-a-number');
    mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });

    const result = await checkTripDeathByPull(BASE_URL, 'silent-push');

    expect(result).toBe('alive');
    expect(mockFetchTripStatus).toHaveBeenCalled();
  });

  it('쿨다운 read 자체가 throw(storage 장애) → graceful, fetch 진행', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    const getItemSpy = jest.spyOn(AsyncStorage, 'getItem').mockImplementation((key: string) => {
      if (key === TRIP_DEATH_PULL_LAST_CHECK_AT_KEY) {
        return Promise.reject(new Error('storage failure'));
      }
      return Promise.resolve(key === ACTIVE_TRIP_KEY ? 'tk' : null);
    });
    mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });

    const result = await checkTripDeathByPull(BASE_URL, 'silent-push');

    expect(result).toBe('alive');
    expect(mockFetchTripStatus).toHaveBeenCalled();
    getItemSpy.mockRestore();
  });

  it('쿨다운 stamp write가 throw(storage 장애) → graceful, fetch는 그대로 진행', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    const setItemSpy = jest.spyOn(AsyncStorage, 'setItem').mockImplementation((key: string) => {
      if (key === TRIP_DEATH_PULL_LAST_CHECK_AT_KEY) {
        return Promise.reject(new Error('storage failure'));
      }
      return Promise.resolve();
    });
    mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });

    const result = await checkTripDeathByPull(BASE_URL, 'silent-push');

    expect(result).toBe('alive');
    setItemSpy.mockRestore();
  });

  it('네트워크 실패 → 무동작(오탐 금지, ADR-010)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockRejectedValue(new Error('network'));

    const result = await checkTripDeathByPull(BASE_URL, 'silent-push');

    expect(result).toBe('skipped');
    expect(mockCleanupBackendConfirmedEndedTrip).not.toHaveBeenCalled();
    expect(mockCancelTripBoundOsQueue).not.toHaveBeenCalled();
  });
});
