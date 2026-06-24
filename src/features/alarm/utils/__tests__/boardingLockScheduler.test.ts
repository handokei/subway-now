import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  advanceHopWindow,
  boardingLockAlarmIdentifier,
  cancelAllHopsForLock,
  cancelBlByStationPhase,
  clearRegisteredBlRouteSig,
  getRegisteredBlRouteSig,
  parseBoardingLockAlarmIdentifier,
  purgeBoardingLockSchedulerQueue,
  rescheduleHopForLock,
  routeSignature,
  scheduleHopsForLock,
  setRegisteredBlRouteSig,
} from '../boardingLockScheduler';
import {
  addScheduledNotificationIds,
  getScheduledNotificationIds,
  removeScheduledNotificationIds,
  clearScheduledNotificationIds,
} from '../scheduledNotificationsStorage';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { DirectRoute, TransferRoute, MultiTransferRoute } from '../../../../shared/utils/stationRoute';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

jest.mock('expo-notifications');

// #1357 (S1) — preschedule 진입 시 motion gate가 getCurrentMotionStationary()를 호출.
// 기본 false(jest 환경에서 native module 부재 동등) — 기존 테스트 동작 보존.
const mockGetCurrentMotionStationary = jest.fn<boolean, []>(() => false);
jest.mock('../../../nearest-station/utils/motionActivity', () => ({
  getCurrentMotionStationary: () => mockGetCurrentMotionStationary(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
jest.mock('../scheduledNotificationsStorage', () => ({
  addScheduledNotificationIds: jest.fn(),
  removeScheduledNotificationIds: jest.fn(),
  getScheduledNotificationIds: jest.fn(),
  clearScheduledNotificationIds: jest.fn(),
}));
const mockLoggerWarn = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: jest.fn(),
  }),
}));
jest.mock('../stationNotification', () => ({
  buildAlarmContent: (event: { stationName: string; phaseId: string }) => ({
    title: `T:${event.phaseId}`,
    body: `B:${event.stationName}`,
  }),
}));
const mockedSchedule = Notifications.scheduleNotificationAsync as jest.MockedFunction<
  typeof Notifications.scheduleNotificationAsync
>;
const mockedCancel = Notifications.cancelScheduledNotificationAsync as jest.MockedFunction<
  typeof Notifications.cancelScheduledNotificationAsync
>;
const mockedDismiss = Notifications.dismissNotificationAsync as jest.MockedFunction<
  typeof Notifications.dismissNotificationAsync
>;

const mockedAdd = addScheduledNotificationIds as jest.MockedFunction<
  typeof addScheduledNotificationIds
>;
const mockedRemove = removeScheduledNotificationIds as jest.MockedFunction<
  typeof removeScheduledNotificationIds
>;
const mockedGet = getScheduledNotificationIds as jest.MockedFunction<
  typeof getScheduledNotificationIds
>;
const mockedClear = clearScheduledNotificationIds as jest.MockedFunction<
  typeof clearScheduledNotificationIds
>;

const NOW = new Date('2026-06-01T00:00:00Z').getTime();

const lock: BoardingLock = {
  destinationId: 'dest-1',
  trainCode: 'T-100',
  boardingStationId: 'stn-A',
  boardingLine: '2',
  boardedAt: NOW,
  expectedDurationMs: 600_000,
};

const directRoute: DirectRoute = makeDirectRoute(2, '2');
const transferRoute: TransferRoute = makeTransferRoute({
  transferName: '교대',
  fromLine: '2',
  toLine: '3',
  stopsToTransfer: 2,
  stopsFromTransfer: 3,
});
const multiRoute: MultiTransferRoute = makeMultiTransferRoute({
  transfers: [
    { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 2 },
    { transferName: '약수', fromLine: '3', toLine: '6', stopsToTransfer: 2 },
    { transferName: '한강진', fromLine: '6', toLine: '7', stopsToTransfer: 1 },
  ],
  stopsAfterLastTransfer: 2,
});

const mockAsyncGetItem = AsyncStorage.getItem as jest.Mock;
const mockAsyncSetItem = AsyncStorage.setItem as jest.Mock;
const mockAsyncRemoveItem = AsyncStorage.removeItem as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockedGet.mockResolvedValue([]);
  mockAsyncGetItem.mockResolvedValue(null);
  mockAsyncSetItem.mockResolvedValue(undefined);
  mockAsyncRemoveItem.mockResolvedValue(undefined);
  // #1357 (S1) — motion 기본 false 복원 (clearAllMocks가 impl 지움).
  mockGetCurrentMotionStationary.mockReturnValue(false);
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
});

describe('boardingLockAlarmIdentifier / parse', () => {
  it('round-trip 정상', () => {
    const id = boardingLockAlarmIdentifier({
      trainCode: 'T-100',
      hopIndex: 2,
      phase: 'imminent',
      stationName: '강남',
    });
    expect(id).toBe('bl:T-100:2:imminent:강남');
    expect(parseBoardingLockAlarmIdentifier(id)).toEqual({
      trainCode: 'T-100',
      hopIndex: 2,
      phase: 'imminent',
      stationName: '강남',
    });
  });

  it('stationName에 콜론 포함 시 그대로 복원', () => {
    const id = boardingLockAlarmIdentifier({
      trainCode: 'T-1',
      hopIndex: 0,
      phase: 'early',
      stationName: 'A:B',
    });
    expect(parseBoardingLockAlarmIdentifier(id)).toEqual({
      trainCode: 'T-1',
      hopIndex: 0,
      phase: 'early',
      stationName: 'A:B',
    });
  });

  it('prefix 불일치는 null', () => {
    expect(parseBoardingLockAlarmIdentifier('alarm:early:강남')).toBeNull();
  });

  it('필드 누락은 null', () => {
    expect(parseBoardingLockAlarmIdentifier('bl:T-1:0:early')).toBeNull();
    expect(parseBoardingLockAlarmIdentifier('bl::0:early:강남')).toBeNull();
    expect(parseBoardingLockAlarmIdentifier('bl:T-1::early:강남')).toBeNull();
    expect(parseBoardingLockAlarmIdentifier('bl:T-1:0:early:')).toBeNull();
  });

  it('hopIndex가 정수가 아니면 null', () => {
    expect(parseBoardingLockAlarmIdentifier('bl:T-1:abc:early:강남')).toBeNull();
    expect(parseBoardingLockAlarmIdentifier('bl:T-1:-1:early:강남')).toBeNull();
    expect(parseBoardingLockAlarmIdentifier('bl:T-1:1.5:early:강남')).toBeNull();
  });

  it('phase가 알람 phase가 아니면 null', () => {
    expect(parseBoardingLockAlarmIdentifier('bl:T-1:0:other:강남')).toBeNull();
  });
});

