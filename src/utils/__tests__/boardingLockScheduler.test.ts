import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  advanceHopWindow,
  boardingLockAlarmIdentifier,
  cancelAllHopsForLock,
  parseBoardingLockAlarmIdentifier,
  purgeBoardingLockSchedulerQueue,
  scheduleHopsForLock,
} from '../boardingLockScheduler';
import {
  addScheduledNotificationIds,
  getScheduledNotificationIds,
  removeScheduledNotificationIds,
  clearScheduledNotificationIds,
} from '../scheduledNotificationsStorage';
import type { BoardingLock } from '../../types/boardingLock';
import type { DirectRoute, TransferRoute, MultiTransferRoute } from '../stationRoute';

jest.mock('expo-notifications');
jest.mock('../scheduledNotificationsStorage', () => ({
  addScheduledNotificationIds: jest.fn(),
  removeScheduledNotificationIds: jest.fn(),
  getScheduledNotificationIds: jest.fn(),
  clearScheduledNotificationIds: jest.fn(),
}));
jest.mock('../logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
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

const directRoute: DirectRoute = { type: 'direct', stops: 2, line: '2' };
const transferRoute: TransferRoute = {
  type: 'transfer',
  transferName: '교대',
  fromLine: '2',
  toLine: '3',
  stopsToTransfer: 2,
  stopsFromTransfer: 3,
};
const multiRoute: MultiTransferRoute = {
  type: 'multi-transfer',
  transfers: [
    { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 2 },
    { transferName: '약수', fromLine: '3', toLine: '6', stopsToTransfer: 2 },
    { transferName: '한강진', fromLine: '6', toLine: '7', stopsToTransfer: 1 },
  ],
  stopsAfterLastTransfer: 2,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedGet.mockResolvedValue([]);
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

    // 2 stops * 90s = 180s; early lead = 90s, imminent lead = 45s → 둘 다 양수
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

  it('multi-transfer: windowSize 3으로 잘림 — 4번째 waypoint(목적지)는 예약 안 됨', async () => {
    await scheduleHopsForLock({ lock, route: multiRoute, destinationName: '온수' });
    // targets = 교대, 약수, 한강진, 온수. window=3 → 온수 skip
    const ids = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(ids.some((id) => id.includes(':2:'))).toBe(true); // 한강진(idx=2)
    expect(ids.some((id) => id.includes(':3:'))).toBe(false); // 온수(idx=3) skip
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
    // direct stops=2 → waypointEta=180s. now를 boardedAt + 200초로 잡으면 둘 다 음수.
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

  it('#632 sleepMode=true + 첫 hop이 transfer면 그 hop schedule skip, 둘째 hop은 정상', async () => {
    // transferRoute: targets = 교대(transfer, 2 stops), 오금(destination, 3 stops)
    await scheduleHopsForLock({
      lock,
      route: transferRoute,
      destinationName: '오금',
      sleepMode: true,
    });
    const ids = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(ids).not.toContain('bl:T-100:0:early:교대');
    expect(ids).not.toContain('bl:T-100:0:imminent:교대');
    expect(ids).toContain('bl:T-100:1:early:오금');
    expect(ids).toContain('bl:T-100:1:imminent:오금');
    expect(mockedAdd).toHaveBeenCalledWith([
      'bl:T-100:1:early:오금',
      'bl:T-100:1:imminent:오금',
    ]);
  });

  it('#632 sleepMode=true + 첫 hop이 destination이면 정상 schedule (skip 없음)', async () => {
    await scheduleHopsForLock({
      lock,
      route: directRoute,
      destinationName: '강남',
      sleepMode: true,
    });
    expect(mockedSchedule).toHaveBeenCalledTimes(2);
    const ids = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(ids).toContain('bl:T-100:0:early:강남');
    expect(ids).toContain('bl:T-100:0:imminent:강남');
  });

  it('#632 sleepMode=false + 첫 hop이 transfer여도 정상 schedule', async () => {
    await scheduleHopsForLock({
      lock,
      route: transferRoute,
      destinationName: '오금',
      sleepMode: false,
    });
    expect(mockedSchedule).toHaveBeenCalledTimes(4);
  });

  it('빈 targets은 storage write도 빈 배열', async () => {
    // direct stops=0 → totalStops=0, but resolveAllTargets returns 1 entry with stops=0.
    // waypointEta=0 → 모든 phase에서 fireSeconds <= 0 → 예약 안 됨.
    const zeroRoute: DirectRoute = { type: 'direct', stops: 0, line: '2' };
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
});

describe('purgeBoardingLockSchedulerQueue', () => {
  it('큐가 비어있으면 no-op', async () => {
    mockedGet.mockResolvedValueOnce([]);
    await purgeBoardingLockSchedulerQueue();
    expect(mockedCancel).not.toHaveBeenCalled();
    expect(mockedClear).not.toHaveBeenCalled();
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
    // 1은 이미 있으므로 skip, 2(한강진)와 3(온수)는 채움. (windowSize=3 → 범위 [1..3])
    expect(newIds.some((id) => id.startsWith('bl:T-100:1:'))).toBe(false);
    expect(newIds.some((id) => id.startsWith('bl:T-100:2:'))).toBe(true);
    expect(newIds.some((id) => id.startsWith('bl:T-100:3:'))).toBe(true);
  });

  it('정상 호출(0 → 1): hopIndex 0 cancel + window 끝 hop만 새로 예약', async () => {
    // multiRoute targets: 교대(0), 약수(1), 한강진(2), 온수(3). window=3 → 0,1,2 예약됨.
    // 교대 통과 시: hopIndex 0 cancel + 새 hop = passedIndex(0) + window(3) = 3 (온수) 예약.
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

  it('#632 sleepMode=true + passedIndex+1 hop이 transfer면 그 hop만 skip, 그 다음은 정상', async () => {
    // multiRoute: 교대(0,t), 약수(1,t), 한강진(2,t), 온수(3,d). 교대 통과 후 새 첫 hop=약수(transfer).
    mockedGet.mockResolvedValueOnce([]);
    await advanceHopWindow({
      lock,
      route: multiRoute,
      destinationName: '온수',
      passedStationName: '교대',
      sleepMode: true,
    });
    const ids = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(ids.some((id) => id.startsWith('bl:T-100:1:'))).toBe(false);
    expect(ids.some((id) => id.startsWith('bl:T-100:2:'))).toBe(true);
    expect(ids.some((id) => id.startsWith('bl:T-100:3:'))).toBe(true);
  });

  it('#632 sleepMode=true + out-of-order advance(passedIndex 점프): 새 첫 hop(=passedIndex+1)만 skip 대상', async () => {
    // multiRoute: 교대(0,t), 약수(1,t), 한강진(2,t), 온수(3,d).
    // GPS 점프로 약수(1)를 건너뛰고 한강진(2) 직전에 advance(passedStationName=약수) — 큐는 비어있다.
    // 새 hop 시작점 = 2 (한강진, transfer)이므로 그 hop만 skip되어야 함. hop 3(온수, destination)은 정상 schedule.
    mockedGet.mockResolvedValueOnce([]);
    await advanceHopWindow({
      lock,
      route: multiRoute,
      destinationName: '온수',
      passedStationName: '약수',
      sleepMode: true,
    });
    const ids = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(ids.some((id) => id.startsWith('bl:T-100:2:'))).toBe(false);
    expect(ids.some((id) => id.startsWith('bl:T-100:3:'))).toBe(true);
  });

  it('#632 sleepMode=true + passedIndex+1 hop이 destination이면 정상 schedule', async () => {
    // transferRoute: 교대(0,t), 오금(1,d). 교대 통과 후 새 첫 hop = 오금(destination) → skip 안 함.
    mockedGet.mockResolvedValueOnce([]);
    await advanceHopWindow({
      lock,
      route: transferRoute,
      destinationName: '오금',
      passedStationName: '교대',
      sleepMode: true,
    });
    const ids = mockedSchedule.mock.calls.map((c) => c[0].identifier ?? '');
    expect(ids).toContain('bl:T-100:1:early:오금');
    expect(ids).toContain('bl:T-100:1:imminent:오금');
  });
});
