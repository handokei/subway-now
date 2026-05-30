import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  scheduleAlarmsForRoute,
  cancelScheduledAlarms,
  scheduledAlarmIdentifier,
  parseScheduledAlarmIdentifier,
} from '../alarmScheduler';
import { logScheduledAlarm } from '../alarmLog';
import { getLastNotifiedStationId } from '../notificationState';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../testUtils/routeFixtures';

jest.mock('expo-notifications');
jest.mock('../logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../alarmLog', () => ({
  logScheduledAlarm: jest.fn(),
}));
jest.mock('../notificationState', () => ({
  getLastNotifiedStationId: jest.fn(),
}));

const mockedLogScheduled = logScheduledAlarm as jest.MockedFunction<typeof logScheduledAlarm>;
const mockedGetLastNotified = getLastNotifiedStationId as jest.MockedFunction<
  typeof getLastNotifiedStationId
>;

const NOW = new Date('2026-05-13T12:00:00Z').getTime();

describe('scheduledAlarmIdentifier', () => {
  it('phaseId와 stationName을 prefix와 결합한 id를 반환한다', () => {
    expect(scheduledAlarmIdentifier({ phaseId: 'early', stationName: '강남' })).toBe(
      'alarm:early:강남',
    );
    expect(scheduledAlarmIdentifier({ phaseId: 'imminent', stationName: '시청' })).toBe(
      'alarm:imminent:시청',
    );
  });
});

describe('parseScheduledAlarmIdentifier', () => {
  it('alarm: prefix가 없으면 null', () => {
    expect(parseScheduledAlarmIdentifier('current-station')).toBeNull();
  });
  it('phaseId가 빈 문자열이면 null', () => {
    expect(parseScheduledAlarmIdentifier('alarm::강남')).toBeNull();
  });
  it('콜론이 없으면 null', () => {
    expect(parseScheduledAlarmIdentifier('alarm:onlyphase')).toBeNull();
  });
  it('stationName이 비어 있으면 null', () => {
    expect(parseScheduledAlarmIdentifier('alarm:early:')).toBeNull();
  });
  it('유효한 identifier를 파싱한다', () => {
    expect(parseScheduledAlarmIdentifier('alarm:early:강남')).toEqual({
      phaseId: 'early',
      stationName: '강남',
    });
  });
});