describe('scheduleHopsForLock', () => {
  it('direct route: destination waypoint 1개를 예약, early+imminent 모두 발사', async () => {
    await scheduleHopsForLock({ lock, route: directRoute, destinationName: '강남' });

    // fixture STOP_FALLBACK_SECONDS=120 → travelSeconds=240s. arrival=NOW+240k.
    // #785: early lead=240/2=120s, imminent lead=45s → 둘 다 양수 → 2회 예약.
    expect(mockedSchedule).toHaveBeenCalledTimes(2);
    expect(mockedAdd).toHaveBeenCalledWith([
      'bl:T-100:0:early:강남',
      'bl:T-100:0:imminent:강남',
    ]);
    const earlyCall = mockedSchedule.mock.calls[0][0];
    expect(earlyCall.content.interruptionLevel).toBe('active');
    const imminentCall = mockedSchedule.mock.calls[1][0];
    expect(imminentCall.content.interruptionLevel).toBe('timeSensitive');
  });

  it('transfer route: 다음 3 hop = 환승역 + 도착역 모두 예약', async () => {
    await scheduleHopsForLock({ lock, route: transferRoute, destinationName: '오금' });
    // 2 waypoints: 교대(stops 2) + 오금(stops 3)
    expect(mockedSchedule).toHaveBeenCalledTimes(4);
    const ids = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(ids).toContain('bl:T-100:0:early:교대');
    expect(ids).toContain('bl:T-100:0:imminent:교대');
    expect(ids).toContain('bl:T-100:1:early:오금');
    expect(ids).toContain('bl:T-100:1:imminent:오금');
  });

  it('multi-transfer: windowSize 기본=Infinity라 4 waypoint 모두 예약됨 (#1756)', async () => {
    await scheduleHopsForLock({ lock, route: multiRoute, destinationName: '온수' });
    // targets = 교대, 약수, 한강진, 온수. window=Infinity (#1756) → 모두 예약 → destination floor 보장.
    const ids = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(ids.some((id) => id.includes(':2:'))).toBe(true); // 한강진(idx=2)
    expect(ids.some((id) => id.includes(':3:'))).toBe(true); // 온수(idx=3) destination도 floor
  });

  it('multi-transfer: windowSize=3으로 명시 시 4번째 waypoint(목적지) skip', async () => {
    // 기존 windowSize=3 동작 보존 — 명시 지정 시 그대로 적용. (advance 시 다음 hop 채워짐 가정 흐름)
    await scheduleHopsForLock({
      lock,
      route: multiRoute,
      destinationName: '온수',
      windowSize: 3,
    });
    const ids = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(ids.some((id) => id.includes(':2:'))).toBe(true);
    expect(ids.some((id) => id.includes(':3:'))).toBe(false);
  });

  it('windowSize 인자로 더 작게 지정 가능', async () => {
    await scheduleHopsForLock({
      lock,
      route: transferRoute,
      destinationName: '오금',
      windowSize: 1,
    });
    expect(mockedSchedule).toHaveBeenCalledTimes(2); // 환승역만
    const ids = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(ids.every((id) => id.includes(':0:'))).toBe(true);
  });

  it('과거 시각으로 산출되는 알람은 skip — now가 충분히 진행된 경우', async () => {
    // fixture 120s/stop → arrival=240s. early fires at 240−120=120s, imminent at 240−45=195s.
    // now=NOW+200s → 두 fire time 모두 ≤200s → 둘 다 skip.
    await scheduleHopsForLock({
      lock,
      route: directRoute,
      destinationName: '강남',
      now: NOW + 200_000,
    });
    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(mockedAdd).toHaveBeenCalledWith([]);
  });

  it('android: channelId + priority 사용', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    await scheduleHopsForLock({ lock, route: directRoute, destinationName: '강남' });
    const call = mockedSchedule.mock.calls[0][0];
    expect((call.content as { channelId?: string }).channelId).toBe('station-alarm');
    expect((call.content as { priority?: unknown }).priority).toBe(
      Notifications.AndroidNotificationPriority.MAX,
    );
  });

  it('웹/기타 플랫폼은 platform 의존 필드 미설정', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    await scheduleHopsForLock({ lock, route: directRoute, destinationName: '강남' });
    const call = mockedSchedule.mock.calls[0][0];
    expect((call.content as { channelId?: string }).channelId).toBeUndefined();
    expect(call.content.interruptionLevel).toBeUndefined();
  });

  describe('#632 sleepMode 가드', () => {
    async function scheduleAndGetIds(
      route: DirectRoute | TransferRoute,
      dest: string,
      sleepMode: boolean,
    ): Promise<string[]> {
      await scheduleHopsForLock({ lock, route, destinationName: dest, sleepMode });
      return mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    }

    it('sleepMode=true + 첫 hop이 transfer면 그 hop skip, 둘째 hop은 정상', async () => {
      const ids = await scheduleAndGetIds(transferRoute, '오금', true);
      expect(ids).not.toContain('bl:T-100:0:early:교대');
      expect(ids).not.toContain('bl:T-100:0:imminent:교대');
      expect(ids).toContain('bl:T-100:1:early:오금');
      expect(ids).toContain('bl:T-100:1:imminent:오금');
      expect(mockedAdd).toHaveBeenCalledWith([
        'bl:T-100:1:early:오금',
        'bl:T-100:1:imminent:오금',
      ]);
    });

    it('sleepMode=true + 첫 hop이 destination이면 정상 schedule', async () => {
      const ids = await scheduleAndGetIds(directRoute, '강남', true);
      expect(mockedSchedule).toHaveBeenCalledTimes(2);
      expect(ids).toContain('bl:T-100:0:early:강남');
      expect(ids).toContain('bl:T-100:0:imminent:강남');
    });

    it('sleepMode=false + 첫 hop이 transfer여도 정상 schedule', async () => {
      await scheduleAndGetIds(transferRoute, '오금', false);
      expect(mockedSchedule).toHaveBeenCalledTimes(4);
    });
  });

  it('빈 targets은 storage write도 빈 배열', async () => {
    // direct stops=0 → travelSeconds=0 → arrival=NOW. 모든 fire time ≤ NOW → 예약 안 됨.
    const zeroRoute: DirectRoute = makeDirectRoute(0, '2');
    await scheduleHopsForLock({ lock, route: zeroRoute, destinationName: '강남' });
    expect(mockedSchedule).not.toHaveBeenCalled();
  });
});

