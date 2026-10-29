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

const mockHandleTripGone = jest.fn();
jest.mock('../tripGoneSelfEnd', () => ({
  handleTripGone: (...args: unknown[]) => mockHandleTripGone(...args),
}));

const mockHasFutureTripArrivalAlarm = jest.fn();
jest.mock('../tripGone', () => ({
  hasFutureTripArrivalAlarm: (...args: unknown[]) => mockHasFutureTripArrivalAlarm(...args),
}));

const mockMarkBackendLaTokenMissing = jest.fn();
jest.mock('../liveActivityPushChannel', () => ({
  markBackendLiveActivityTokenMissing: () => mockMarkBackendLaTokenMissing(),
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
        lockActive: false,
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
        lockActive: false,
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
        lockActive: false,
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
        lockActive: false,
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
        lockActive: false,
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
        lockActive: false,
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
        lockActive: false,
      }),
    ).toBe(false);
  });

  // #2735 PR-4 V1-a(a) — lock 활성 trip은 계속 오는 silent push가 token 소실을 가리므로 신원/공백과 무관하게
  // (쿨다운 10분 안에서) status를 확인한다. WhileInUse BG는 다른 두 사이트가 호출되지 않는다.
  it('lock 활성 + 신선한 접촉 + 신원 일치여도 true — token 소실 감지용', () => {
    expect(
      shouldCheckTripDeathOnSilentPush({
        activeTripToken: 'tk',
        payloadTripToken: 'tk',
        priorLastReceivedAt: 0,
        now: 1000,
        lockActive: true,
      }),
    ).toBe(true);
  });

  it('[거부] lock 활성이어도 active trip이 없으면 false', () => {
    expect(
      shouldCheckTripDeathOnSilentPush({
        activeTripToken: null,
        payloadTripToken: undefined,
        priorLastReceivedAt: 0,
        now: 1000,
        lockActive: true,
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

  // #3163 후속 P1-a — backend가 device 몰래 LA 토큰을 지운다(410/종료 dismissal/DELETE /live-activity).
  // status 응답이 "active인데 LA 토큰 없음"을 알려주면 device는 dedup을 풀고 재등록한다.
  describe('LA 토큰 소실 신호 (hasLiveActivityToken)', () => {
    beforeEach(async () => {
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    });

    it.each(['silent-push', 'bg-location-tick', 'fg-tick'] as const)(
      'site=%s active + hasLiveActivityToken=false -> 재등록 트리거, 결과는 alive',
      async (site) => {
        mockFetchTripStatus.mockResolvedValue({
          status: 'active',
          endedAt: null,
          endReason: null,
          hasLiveActivityToken: false,
        });

        const result = await checkTripDeathByPull(BASE_URL, site);

        expect(result).toBe('alive');
        expect(mockMarkBackendLaTokenMissing).toHaveBeenCalledTimes(1);
      },
    );

    it.each([true, undefined])('[거부] hasLiveActivityToken=%s(보유/구 backend)면 건드리지 않는다', async (has) => {
      mockFetchTripStatus.mockResolvedValue({
        status: 'active',
        endedAt: null,
        endReason: null,
        ...(has === undefined ? {} : { hasLiveActivityToken: has }),
      });

      await checkTripDeathByPull(BASE_URL, 'bg-location-tick');

      expect(mockMarkBackendLaTokenMissing).not.toHaveBeenCalled();
    });

    it('[거부] trip이 ended면 재등록하지 않는다', async () => {
      mockFetchTripStatus.mockResolvedValue({ status: 'ended', endedAt: 1, endReason: 'destination-arrived' });
      mockHasFutureTripArrivalAlarm.mockResolvedValue(false);

      await checkTripDeathByPull(BASE_URL, 'fg-tick');

      expect(mockMarkBackendLaTokenMissing).not.toHaveBeenCalled();
    });

    it('[거부] gone(404/410)이면 재등록하지 않는다', async () => {
      mockFetchTripStatus.mockResolvedValue({ status: 'gone', code: 404 });

      await checkTripDeathByPull(BASE_URL, 'bg-location-tick');

      expect(mockMarkBackendLaTokenMissing).not.toHaveBeenCalled();
    });
  });

  describe.each(['silent-push', 'bg-location-tick'] as const)(
    'PR-2 BG 불변 — site=%s 는 gone(404/410)을 보수적으로 무시(alive), 판정 위임·cleanup 0회',
    (site) => {
      it.each([404, 410] as const)('code=%s', async (code) => {
        await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
        mockFetchTripStatus.mockResolvedValue({ status: 'gone', code });

        const result = await checkTripDeathByPull(BASE_URL, site);

        expect(result).toBe('alive');
        expect(mockHandleTripGone).not.toHaveBeenCalled();
        expect(mockCleanupBackendConfirmedEndedTrip).not.toHaveBeenCalled();
        expect(mockCancelTripBoundOsQueue).not.toHaveBeenCalled();
        expect(mockAppendAlarmLog).not.toHaveBeenCalled();
      });
    },
  );

  describe('PR-2 FG — site=fg-tick 만 gone을 decideTripGone 경로(handleTripGone)에 위임', () => {
    beforeEach(async () => {
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
      mockFetchTripStatus.mockResolvedValue({ status: 'gone', code: 404 });
    });

    it("handleTripGone이 'ended' -> 'ended'", async () => {
      mockHandleTripGone.mockResolvedValue('ended');
      await expect(checkTripDeathByPull(BASE_URL, 'fg-tick')).resolves.toBe('ended');
      expect(mockHandleTripGone).toHaveBeenCalledWith({
        result: { status: 'gone', code: 404 },
        tripToken: 'tk',
        site: 'fg-tick',
      });
    });

    it.each(['young', 'deferred', 'skipped', 'not-gone'])(
      "handleTripGone이 '%s' -> 'alive' (FG는 어떤 유예에서도 키를 건드리지 않는다)",
      async (outcome) => {
        mockHandleTripGone.mockResolvedValue(outcome);
        await expect(checkTripDeathByPull(BASE_URL, 'fg-tick')).resolves.toBe('alive');
        expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe('tk');
      },
    );

    it("쿨다운 내 재호출은 'skipped' — 판정 위임 0회(세 사이트 공유 쿨다운)", async () => {
      await AsyncStorage.setItem(TRIP_DEATH_PULL_LAST_CHECK_AT_KEY, String(Date.now()));
      await expect(checkTripDeathByPull(BASE_URL, 'fg-tick')).resolves.toBe('skipped');
      expect(mockHandleTripGone).not.toHaveBeenCalled();
    });
  });

  it("status active → 무동작", async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });

    const result = await checkTripDeathByPull(BASE_URL, 'silent-push');

    expect(result).toBe('alive');
    expect(mockCleanupBackendConfirmedEndedTrip).not.toHaveBeenCalled();
  });

  describe('#3143 — ended 분기도 미발사 도착 알람이 있으면 유예(B의 deferred(alarm)와 동일)', () => {
    beforeEach(async () => {
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
      mockFetchTripStatus.mockResolvedValue({
        status: 'ended',
        endedAt: 1_700_000_000_000,
        endReason: 'expired',
      });
    });

    it('대기 중 도착 알람 있음 -> queue cancel/cleanup 모두 안 함, alive, 유예 로그', async () => {
      mockHasFutureTripArrivalAlarm.mockResolvedValue(true);

      await expect(checkTripDeathByPull(BASE_URL, 'fg-tick')).resolves.toBe('alive');

      expect(mockHasFutureTripArrivalAlarm).toHaveBeenCalledWith('tk');
      expect(mockCancelTripBoundOsQueue).not.toHaveBeenCalled();
      expect(mockCleanupBackendConfirmedEndedTrip).not.toHaveBeenCalled();
      expect(mockAppendAlarmLog).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'lifecycle-backstop',
          outcome: 'suppressed',
          reason: 'trip-ended-defer-alarm',
        }),
      );
    });

    it('대기 알람 없음(거부 케이스) -> 기존대로 cancel + cleanup', async () => {
      mockHasFutureTripArrivalAlarm.mockResolvedValue(false);

      await expect(checkTripDeathByPull(BASE_URL, 'fg-tick')).resolves.toBe('ended');

      expect(mockCancelTripBoundOsQueue).toHaveBeenCalledTimes(1);
      expect(mockCleanupBackendConfirmedEndedTrip).toHaveBeenCalledWith(1_700_000_000_000);
    });

    it('유예된 트립은 알람 발사 후 다음 체크에서 정리된다', async () => {
      mockHasFutureTripArrivalAlarm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await expect(checkTripDeathByPull(BASE_URL, 'fg-tick')).resolves.toBe('alive');
      await AsyncStorage.removeItem(TRIP_DEATH_PULL_LAST_CHECK_AT_KEY);

      await expect(checkTripDeathByPull(BASE_URL, 'fg-tick')).resolves.toBe('ended');

      expect(mockCancelTripBoundOsQueue).toHaveBeenCalledTimes(1);
      expect(mockCleanupBackendConfirmedEndedTrip).toHaveBeenCalledTimes(1);
    });
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