describe('scheduleAlarmsForRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Notifications.scheduleNotificationAsync as jest.Mock).mockResolvedValue('id');
    mockedGetLastNotified.mockResolvedValue(null);
    jest.replaceProperty(Platform, 'OS', 'ios');
  });

  it('direct 경로는 도착역 1 waypoint × 2 phase = 2개 알람을 예약한다', async () => {
    const route = makeDirectRoute(10, '1');
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 600,
      now: NOW,
    });

    expect(result).toHaveLength(2);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);

    // finalEta = 600 + 10*90 = 1500s, destination ETA = 1500s
    // early: 1500 - 90 = 1410s, imminent: 1500 - 10 = 1490s
    expect(result[0]).toMatchObject({
      identifier: 'alarm:early:강남',
      event: { phaseId: 'early', type: 'destination', stationName: '강남' },
      fireDate: new Date(NOW + 1_410_000),
    });
    expect(result[1]).toMatchObject({
      identifier: 'alarm:imminent:강남',
      event: { phaseId: 'imminent', type: 'destination', stationName: '강남' },
      fireDate: new Date(NOW + 1_490_000),
    });
  });

  it('transfer 경로는 환승 + 도착 = 2 waypoint × 2 phase = 4개 알람을 예약한다 (2(N+1), N=1)', async () => {
    const route = makeTransferRoute({
      transferName: '동대문',
      fromLine: '1',
      toLine: '4',
      stopsToTransfer: 4,
      stopsFromTransfer: 6,
    });
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 1000,
      now: NOW,
    });

    expect(result).toHaveLength(4);

    // finalEta = 1000 + 10*90 = 1900s
    // 환승역 ETA = (4/10) * 1900 = 760s
    expect(result[0]).toMatchObject({
      identifier: 'alarm:early:동대문',
      event: { phaseId: 'early', type: 'transfer', stationName: '동대문' },
      fireDate: new Date(NOW + (760 - 90) * 1000),
    });
    expect(result[1]).toMatchObject({
      identifier: 'alarm:imminent:동대문',
      fireDate: new Date(NOW + (760 - 10) * 1000),
    });
    // 도착역 ETA = 1900s
    expect(result[2]).toMatchObject({
      identifier: 'alarm:early:강남',
      event: { phaseId: 'early', type: 'destination', stationName: '강남' },
      fireDate: new Date(NOW + (1900 - 90) * 1000),
    });
    expect(result[3]).toMatchObject({
      identifier: 'alarm:imminent:강남',
      fireDate: new Date(NOW + (1900 - 10) * 1000),
    });
  });

  it('multi-transfer 경로는 3 waypoint × 2 phase = 6개 알람을 예약한다 (N=2)', async () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '동대문', fromLine: '1', toLine: '4', stopsToTransfer: 3 },
        { transferName: '서울역', fromLine: '4', toLine: '2', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 2,
    });
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 1000,
      now: NOW,
    });

    expect(result).toHaveLength(6);
    expect(result.map((r) => r.identifier)).toEqual([
      'alarm:early:동대문',
      'alarm:imminent:동대문',
      'alarm:early:서울역',
      'alarm:imminent:서울역',
      'alarm:early:강남',
      'alarm:imminent:강남',
    ]);
  });

  it('currentStationApproachEtaSeconds가 null이면 calculateStaticETA로 fallback한다', async () => {
    const route = makeDirectRoute(10, '1');
    // calculateStaticETA(direct stops=10) = 3 wait + 10*2 = 23 min = 1380s
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: null,
      now: NOW,
    });

    expect(result).toHaveLength(2);
    expect(result[0].fireDate).toEqual(new Date(NOW + (1380 - 90) * 1000));
    expect(result[1].fireDate).toEqual(new Date(NOW + (1380 - 10) * 1000));
  });

  it('currentStationApproachEtaSeconds가 0 이하면 fallback을 사용한다', async () => {
    const route = makeDirectRoute(10, '1');
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 0,
      now: NOW,
    });
    // staticETA fallback 적용 → 1380s
    expect(result[0].fireDate).toEqual(new Date(NOW + (1380 - 90) * 1000));
  });

  it('totalStops가 0이면 빈 배열을 반환한다 (이미 목적지)', async () => {
    const route = makeDirectRoute(0, '1');
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 600,
      now: NOW,
    });

    expect(result).toEqual([]);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('stops=0 waypoint(이미 도착한 환승역 등)는 두 phase 모두 건너뛰고 다음 waypoint만 예약한다', async () => {
    // 환승역에 이미 도착해 stopsToTransfer=0인 trip — transfer는 waypointEta=0이라 fire<=0으로 모두 skip.
    const route = makeTransferRoute({
      transferName: '동대문',
      fromLine: '1',
      toLine: '4',
      stopsToTransfer: 0,
      stopsFromTransfer: 5,
    });
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 60,
      now: NOW,
    });

    // totalStops=5, finalEta = 60 + 5*90 = 510s
    // 동대문 cumulative=0 → waypointEta=0 → 두 phase 모두 skip
    // 강남 cumulative=5 → waypointEta=510s → early(420), imminent(500) 모두 예약
    expect(result.map((r) => r.identifier)).toEqual([
      'alarm:early:강남',
      'alarm:imminent:강남',
    ]);
    expect(result[0].fireDate).toEqual(new Date(NOW + 420_000));
    expect(result[1].fireDate).toEqual(new Date(NOW + 500_000));
  });

  it('iOS에서는 interruptionLevel: timeSensitive를 포함한다', async () => {
    const route = makeDirectRoute(10, '1');
    await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 600,
      now: NOW,
    });

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          sound: 'alarm.wav',
          interruptionLevel: 'timeSensitive',
        }),
      }),
    );
  });

  it('Android에서는 channelId와 priority MAX를 포함한다', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const route = makeDirectRoute(10, '1');
    await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 600,
      now: NOW,
    });

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          channelId: 'station-alarm',
        }),
      }),
    );
  });

  it('scheduleNotificationAsync 호출 시 trigger.date에 fireDate가 전달된다', async () => {
    const route = makeDirectRoute(10, '1');
    await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 600,
      now: NOW,
    });

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: 'alarm:early:강남',
        trigger: { type: 'date', date: new Date(NOW + 1_410_000) },
      }),
    );
  });

  it('now를 생략하면 Date.now()를 사용한다', async () => {
    const route = makeDirectRoute(10, '1');
    const before = Date.now();
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 600,
    });
    const after = Date.now();

    // early fireDate ≈ now + 1410s
    const fire = result[0].fireDate.getTime();
    expect(fire).toBeGreaterThanOrEqual(before + 1_410_000);
    expect(fire).toBeLessThanOrEqual(after + 1_410_000);
  });

  // ── #372 stamp ──
  it('stamp + last-notified를 각 예약 알람에 함께 적재한다', async () => {
    const route = makeDirectRoute(10, '1');
    mockedGetLastNotified.mockResolvedValueOnce('S-prev');

    await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 600,
      now: NOW,
      stamp: { direction: 'up', usedTrainCode: 'T-99' },
    });

    expect(mockedLogScheduled).toHaveBeenCalledTimes(2);
    expect(mockedLogScheduled).toHaveBeenNthCalledWith(
      1,
      { phaseId: 'early', type: 'destination', stationName: '강남' },
      {
        direction: 'up',
        usedTrainCode: 'T-99',
        selectedArrivalSeconds: 600,
        expectedStationAtFire: '강남',
        actualLastNotifiedStation: 'S-prev',
      },
    );
    expect(mockedLogScheduled).toHaveBeenNthCalledWith(
      2,
      { phaseId: 'imminent', type: 'destination', stationName: '강남' },
      expect.objectContaining({
        direction: 'up',
        usedTrainCode: 'T-99',
        actualLastNotifiedStation: 'S-prev',
      }),
    );
  });

  it('stamp 미지정이면 direction/usedTrainCode가 null로 기록된다', async () => {
    const route = makeDirectRoute(10, '1');

    await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: null,
      now: NOW,
    });

    expect(mockedLogScheduled).toHaveBeenCalled();
    expect(mockedLogScheduled).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        direction: null,
        usedTrainCode: null,
        selectedArrivalSeconds: null,
        actualLastNotifiedStation: null,
      }),
    );
  });

  it('skip된 phase(예: stops=0 waypoint)는 logScheduledAlarm을 호출하지 않는다', async () => {
    // stopsToTransfer=0이면 환승역 waypoint는 fireSeconds<=0으로 두 phase 모두 skip되어
    // log도 남기지 않는다. 도착역 phase 2회만 stamp된다.
    const route = makeTransferRoute({
      transferName: '동대문',
      fromLine: '1',
      toLine: '4',
      stopsToTransfer: 0,
      stopsFromTransfer: 5,
    });
    await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      currentStationApproachEtaSeconds: 60,
      now: NOW,
    });
    expect(mockedLogScheduled).toHaveBeenCalledTimes(2);
    expect(mockedLogScheduled.mock.calls.every(([event]) => event.stationName === '강남')).toBe(
      true,
    );
  });
});

describe('cancelScheduledAlarms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('alarm: prefix를 가진 알림만 취소한다', async () => {
    (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValue([
      { identifier: 'alarm:early:강남' },
      { identifier: 'alarm:imminent:강남' },
      { identifier: 'current-station' },
      { identifier: 'station-passed' },
    ]);

    await cancelScheduledAlarms();

    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(2);
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith('alarm:early:강남');
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
      'alarm:imminent:강남',
    );
    expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalledWith(
      'current-station',
    );
  });

  it('예약된 알람이 없으면 cancel을 호출하지 않는다', async () => {
    (Notifications.getAllScheduledNotificationsAsync as jest.Mock).mockResolvedValue([]);

    await cancelScheduledAlarms();

    expect(Notifications.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
  });
});