describe('cancelAllHopsForLock', () => {
  it('큐에서 같은 trainCode prefix만 cancel + remove', async () => {
    mockedGet.mockResolvedValueOnce([
      'bl:T-100:0:early:강남',
      'bl:T-100:0:imminent:강남',
      'bl:T-200:0:early:강남', // 다른 lock
      'alarm:early:강남', // 다른 모듈
    ]);
    await cancelAllHopsForLock(lock);

    expect(mockedCancel).toHaveBeenCalledTimes(2);
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:early:강남');
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:imminent:강남');
    expect(mockedDismiss).toHaveBeenCalledTimes(2);
    expect(mockedRemove).toHaveBeenCalledWith([
      'bl:T-100:0:early:강남',
      'bl:T-100:0:imminent:강남',
    ]);
  });

  it('일치 없으면 cancel/remove 호출 안 함', async () => {
    mockedGet.mockResolvedValueOnce(['bl:T-200:0:early:강남']);
    await cancelAllHopsForLock(lock);
    expect(mockedCancel).not.toHaveBeenCalled();
    expect(mockedRemove).not.toHaveBeenCalled();
  });

  it('dismiss 실패는 silent — cancel은 계속 진행', async () => {
    mockedGet.mockResolvedValueOnce(['bl:T-100:0:early:강남']);
    mockedDismiss.mockRejectedValueOnce(new Error('not delivered'));
    await expect(cancelAllHopsForLock(lock)).resolves.toBeUndefined();
    expect(mockedCancel).toHaveBeenCalled();
  });

  it('#1525 — 한 identifier의 cancel reject가 나머지 identifier cancel을 막지 않는다', async () => {
    // 직렬 await 루프였을 때는 첫 id의 cancel reject에서 throw → 나머지 `bl:` 사전 예약이
    // OS 큐에 남아 trip 종료 후 좀비 알림으로 발사됐다. allSettled로 묶여 한 id의
    // cancel reject가 나머지를 막지 않아야 한다.
    // #1415/#1353 R1 — Fix 3 retry로 reject된 id는 한 번 더 cancel 호출 발생.
    mockedGet.mockResolvedValueOnce([
      'bl:T-100:0:early:강남',
      'bl:T-100:0:imminent:강남',
      'bl:T-100:1:early:역삼',
    ]);
    // 강남은 1차 reject, 2차(재시도) success.
    let gangnamCallCount = 0;
    mockedCancel.mockImplementation((id) => {
      if (id === 'bl:T-100:0:early:강남') {
        gangnamCallCount++;
        if (gangnamCallCount === 1) return Promise.reject(new Error('temporary OS busy'));
        return Promise.resolve();
      }
      return Promise.resolve();
    });

    try {
      await expect(cancelAllHopsForLock(lock)).resolves.toBeUndefined();

      expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:early:강남');
      expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:imminent:강남');
      expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:1:early:역삼');
      // Fix 3 — reject 된 id에 대해 한 번 더 cancel 호출 (총 2회).
      expect(gangnamCallCount).toBe(2);
    } finally {
      // 다른 describe로 reject impl leak 방지.
      mockedCancel.mockReset();
    }
  });

  // #1415/#1353 R1 — Fix 3: 1차 reject + 재시도도 reject 시 pass-2 warn 로그.
  it('R1 (#1415/#1353) Fix 3 — 영구 reject identifier는 retry 후에도 실패하면 pass-2 warn 로그', async () => {
    mockedGet.mockResolvedValueOnce([
      'bl:T-100:0:early:강남',
      'bl:T-100:0:imminent:역삼',
    ]);
    mockedCancel.mockImplementation((id) => {
      if (id === 'bl:T-100:0:early:강남') return Promise.reject(new Error('permanent'));
      return Promise.resolve();
    });

    try {
      await expect(cancelAllHopsForLock(lock)).resolves.toBeUndefined();

      // 강남 2회(pass-1+pass-2), 역삼 1회.
      const gangnamCalls = mockedCancel.mock.calls.filter((c) => c[0] === 'bl:T-100:0:early:강남');
      expect(gangnamCalls).toHaveLength(2);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('cancel reject pass-1: channel=bl count=1'),
      );
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('cancel reject pass-2 (final): channel=bl count=1'),
      );
    } finally {
      mockedCancel.mockReset();
    }
  });

  // #1415/#1353 R1 — Fix 3: 4건 이상 reject 시 ids 표시는 처음 3건 + '...'.
  it('R1 (#1415/#1353) Fix 3 — 4건 이상 reject 시 ids 로그는 처음 3건 + "..." 표기', async () => {
    mockedGet.mockResolvedValueOnce([
      'bl:T-100:0:early:A',
      'bl:T-100:0:early:B',
      'bl:T-100:0:early:C',
      'bl:T-100:0:early:D',
    ]);
    mockedCancel.mockImplementation(() => Promise.reject(new Error('all fail')));

    try {
      await cancelAllHopsForLock(lock);

      // 처음 3건만 + '...' suffix.
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringMatching(/cancel reject pass-1: channel=bl count=4 ids=bl:T-100:0:early:A,bl:T-100:0:early:B,bl:T-100:0:early:C\.\.\./),
      );
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringMatching(/cancel reject pass-2 \(final\): channel=bl count=4/),
      );
    } finally {
      mockedCancel.mockReset();
    }
  });
});

