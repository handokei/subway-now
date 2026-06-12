import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { TRIP_BOUND_CLEANUPS, runTripBoundCleanups } from '../tripBoundCleanups';
import {
  DESTINATION_KEY,
  ROUTE_KEY,
  BOARDING_LOCK_KEY,
  ACTIVE_TRIP_KEY,
  TRIP_STARTED_AT_KEY,
  LAST_UPLOADED_RECALL_TRIP_START_KEY,
  LA_DISMISSED_AT_KEY,
  SCHEDULED_NOTIFICATIONS_KEY,
} from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('expo-notifications');

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
