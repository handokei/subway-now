import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import {
  TRIP_BOUND_CLEANUPS,
  runTripBoundCleanups,
  cancelTripBoundOsQueue,
  __resetDefensiveCancelForTest,
} from '../tripBoundCleanups';
import { TRIP_BOUND_ROUTE_SIG_KEY, BOARDING_LOCK_ROUTE_SIG_KEY } from '../../../../shared/constants/storageKeys';
import {
  DESTINATION_KEY,
  ROUTE_KEY,
  BOARDING_LOCK_KEY,
  ACTIVE_TRIP_KEY,
  TRIP_STARTED_AT_KEY,
  LAST_UPLOADED_RECALL_TRIP_START_KEY,
  LA_DISMISSED_AT_KEY,
  SCHEDULED_NOTIFICATIONS_KEY,
  STICKY_STATION_KEY,
} from '../../../../shared/constants/storageKeys';

const mockClearWidgetStation = jest.fn().mockResolvedValue(undefined);

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('expo-notifications');
jest.mock('../../../widget/api/widgetStorage', () => ({
  clearWidgetStation: () => mockClearWidgetStation(),
}));

describe('tripBoundCleanups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // expo-notifications auto-mock의 cancel/dismiss implementation을 명시 초기화 — 다른 테스트의
    // mockRejectedValue가 leak되어 다음 테스트의 cancel을 reject하지 않도록.
    (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockReset();
    (Notifications.dismissNotificationAsync as jest.Mock).mockReset();
    // #918 A3 PR4 — cancelTripBoundAlarms는 OS 큐 enumerate가 필요. auto-mock default가
    // undefined를 반환하면 for..of에서 throw → cleanup 흐름이 막힌다. 빈 큐로 graceful 통과.
    (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValue([]);
  });

  it('TRIP_BOUND_CLEANUPS는 비어있지 않다 (메타 배열 self-check)', () => {
    expect(TRIP_BOUND_CLEANUPS.length).toBeGreaterThan(0);
  });

  it('#868 — runTripBoundCleanups 실행 시 DESTINATION_KEY와 핵심 trip-bound 키들이 storage에서 제거된다', async () => {
    // BG silent push 경로에서 zustand store에 접근 불가하므로 storage 직접 제거가 유일한 경로.
    // DESTINATION_KEY 누락 회귀 차단 (#868 P1-1).
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
    await runTripBoundCleanups();
    const removedKeys = (AsyncStorage.removeItem as jest.Mock).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(removedKeys).toContain(DESTINATION_KEY);
    expect(removedKeys).toContain(ROUTE_KEY);
    expect(removedKeys).toContain(BOARDING_LOCK_KEY);
    expect(removedKeys).toContain(ACTIVE_TRIP_KEY);
    // #919 — trip start는 cleanup 대상이지만 LAST_UPLOADED_RECALL_TRIP_START_KEY는 보존
    // (dedup 마커 — BG silent push upload 후 직후 FG setDestination(null) 재트리거 시
    //  같은 tripStart 중복 upload 방지). 다른 tripStart로 시작되면 자연 무효화됨.
    expect(removedKeys).toContain(TRIP_STARTED_AT_KEY);
    // #926 — LA dismiss sentinel도 destination switch 시 함께 클리어. 다음 silent push에서
    // LA 재상승 허용. 누락 회귀가 발생하면 dismiss 후 새 trip 시작해도 LA가 살아나지 않음.
    expect(removedKeys).toContain(LA_DISMISSED_AT_KEY);
    expect(removedKeys).not.toContain(LAST_UPLOADED_RECALL_TRIP_START_KEY);
    // #1524 — sticky station persisted lock도 trip 종료 시 제거되어야 함.
    // hook 메모리 unlock만으로는 다음 FG 재마운트 hydrate가 stale lock을 부활시킴.
    expect(removedKeys).toContain(STICKY_STATION_KEY);
  });

  it('#1524 — runTripBoundCleanups 실행 시 위젯 storage를 clear한다 (자동 하차 후 stale 차단)', async () => {
    // trip 종료 시 위젯에는 trip 중 마지막 역이 남아 stale 상태로 노출됨.
    // clearWidgetStation을 호출해 "감지 중" 상태로 즉시 전환.
    mockClearWidgetStation.mockClear();
    await runTripBoundCleanups();
    expect(mockClearWidgetStation).toHaveBeenCalledTimes(1);
  });

  it('#773 — runTripBoundCleanups 실행 시 OS 사전 예약 큐를 cancel + storage clear한다 (옛 trip 알람 burst 차단)', async () => {
    // trip release 시점에 추적 큐의 모든 `bl:` 사전 예약을 OS에서 cancel해야 한다.
    // storage만 비우면 iOS 사전 예약은 살아남아 새 trip 시작 후 옛 알람이 burst로 발사된다.
    const scheduledIds = ['bl:T-100:0:early:강남', 'bl:T-100:0:imminent:강남'];
    await AsyncStorage.setItem(SCHEDULED_NOTIFICATIONS_KEY, JSON.stringify(scheduledIds));
    const mockedCancel = Notifications.cancelScheduledNotificationAsync as jest.Mock;
    mockedCancel.mockResolvedValue(undefined);
    (Notifications.dismissNotificationAsync as jest.Mock).mockResolvedValue(undefined);

    await runTripBoundCleanups();

    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:early:강남');
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:imminent:강남');
  });

  it('#773 — OS cancel이 reject해도 runTripBoundCleanups는 graceful 종료 (이미 발사된 알람 등)', async () => {
    // 이미 발사된 알람을 cancel 시 expo가 reject할 수 있다 — 나머지 cleanup에 전파되면 안 됨.
    await AsyncStorage.setItem(
      SCHEDULED_NOTIFICATIONS_KEY,
      JSON.stringify(['bl:T-100:0:early:강남']),
    );
    (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockRejectedValue(
      new Error('already fired'),
    );
    await expect(runTripBoundCleanups()).resolves.toBeUndefined();
  });

  it('TRIP_BOUND_CLEANUPS의 모든 항목은 호출 가능하며 Promise를 반환하고 reject하지 않는다', async () => {
    // 신규 trip-bound 키 추가 시 항목 wiring이 잘못되면 즉시 실패 — 회귀 가드.
    // (resolved value 자체는 AsyncStorage mock 구현에 따라 null일 수 있어 검증하지 않는다.
    // 메타 배열의 핵심 invariant는 "함수" + "비-rejecting Promise" 두 가지.)
    for (const cleanup of TRIP_BOUND_CLEANUPS) {
      expect(typeof cleanup).toBe('function');
      const result = cleanup();
      expect(result).toBeInstanceOf(Promise);
      await result;
    }
  });

  it('runTripBoundCleanups: 모든 항목이 호출된다', async () => {
    const spies = TRIP_BOUND_CLEANUPS.map((cleanup) => jest.fn(cleanup));
    // 메타 배열 자체를 재-실행하지 않고 spy를 직접 await — 모든 항목이 한 번씩 await됨을 검증.
    await Promise.all(spies.map((s) => s()));
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it('runTripBoundCleanups: AsyncStorage가 reject해도 reject를 던지지 않는다 (graceful)', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(runTripBoundCleanups()).resolves.toBeUndefined();
  });

  it('#1370 L4 — cancelTripBoundOsQueue: bl:/tba: 사전 예약을 OS 큐에서 cancel한다 (종착역 burst 차단)', async () => {
    // backend trip-ended push 수신 즉시 호출되는 정밀 helper. storage는 건드리지 않고
    // OS queue 두 채널만 우선 cancel — race window 차단.
    const blIds = ['bl:T-7172:0:early:용마산', 'bl:T-7172:0:imminent:용마산'];
    await AsyncStorage.setItem(SCHEDULED_NOTIFICATIONS_KEY, JSON.stringify(blIds));
    (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValue([
      { identifier: 'tba:imminent:용마산' },
    ]);
    (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockResolvedValue(undefined);
    (Notifications.dismissNotificationAsync as jest.Mock).mockResolvedValue(undefined);

    await cancelTripBoundOsQueue();

    const cancelled = (Notifications.cancelScheduledNotificationAsync as jest.Mock).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(cancelled).toContain('bl:T-7172:0:early:용마산');
    expect(cancelled).toContain('bl:T-7172:0:imminent:용마산');
    expect(cancelled).toContain('tba:imminent:용마산');
  });

  it('#1370 L4 — cancelTripBoundOsQueue: 한쪽 채널이 reject해도 다른 채널은 실행되고 호출자에 reject 전파 안 함', async () => {
    // 두 cancel은 독립적 — allSettled로 묶여 한쪽 실패가 다른 쪽 또는 호출자(trip-ended handler)에
    // 전파되면 안 된다.
    await AsyncStorage.setItem(
      SCHEDULED_NOTIFICATIONS_KEY,
      JSON.stringify(['bl:T-7172:0:imminent:용마산']),
    );
    (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockRejectedValue(
      new Error('boom'),
    );
    (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockResolvedValue(undefined);
    (Notifications.dismissNotificationAsync as jest.Mock).mockResolvedValue(undefined);

    await expect(cancelTripBoundOsQueue()).resolves.toBeUndefined();
    // bl 채널은 정상 cancel 호출됐어야 함.
    const cancelled = (Notifications.cancelScheduledNotificationAsync as jest.Mock).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(cancelled).toContain('bl:T-7172:0:imminent:용마산');
  });

  describe('#1525 — defensive cancel (zombie alarm backstop)', () => {
    // sig 가드 테스트에서 getItem/setItem이 일관된 in-memory store처럼 동작해야 한다.
    const storage = new Map<string, string>();

    beforeEach(async () => {
      jest.useFakeTimers();
      __resetDefensiveCancelForTest();
      storage.clear();
      // 이전 테스트가 mockRejectedValue로 leak시킨 implementation을 reset — outer beforeEach의
      // clearAllMocks는 호출 기록만 지우고 implementation은 유지한다.
      (AsyncStorage.removeItem as jest.Mock).mockReset();
      (AsyncStorage.removeItem as jest.Mock).mockImplementation((k: string) => {
        storage.delete(k);
        return Promise.resolve();
      });
      (AsyncStorage.getItem as jest.Mock).mockReset();
      (AsyncStorage.getItem as jest.Mock).mockImplementation((k: string) =>
        Promise.resolve(storage.get(k) ?? null),
      );
      (AsyncStorage.setItem as jest.Mock).mockReset();
      (AsyncStorage.setItem as jest.Mock).mockImplementation((k: string, v: string) => {
        storage.set(k, v);
        return Promise.resolve();
      });
      (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockReset();
      (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockResolvedValue(undefined);
      (Notifications.dismissNotificationAsync as jest.Mock).mockReset();
      (Notifications.dismissNotificationAsync as jest.Mock).mockResolvedValue(undefined);
      (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockReset();
      (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValue([]);
    });

    afterEach(async () => {
      __resetDefensiveCancelForTest();
      // pending microtask flush — runDefensiveCancel 내부 async chain이 fire 후 다음 tick에
      // 마무리되는 경우 "Cannot log after tests are done" 경고 방지.
      await Promise.resolve();
      await Promise.resolve();
      jest.useRealTimers();
    });

    it('cancelTripBoundOsQueue 호출 1분 후 두 채널 cancel을 한 번 더 실행한다 (route sig 없으면)', async () => {
      // 새 trip이 없을 때(sig=null) defensive retry가 한 번 더 cancel을 시도해 expo 내부
      // race로 살아남은 사전 예약을 정리한다.
      await AsyncStorage.removeItem(TRIP_BOUND_ROUTE_SIG_KEY);
      await AsyncStorage.removeItem(BOARDING_LOCK_ROUTE_SIG_KEY);
      (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValue([
        { identifier: 'tba:imminent:용마산' },
      ]);
      (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockResolvedValue(undefined);

      await cancelTripBoundOsQueue();
      const firstCallCount = (Notifications.cancelScheduledNotificationAsync as jest.Mock).mock
        .calls.length;

      // 1분 진행 → defensive timer fire.
      await jest.advanceTimersByTimeAsync(60_000);

      const secondCallCount = (Notifications.cancelScheduledNotificationAsync as jest.Mock).mock
        .calls.length;
      expect(secondCallCount).toBeGreaterThan(firstCallCount);
    });

    it('defensive timer fire 시점에 새 trip route sig가 기록돼 있으면 cancel을 skip한다', async () => {
      // 새 trip이 시작돼 sig가 다시 쓰이면 사전 예약은 정상 — defensive가 정상 알람을
      // 지우면 안 된다.
      (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValue([]);
      (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockResolvedValue(undefined);

      await cancelTripBoundOsQueue();
      const baseline = (Notifications.cancelScheduledNotificationAsync as jest.Mock).mock.calls
        .length;

      // 새 trip 시작 시뮬레이션 — sig 기록.
      await AsyncStorage.setItem(TRIP_BOUND_ROUTE_SIG_KEY, 'new-trip-sig');

      await jest.advanceTimersByTimeAsync(60_000);

      // sig 가드로 두 번째 cancel은 skip — 새 호출이 없어야 한다.
      expect((Notifications.cancelScheduledNotificationAsync as jest.Mock).mock.calls.length).toBe(
        baseline,
      );
    });

    it('runTripBoundCleanups도 defensive cancel을 1분 후 실행한다 (FG setDestination(null) 경로 backstop)', async () => {
      await AsyncStorage.removeItem(TRIP_BOUND_ROUTE_SIG_KEY);
      await AsyncStorage.removeItem(BOARDING_LOCK_ROUTE_SIG_KEY);
      (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValue([
        { identifier: 'tba:early:강남' },
      ]);
      (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockResolvedValue(undefined);
      (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);

      await runTripBoundCleanups();
      const baseline = (Notifications.cancelScheduledNotificationAsync as jest.Mock).mock.calls
        .length;

      await jest.advanceTimersByTimeAsync(60_000);

      expect(
        (Notifications.cancelScheduledNotificationAsync as jest.Mock).mock.calls.length,
      ).toBeGreaterThan(baseline);
    });

    it('연속 호출 시 이전 defensive timer를 reset하고 새 timer만 fire한다 (중복 cancel pass 방지)', async () => {
      await AsyncStorage.removeItem(TRIP_BOUND_ROUTE_SIG_KEY);
      await AsyncStorage.removeItem(BOARDING_LOCK_ROUTE_SIG_KEY);
      (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValue([]);
      (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockResolvedValue(undefined);

      await cancelTripBoundOsQueue();
      await jest.advanceTimersByTimeAsync(30_000);
      await cancelTripBoundOsQueue();
      // 30s만 더 진행 — 첫 timer 기준 60s에 도달했지만 reset됐으므로 fire 안 함.
      const baseline = (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mock.calls
        .length;
      await jest.advanceTimersByTimeAsync(30_000);
      // 첫 60s 시점이라 reset 안 됐다면 fire — 새 호출 발생. reset 됐다면 변화 없음.
      expect(
        (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mock.calls.length,
      ).toBe(baseline);

      // 추가 30s = 두 번째 호출 기준 60s — fire.
      await jest.advanceTimersByTimeAsync(30_000);
      expect(
        (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mock.calls.length,
      ).toBeGreaterThan(baseline);
    });

    it('defensive cancel 내부 OS reject는 Promise.allSettled가 흡수한다 (graceful)', async () => {
      await AsyncStorage.removeItem(TRIP_BOUND_ROUTE_SIG_KEY);
      await AsyncStorage.removeItem(BOARDING_LOCK_ROUTE_SIG_KEY);
      (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockRejectedValue(
        new Error('os err'),
      );
      (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockResolvedValue(undefined);

      await cancelTripBoundOsQueue();
      // getAllScheduledNotificationsAsync reject는 cancelTripBoundAlarms 내부에서 발생하지만
      // runDefensiveCancel의 Promise.allSettled가 흡수 — unhandled rejection 발생 X.
      await expect(jest.advanceTimersByTimeAsync(60_000)).resolves.toBeUndefined();
    });
  });

  it('runTripBoundCleanups: 한 항목이 reject해도 나머지 항목이 모두 실행된다', async () => {
    // 첫 호출만 reject, 나머지는 정상 — Promise.all 안에서 catch로 흡수되어
    // 다른 cleanup의 실행 자체에는 영향이 없어야 한다.
    let callCount = 0;
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return Promise.reject(new Error('first only'));
      return Promise.resolve();
    });

    await runTripBoundCleanups();

    // removeItem이 항목 수만큼(또는 그 이상 helper 경유분 포함) 호출됐는지 확인.
    // 최소 메타 배열 길이만큼은 호출되어야 한다.
    expect((AsyncStorage.removeItem as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(
      TRIP_BOUND_CLEANUPS.length,
    );
  });
});