// #1356 E1 / #1355 D1 — silent push suppress & cross-channel cancel helper.
describe('cancelBlByStationPhase (#1356 E1 / #1355 D1)', () => {
  it('같은 stationName + phase 매칭만 cancel + remove (trainCode/hopIndex 무관)', async () => {
    mockedGet.mockResolvedValueOnce([
      'bl:T-100:0:early:강남',     // 매칭
      'bl:T-100:1:early:강남',     // 매칭 (다른 hopIndex)
      'bl:T-200:0:early:강남',     // 매칭 (다른 trainCode)
      'bl:T-100:0:imminent:강남',  // 다른 phase
      'bl:T-100:2:early:역삼',     // 다른 station
      'alarm:early:강남',           // 다른 prefix
    ]);

    await cancelBlByStationPhase('강남', 'early');

    expect(mockedCancel).toHaveBeenCalledTimes(3);
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:early:강남');
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:1:early:강남');
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-200:0:early:강남');
    expect(mockedRemove).toHaveBeenCalledWith([
      'bl:T-100:0:early:강남',
      'bl:T-100:1:early:강남',
      'bl:T-200:0:early:강남',
    ]);
  });

  it('매칭 없으면 cancel/remove 호출 안 함 (safe no-op)', async () => {
    mockedGet.mockResolvedValueOnce(['bl:T-100:0:imminent:강남', 'alarm:early:강남']);
    await cancelBlByStationPhase('강남', 'early');
    expect(mockedCancel).not.toHaveBeenCalled();
    expect(mockedRemove).not.toHaveBeenCalled();
  });

  it('큐가 빈 경우 no-op', async () => {
    mockedGet.mockResolvedValueOnce([]);
    await cancelBlByStationPhase('강남', 'early');
    expect(mockedCancel).not.toHaveBeenCalled();
    expect(mockedRemove).not.toHaveBeenCalled();
  });
});

describe('purgeBoardingLockSchedulerQueue', () => {
  it('큐가 비어있으면 cancel은 호출하지 않고 storage clear는 멱등으로 항상 수행한다 (#773)', async () => {
    mockedGet.mockResolvedValueOnce([]);
    await purgeBoardingLockSchedulerQueue();
    expect(mockedCancel).not.toHaveBeenCalled();
    // #773: TRIP_BOUND_CLEANUPS가 SCHEDULED_NOTIFICATIONS_KEY removal을 본 함수에 위임하므로
    // empty case에서도 storage key 정리는 보장되어야 한다.
    expect(mockedClear).toHaveBeenCalled();
  });

  it('bl: prefix만 cancel하고 큐 전체 clear', async () => {
    mockedGet.mockResolvedValueOnce(['bl:T-1:0:early:A', 'alarm:early:A']);
    await purgeBoardingLockSchedulerQueue();
    expect(mockedCancel).toHaveBeenCalledTimes(1);
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-1:0:early:A');
    expect(mockedClear).toHaveBeenCalled();
  });
});

describe('advanceHopWindow', () => {
  it('passedStationName이 route에 없으면 no-op', async () => {
    await advanceHopWindow({
      lock,
      route: multiRoute,
      destinationName: '온수',
      passedStationName: '없는역',
    });
    expect(mockedCancel).not.toHaveBeenCalled();
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('큐에 빠진 hopIndex가 있으면 window 범위 안에서 모두 채워 예약 (out-of-order 호출 견고성)', async () => {
    // multiRoute targets: 교대(0), 약수(1), 한강진(2), 온수(3).
    // 0이 통과되고 큐에 1만 있는 상태에서 advance(0) → 2(한강진)도 채워야 한다.
    mockedGet.mockResolvedValueOnce([
      'bl:T-100:0:early:교대',
      'bl:T-100:1:early:약수',
    ]);
    await advanceHopWindow({
      lock,
      route: multiRoute,
      destinationName: '온수',
      passedStationName: '교대',
    });
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:early:교대');
    const newIds = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    // 1은 이미 있으므로 skip, 2(한강진)와 3(온수)는 채움. (windowSize=Infinity → 범위 [1..3])
    expect(newIds.some((id) => id.startsWith('bl:T-100:1:'))).toBe(false);
    expect(newIds.some((id) => id.startsWith('bl:T-100:2:'))).toBe(true);
    expect(newIds.some((id) => id.startsWith('bl:T-100:3:'))).toBe(true);
  });

  it('정상 호출(0 → 1): hopIndex 0 cancel + window 끝 hop만 새로 예약', async () => {
    // multiRoute targets: 교대(0), 약수(1), 한강진(2), 온수(3). window=Infinity → 0,1,2,3 예약됨.
    // 교대 통과 시: hopIndex 0 cancel + 새 hop = 남은 미예약 = 3 (온수) 예약.
    mockedGet.mockResolvedValueOnce([
      'bl:T-100:0:early:교대',
      'bl:T-100:0:imminent:교대',
      'bl:T-100:1:early:약수',
      'bl:T-100:2:early:한강진',
    ]);
    await advanceHopWindow({
      lock,
      route: multiRoute,
      destinationName: '온수',
      passedStationName: '교대',
    });
    // cancel: hopIndex<=0 → 2개
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:early:교대');
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:imminent:교대');
    expect(mockedCancel).not.toHaveBeenCalledWith('bl:T-100:1:early:약수');
    expect(mockedRemove).toHaveBeenCalledWith([
      'bl:T-100:0:early:교대',
      'bl:T-100:0:imminent:교대',
    ]);
    // schedule: 온수 hopIndex=3
    const newIds = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(newIds).toContain('bl:T-100:3:early:온수');
    expect(newIds).toContain('bl:T-100:3:imminent:온수');
    expect(mockedAdd).toHaveBeenCalledWith([
      'bl:T-100:3:early:온수',
      'bl:T-100:3:imminent:온수',
    ]);
  });

  it('새 window 끝이 route 범위 밖이면 추가 예약 없음', async () => {
    // direct route: targets=[강남(0)]. window=3 → nextHopIndex = 0+3 = 3, out of range.
    mockedGet.mockResolvedValueOnce(['bl:T-100:0:early:강남']);
    await advanceHopWindow({
      lock,
      route: directRoute,
      destinationName: '강남',
      passedStationName: '강남',
    });
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:early:강남');
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('cancel 대상 없을 때 remove 미호출, 그래도 다음 hop 예약은 시도', async () => {
    mockedGet.mockResolvedValueOnce(['bl:T-200:0:early:교대']); // 다른 lock
    await advanceHopWindow({
      lock,
      route: multiRoute,
      destinationName: '온수',
      passedStationName: '교대',
      windowSize: 3,
    });
    expect(mockedRemove).not.toHaveBeenCalled();
    // 새 hop = 3 (온수) 예약 시도됨
    expect(mockedSchedule).toHaveBeenCalled();
  });

  it('새 hop 시점이 과거면 schedule 호출 없음, add 호출 없음', async () => {
    mockedGet.mockResolvedValueOnce([]);
    await advanceHopWindow({
      lock,
      route: multiRoute,
      destinationName: '온수',
      passedStationName: '교대',
      now: NOW + 10_000_000, // 충분히 미래로
    });
    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it('android: 새 hop schedule 시 channelId + priority 사용', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockedGet.mockResolvedValueOnce([]);
    await advanceHopWindow({
      lock,
      route: multiRoute,
      destinationName: '온수',
      passedStationName: '교대',
    });
    const call = mockedSchedule.mock.calls[0][0];
    expect((call.content as { channelId?: string }).channelId).toBe('station-alarm');
    expect((call.content as { priority?: unknown }).priority).toBe(
      Notifications.AndroidNotificationPriority.MAX,
    );
  });

  it('dismiss 실패는 silent', async () => {
    mockedGet.mockResolvedValueOnce(['bl:T-100:0:early:교대']);
    mockedDismiss.mockRejectedValueOnce(new Error('no'));
    await expect(
      advanceHopWindow({
        lock,
        route: multiRoute,
        destinationName: '온수',
        passedStationName: '교대',
      }),
    ).resolves.toBeUndefined();
  });

  describe('#632 sleepMode 가드', () => {
    async function advanceAndGetIds(
      route: TransferRoute | MultiTransferRoute,
      dest: string,
      passed: string,
      sleepMode: boolean,
    ): Promise<string[]> {
      mockedGet.mockResolvedValueOnce([]);
      await advanceHopWindow({ lock, route, destinationName: dest, passedStationName: passed, sleepMode });
      return mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    }

    it('sleepMode=true + passedIndex+1 hop이 transfer면 그 hop만 skip', async () => {
      // multiRoute: 교대(0,t), 약수(1,t), 한강진(2,t), 온수(3,d). 교대 통과 후 새 첫 hop=약수(transfer).
      const ids = await advanceAndGetIds(multiRoute, '온수', '교대', true);
      expect(ids.some((id) => id.startsWith('bl:T-100:1:'))).toBe(false);
      expect(ids.some((id) => id.startsWith('bl:T-100:2:'))).toBe(true);
      expect(ids.some((id) => id.startsWith('bl:T-100:3:'))).toBe(true);
    });

    it('sleepMode=true + out-of-order advance: 새 첫 hop(=passedIndex+1)만 skip 대상', async () => {
      // GPS 점프로 약수(1)를 건너뛰고 한강진(2) 직전에 advance — 새 hop 시작점=2(한강진, transfer) skip.
      const ids = await advanceAndGetIds(multiRoute, '온수', '약수', true);
      expect(ids.some((id) => id.startsWith('bl:T-100:2:'))).toBe(false);
      expect(ids.some((id) => id.startsWith('bl:T-100:3:'))).toBe(true);
    });

    it('sleepMode=true + passedIndex+1 hop이 destination이면 정상 schedule', async () => {
      // transferRoute: 교대(0,t), 오금(1,d). 새 첫 hop=오금(destination) → skip 안 함.
      const ids = await advanceAndGetIds(transferRoute, '오금', '교대', true);
      expect(ids).toContain('bl:T-100:1:early:오금');
      expect(ids).toContain('bl:T-100:1:imminent:오금');
    });
  });

  // #710: 호출자가 raw GPS station.name(노선별 부제 포함)을 넘겨도 canonical resolve.
  it('#710 passedStationName이 노선별 부제 포함이어도 정규화 매칭으로 advance', async () => {
    // multiRoute targets[0].name = '교대'. raw GPS가 '교대(법원·검찰청)' 등으로 들어오는 케이스.
    mockedGet.mockResolvedValueOnce(['bl:T-100:0:early:교대']);
    await advanceHopWindow({
      lock,
      route: multiRoute,
      destinationName: '온수',
      passedStationName: '교대(법원·검찰청)',
    });
    // 매칭됐다면 hopIndex=0 cancel이 발생한다 — 매칭 실패였다면 no-op.
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:early:교대');
  });
});

describe('#785 segment lookup 기반 timing', () => {
  // 픽스처는 STOP_FALLBACK_SECONDS=120 사용 — 기존 uniform 90s 가정과 다름.
  // 본 describe는 alarm 발사 시각이 route.secondsXxx(=getStopSeconds 누적 결과) 기반으로
  // 산출되는지를 검증한다. ADR-008 Stage 3 estimator의 segment 누적값과 정렬됨을 보장.
  function triggerMsByIdentifier(suffixMatcher: (id: string) => boolean): number {
    const call = mockedSchedule.mock.calls.find((c) => {
      const id = c[0].identifier ?? '';
      return suffixMatcher(id);
    });
    if (!call) throw new Error('matching schedule call not found');
    const trigger = call[0].trigger as { date: Date };
    return trigger.date.getTime();
  }

  it('direct route: arrival = boardedAt + travelSeconds(누적), early lead = legSeconds/stops', async () => {
    // directRoute(2 stops, travelSeconds=240): arrival = NOW + 240_000.
    // early lead = 240/2 = 120s → fires at NOW + 120_000.
    await scheduleHopsForLock({ lock, route: directRoute, destinationName: '강남' });
    expect(triggerMsByIdentifier((id) => id.includes(':early:'))).toBe(NOW + 120_000);
  });

  it('direct route: imminent은 45s 고정 lead', async () => {
    await scheduleHopsForLock({ lock, route: directRoute, destinationName: '강남' });
    // arrival NOW+240_000 − 45_000 = NOW+195_000.
    expect(triggerMsByIdentifier((id) => id.includes(':imminent:'))).toBe(NOW + 195_000);
  });

  it('transfer route: hop[1] arrival = secondsToTransfer + secondsFromTransfer', async () => {
    // transferRoute: stopsToTransfer=2(240s), stopsFromTransfer=3(360s).
    // hop[0] 교대: arrival=NOW+240_000, lead=120s → fires NOW+120_000.
    // hop[1] 오금: arrival=NOW+600_000, lead=360/3=120s → fires NOW+480_000.
    await scheduleHopsForLock({ lock, route: transferRoute, destinationName: '오금' });
    expect(triggerMsByIdentifier((id) => id.endsWith(':교대') && id.includes(':early:'))).toBe(
      NOW + 120_000,
    );
    expect(triggerMsByIdentifier((id) => id.endsWith(':오금') && id.includes(':early:'))).toBe(
      NOW + 480_000,
    );
  });

  it('transfer route: leg 별 secondsPerStop이 다르면 lead도 다름', async () => {
    // 의도적으로 leg별 비대칭. stops=2/3 + seconds=200/600 → leg avg = 100s / 200s.
    const skewedTransfer = makeTransferRoute({
      transferName: '교대',
      fromLine: '2',
      toLine: '3',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    skewedTransfer.secondsToTransfer = 200;
    skewedTransfer.secondsFromTransfer = 600;
    await scheduleHopsForLock({ lock, route: skewedTransfer, destinationName: '오금' });
    // hop[0]: arrival = NOW + 200_000. lead = 200/2 = 100s → fires NOW+100_000.
    expect(triggerMsByIdentifier((id) => id.endsWith(':교대') && id.includes(':early:'))).toBe(
      NOW + 100_000,
    );
    // hop[1]: arrival = NOW + 800_000. lead = 600/3 = 200s → fires NOW+600_000.
    expect(triggerMsByIdentifier((id) => id.endsWith(':오금') && id.includes(':early:'))).toBe(
      NOW + 600_000,
    );
  });

  it('multi-transfer: 각 leg 누적 + leg별 lead 적용', async () => {
    // multiRoute targets: 교대(2,240s), 약수(2,240s), 한강진(1,120s), 온수(2,240s). window=3.
    await scheduleHopsForLock({ lock, route: multiRoute, destinationName: '온수' });
    // 교대: arrival NOW+240k, lead 120s → NOW+120k.
    expect(triggerMsByIdentifier((id) => id.endsWith(':교대') && id.includes(':early:'))).toBe(
      NOW + 120_000,
    );
    // 약수: arrival NOW+480k, lead 120s → NOW+360k.
    expect(triggerMsByIdentifier((id) => id.endsWith(':약수') && id.includes(':early:'))).toBe(
      NOW + 360_000,
    );
    // 한강진: arrival NOW+600k, lead 120s(1 hop이라 leg 전체) → NOW+480k.
    expect(triggerMsByIdentifier((id) => id.endsWith(':한강진') && id.includes(':early:'))).toBe(
      NOW + 480_000,
    );
  });

  it('multi-transfer: transferName === destinationName 케이스 첫 leg만 사용', async () => {
    // 목적지가 첫 환승역과 같으면 targets는 첫 환승역 하나만 — secondsToTransfer 적용.
    const collapsedMulti = makeMultiTransferRoute({
      transfers: [
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 2 },
        { transferName: '약수', fromLine: '3', toLine: '6', stopsToTransfer: 2 },
      ],
      stopsAfterLastTransfer: 0,
    });
    await scheduleHopsForLock({ lock, route: collapsedMulti, destinationName: '교대' });
    // hop[0] 교대(목적지): arrival = NOW + 240_000, lead 120s → NOW+120_000.
    expect(triggerMsByIdentifier((id) => id.endsWith(':교대') && id.includes(':early:'))).toBe(
      NOW + 120_000,
    );
  });

  it('stops=0 leg은 lead가 HOP_TIME_MS(90s)로 fallback (division-by-zero 방지)', async () => {
    // arrival>0 + stops=0인 경계 케이스(collapsed transfer + legSeconds>0)로 fallback 분기를
    // 실제로 트리거해서 lead=HOP_TIME_MS(=90_000)임을 fire time으로 단언.
    // legSeconds=120 → arrival=NOW+120_000. early lead=90_000 → fires NOW+30_000.
    const collapsedZeroStops = makeTransferRoute({
      transferName: '교대',
      fromLine: '2',
      toLine: '3',
      stopsToTransfer: 0,
      stopsFromTransfer: 0,
    });
    collapsedZeroStops.secondsToTransfer = 120;
    await scheduleHopsForLock({ lock, route: collapsedZeroStops, destinationName: '교대' });
    expect(triggerMsByIdentifier((id) => id.includes(':early:'))).toBe(NOW + 30_000);
  });

  it('advanceHopWindow도 새 timing(누적 secondsXxx)로 예약', async () => {
    mockedGet.mockResolvedValueOnce([]);
    await advanceHopWindow({
      lock,
      route: multiRoute,
      destinationName: '온수',
      passedStationName: '교대',
    });
    // 교대(0) 통과 → 약수(1)/한강진(2)/온수(3) 예약. 온수 arrival = 240+240+120+240 = 840s.
    // lead 120s → fires NOW+720_000.
    expect(triggerMsByIdentifier((id) => id.endsWith(':온수') && id.includes(':early:'))).toBe(
      NOW + 720_000,
    );
  });
});

describe('routeSignature', () => {
  it('route=null이면 null', () => {
    expect(routeSignature(null, '강남')).toBeNull();
  });

  it('destinationName=null이면 null', () => {
    expect(routeSignature(directRoute, null)).toBeNull();
  });

  it('같은 구조의 다른 객체는 동일 signature', () => {
    const a = makeDirectRoute(2, '2');
    const b = makeDirectRoute(2, '2');
    expect(routeSignature(a, '강남')).toBe(routeSignature(b, '강남'));
  });

  it('stops가 다르면 signature 다름', () => {
    const a = makeDirectRoute(2, '2');
    const b = makeDirectRoute(3, '2');
    expect(routeSignature(a, '강남')).not.toBe(routeSignature(b, '강남'));
  });

  it('환승 추가되면 signature 다름', () => {
    expect(routeSignature(directRoute, '강남')).not.toBe(
      routeSignature(transferRoute, '오금'),
    );
  });

  it('destinationName이 다르면 signature 다름', () => {
    expect(routeSignature(directRoute, '강남')).not.toBe(
      routeSignature(directRoute, '잠실'),
    );
  });
});

describe('rescheduleHopForLock (#698)', () => {
  it('일치하는 사전 예약 없으면 cancel/schedule 모두 호출 안 함', async () => {
    mockedGet.mockResolvedValueOnce(['bl:T-100:0:early:다른역']);
    const result = await rescheduleHopForLock({
      lock,
      route: directRoute,
      destinationName: '강남',
      nextStation: '강남',
      newArrivalMs: NOW + 600_000,
    });
    expect(result).toEqual({ cancelled: 0, scheduled: 0 });
    expect(mockedCancel).not.toHaveBeenCalled();
    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(mockedRemove).not.toHaveBeenCalled();
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it('nextStation 매칭되는 사전 예약을 cancel + 새 arrivalMs로 재예약', async () => {
    mockedGet.mockResolvedValueOnce([
      'bl:T-100:0:early:강남',
      'bl:T-100:0:imminent:강남',
      'bl:T-100:1:early:잠실', // 다른 hop — 보존
      'bl:T-200:0:early:강남', // 다른 lock — 보존
    ]);
    const newArrivalMs = NOW + 600_000; // 충분히 미래
    const result = await rescheduleHopForLock({
      lock,
      route: directRoute,
      destinationName: '강남',
      nextStation: '강남',
      newArrivalMs,
      now: NOW,
    });
    expect(mockedCancel).toHaveBeenCalledTimes(2);
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:early:강남');
    expect(mockedCancel).toHaveBeenCalledWith('bl:T-100:0:imminent:강남');
    expect(mockedRemove).toHaveBeenCalledWith([
      'bl:T-100:0:early:강남',
      'bl:T-100:0:imminent:강남',
    ]);
    // 재예약: directRoute stops=2, travel=240s → earlyLeadMs=120s, imminentLeadMs=45s
    // 두 trigger 모두 newArrivalMs 미만 → 2건 schedule
    expect(mockedSchedule).toHaveBeenCalledTimes(2);
    const scheduledIds = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(scheduledIds).toContain('bl:T-100:0:early:강남');
    expect(scheduledIds).toContain('bl:T-100:0:imminent:강남');
    const earlyCall = mockedSchedule.mock.calls.find((c) => c[0].identifier === 'bl:T-100:0:early:강남')!;
    const earlyTrigger = earlyCall[0].trigger as { date: Date };
    expect(earlyTrigger.date.getTime()).toBe(newArrivalMs - 120_000);
    const imminentCall = mockedSchedule.mock.calls.find(
      (c) => c[0].identifier === 'bl:T-100:0:imminent:강남',
    )!;
    const imminentTrigger = imminentCall[0].trigger as { date: Date };
    expect(imminentTrigger.date.getTime()).toBe(newArrivalMs - 45_000);
    expect(mockedAdd).toHaveBeenCalledWith([
      'bl:T-100:0:early:강남',
      'bl:T-100:0:imminent:강남',
    ]);
    expect(result).toEqual({ cancelled: 2, scheduled: 2 });
  });

  it('newArrivalMs가 now 직후이면 과거 phase는 skip', async () => {
    mockedGet.mockResolvedValueOnce([
      'bl:T-100:0:early:강남',
      'bl:T-100:0:imminent:강남',
    ]);
    // newArrivalMs = NOW+30s → imminent(45s lead)는 NOW-15s 과거, early(120s lead)도 과거 → 둘 다 skip
    const result = await rescheduleHopForLock({
      lock,
      route: directRoute,
      destinationName: '강남',
      nextStation: '강남',
      newArrivalMs: NOW + 30_000,
      now: NOW,
    });
    expect(mockedCancel).toHaveBeenCalledTimes(2);
    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(mockedAdd).not.toHaveBeenCalled();
    expect(result).toEqual({ cancelled: 2, scheduled: 0 });
  });

  it('nextStation이 route 안에 없으면 cancel만 수행하고 재예약 skip', async () => {
    // route는 destinationName='강남' direct이지만, 추적 큐에 알 수 없는 station id가 있고
    // nextStation이 route 상 target과 매칭되지 않는 케이스 — 정정 신호 폐기.
    mockedGet.mockResolvedValueOnce(['bl:T-100:0:early:없는역']);
    const result = await rescheduleHopForLock({
      lock,
      route: directRoute,
      destinationName: '강남',
      nextStation: '없는역',
      newArrivalMs: NOW + 600_000,
      now: NOW,
    });
    expect(mockedCancel).toHaveBeenCalledTimes(1);
    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(result).toEqual({ cancelled: 1, scheduled: 0 });
  });

  it('target.stops=0이면 earlyLeadMs는 HOP_TIME_MS fallback', async () => {
    // stops=0 direct route → travelSeconds=0 → arrival 즉시. newArrivalMs를 충분히 미래로 두면
    // imminent(45s lead)와 early(HOP_TIME_MS fallback) 모두 미래 → 2건 schedule.
    mockedGet.mockResolvedValueOnce(['bl:T-100:0:early:강남']);
    const zeroStopsRoute = makeDirectRoute(0, '2');
    const result = await rescheduleHopForLock({
      lock,
      route: zeroStopsRoute,
      destinationName: '강남',
      nextStation: '강남',
      newArrivalMs: NOW + 600_000,
      now: NOW,
    });
    expect(result.cancelled).toBe(1);
    expect(mockedSchedule).toHaveBeenCalled();
  });

  it('default now는 Date.now() — newArrivalMs가 충분히 미래면 정상 동작', async () => {
    mockedGet.mockResolvedValueOnce(['bl:T-100:0:early:강남']);
    const spy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const result = await rescheduleHopForLock({
        lock,
        route: directRoute,
        destinationName: '강남',
        nextStation: '강남',
        newArrivalMs: NOW + 600_000,
      });
      expect(result.cancelled).toBe(1);
      expect(result.scheduled).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});

// #1282 — bl: route-sig 영속화 함수 단위 테스트.
describe('setRegisteredBlRouteSig / getRegisteredBlRouteSig / clearRegisteredBlRouteSig (#1282)', () => {
  it('setRegisteredBlRouteSig: AsyncStorage.setItem을 올바른 키/값으로 호출한다', async () => {
    await setRegisteredBlRouteSig('SIG-ABC');
    expect(mockAsyncSetItem).toHaveBeenCalledWith(
      'subway-now:boarding-lock-route-sig',
      'SIG-ABC',
    );
  });

  it('setRegisteredBlRouteSig: setItem 실패 시 graceful (throw 없음)', async () => {
    mockAsyncSetItem.mockRejectedValueOnce(new Error('storage fail'));
    await expect(setRegisteredBlRouteSig('SIG-X')).resolves.toBeUndefined();
  });

  it('getRegisteredBlRouteSig: 저장된 값을 반환한다', async () => {
    mockAsyncGetItem.mockResolvedValueOnce('SIG-ABC');
    const result = await getRegisteredBlRouteSig();
    expect(result).toBe('SIG-ABC');
    expect(mockAsyncGetItem).toHaveBeenCalledWith('subway-now:boarding-lock-route-sig');
  });

  it('getRegisteredBlRouteSig: 값 없으면 null', async () => {
    mockAsyncGetItem.mockResolvedValueOnce(null);
    const result = await getRegisteredBlRouteSig();
    expect(result).toBeNull();
  });

  it('getRegisteredBlRouteSig: getItem 실패 시 null 반환 (graceful)', async () => {
    mockAsyncGetItem.mockRejectedValueOnce(new Error('storage fail'));
    const result = await getRegisteredBlRouteSig();
    expect(result).toBeNull();
  });

  it('clearRegisteredBlRouteSig: AsyncStorage.removeItem을 올바른 키로 호출한다', async () => {
    await clearRegisteredBlRouteSig();
    expect(mockAsyncRemoveItem).toHaveBeenCalledWith('subway-now:boarding-lock-route-sig');
  });

  it('clearRegisteredBlRouteSig: removeItem 실패 시 graceful (throw 없음)', async () => {
    mockAsyncRemoveItem.mockRejectedValueOnce(new Error('storage fail'));
    await expect(clearRegisteredBlRouteSig()).resolves.toBeUndefined();
  });
});

// #1282 — cancel/purge 경로가 항상 clearRegisteredBlRouteSig(=BOARDING_LOCK_ROUTE_SIG_KEY
// removeItem)를 호출하는지 통합 검증. 호출자/큐 상태만 다르고 단언이 동일하므로 it.each로 통합.
describe('route-sig cleanup 통합 (#1282)', () => {
  it.each([
    {
      name: 'cancelAllHopsForLock: 취소 대상이 있어도',
      queued: ['bl:T-100:0:early:강남', 'bl:T-100:0:imminent:강남'],
      run: () => cancelAllHopsForLock(lock),
    },
    {
      name: 'cancelAllHopsForLock: 취소 대상이 없어도',
      queued: [],
      run: () => cancelAllHopsForLock(lock),
    },
    {
      name: 'purgeBoardingLockSchedulerQueue',
      queued: [],
      run: () => purgeBoardingLockSchedulerQueue(),
    },
  ])('$name clearRegisteredBlRouteSig를 호출한다', async ({ queued, run }) => {
    mockedGet.mockResolvedValueOnce(queued);
    await run();
    expect(mockAsyncRemoveItem).toHaveBeenCalledWith('subway-now:boarding-lock-route-sig');
  });
});

describe('scheduleHopsForLock #1357 (S1) motion gate', () => {
  beforeEach(() => {
    const { resetAlarmLogForTest } = jest.requireActual('../alarmLog');
    resetAlarmLogForTest();
  });

  it('motion=stationary 확정이면 schedule을 skip하고 [] 반환', async () => {
    mockGetCurrentMotionStationary.mockReturnValue(true);
    const ids = await scheduleHopsForLock({
      lock,
      route: directRoute,
      destinationName: '강남',
      now: NOW,
    });
    expect(ids).toEqual([]);
    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it('motion=stationary 시 alarm_log에 schedule-skipped-motion-stationary 적재 (channel=bl)', async () => {
    mockGetCurrentMotionStationary.mockReturnValue(true);
    await scheduleHopsForLock({
      lock,
      route: directRoute,
      destinationName: '강남',
      now: NOW,
    });
    const entries = await jest.requireActual('../alarmLog').getAlarmLog();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'schedule-skipped-motion-stationary',
          source: 'bg-scheduled',
          outcome: 'suppressed',
          stationName: 'bl:강남',
        }),
      ]),
    );
  });

  it('motion=false (이동 중)이면 정상 schedule 진행', async () => {
    mockGetCurrentMotionStationary.mockReturnValue(false);
    const ids = await scheduleHopsForLock({
      lock,
      route: directRoute,
      destinationName: '강남',
      now: NOW,
    });
    expect(ids.length).toBeGreaterThan(0);
    expect(mockedSchedule).toHaveBeenCalled();
  });

  it('sleepMode ON + motion=stationary면 motion gate가 먼저 동작 — sleep 별도 게이트 진입 전 skip', async () => {
    // motion gate가 hop 루프 진입 전 차단하므로 sleep first-transfer 게이트와 무관.
    // 본 테스트는 게이트 평가 순서 보장 — sleep flow는 기존 #632 describe에서 검증.
    mockGetCurrentMotionStationary.mockReturnValue(true);
    const ids = await scheduleHopsForLock({
      lock,
      route: transferRoute,
      destinationName: '강남',
      now: NOW,
      sleepMode: true,
    });
    expect(ids).toEqual([]);
    expect(mockedSchedule).not.toHaveBeenCalled();
  });
});
