import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  scheduleAlarmsForRoute,
  cancelScheduledAlarms,
  scheduledAlarmIdentifier,
  parseScheduledAlarmIdentifier,
} from '../alarmScheduler';
import type {
  DirectRoute,
  TransferRoute,
  MultiTransferRoute,
} from '../stationRoute';

jest.mock('expo-notifications');
jest.mock('../logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

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
    jest.replaceProperty(Platform, 'OS', 'ios');
  });

  it('direct 경로는 도착역 1 waypoint × 2 phase = 2개 알람을 예약한다', async () => {
    const route: DirectRoute = { type: 'direct', stops: 10, line: '1' };
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: 600,
      now: NOW,
    });

    expect(result).toHaveLength(2);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);

    // finalEta = 600 + (10-1)*90 = 1410s, destination ETA = 1410s
    // early: 1410 - 90 = 1320s, imminent: 1410 - 10 = 1400s
    expect(result[0]).toMatchObject({
      identifier: 'alarm:early:강남',
      event: { phaseId: 'early', type: 'destination', stationName: '강남' },
      fireDate: new Date(NOW + 1_320_000),
    });
    expect(result[1]).toMatchObject({
      identifier: 'alarm:imminent:강남',
      event: { phaseId: 'imminent', type: 'destination', stationName: '강남' },
      fireDate: new Date(NOW + 1_400_000),
    });
  });

  it('transfer 경로는 환승 + 도착 = 2 waypoint × 2 phase = 4개 알람을 예약한다 (2(N+1), N=1)', async () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '동대문',
      fromLine: '1',
      toLine: '4',
      stopsToTransfer: 4,
      stopsFromTransfer: 6,
    };
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: 1000,
      now: NOW,
    });

    expect(result).toHaveLength(4);

    // finalEta = 1000 + (10-1)*90 = 1810s
    // 환승역 ETA = (4/10) * 1810 = 724s
    expect(result[0]).toMatchObject({
      identifier: 'alarm:early:동대문',
      event: { phaseId: 'early', type: 'transfer', stationName: '동대문' },
      fireDate: new Date(NOW + (724 - 90) * 1000),
    });
    expect(result[1]).toMatchObject({
      identifier: 'alarm:imminent:동대문',
      fireDate: new Date(NOW + (724 - 10) * 1000),
    });
    // 도착역 ETA = 1810s
    expect(result[2]).toMatchObject({
      identifier: 'alarm:early:강남',
      event: { phaseId: 'early', type: 'destination', stationName: '강남' },
      fireDate: new Date(NOW + (1810 - 90) * 1000),
    });
    expect(result[3]).toMatchObject({
      identifier: 'alarm:imminent:강남',
      fireDate: new Date(NOW + (1810 - 10) * 1000),
    });
  });

  it('multi-transfer 경로는 3 waypoint × 2 phase = 6개 알람을 예약한다 (N=2)', async () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '동대문', fromLine: '1', toLine: '4', stopsToTransfer: 3 },
        { transferName: '서울역', fromLine: '4', toLine: '2', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 2,
    };
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: 1000,
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

  it('nextStationEtaSeconds가 null이면 calculateStaticETA로 fallback한다', async () => {
    const route: DirectRoute = { type: 'direct', stops: 10, line: '1' };
    // calculateStaticETA(direct stops=10) = 3 wait + 10*2 = 23 min = 1380s
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: null,
      now: NOW,
    });

    expect(result).toHaveLength(2);
    expect(result[0].fireDate).toEqual(new Date(NOW + (1380 - 90) * 1000));
    expect(result[1].fireDate).toEqual(new Date(NOW + (1380 - 10) * 1000));
  });

  it('nextStationEtaSeconds가 0 이하면 fallback을 사용한다', async () => {
    const route: DirectRoute = { type: 'direct', stops: 10, line: '1' };
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: 0,
      now: NOW,
    });
    // staticETA fallback 적용 → 1380s
    expect(result[0].fireDate).toEqual(new Date(NOW + (1380 - 90) * 1000));
  });

  it('totalStops가 0이면 빈 배열을 반환한다 (이미 목적지)', async () => {
    const route: DirectRoute = { type: 'direct', stops: 0, line: '1' };
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: 600,
      now: NOW,
    });

    expect(result).toEqual([]);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('phase 시각이 과거(now 이전)면 해당 알람은 건너뛴다', async () => {
    const route: DirectRoute = { type: 'direct', stops: 1, line: '1' };
    // stops=1 → finalEta = 5 + 0*90 = 5s → early(5-90<0 skip), imminent(5-10<0 skip) → 0개
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: 5,
      now: NOW,
    });

    expect(result).toEqual([]);
  });

  it('early만 미래이고 imminent가 과거면 한쪽만 예약한다', async () => {
    const route: DirectRoute = { type: 'direct', stops: 1, line: '1' };
    // stops=1, ETA 50 → finalEta = 50s
    // early: 50-90 = -40 skip, imminent: 50-10 = 40, 예약
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: 50,
      now: NOW,
    });

    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('alarm:imminent:강남');
  });

  it('iOS에서는 interruptionLevel: timeSensitive를 포함한다', async () => {
    const route: DirectRoute = { type: 'direct', stops: 10, line: '1' };
    await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: 600,
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
    const route: DirectRoute = { type: 'direct', stops: 10, line: '1' };
    await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: 600,
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
    const route: DirectRoute = { type: 'direct', stops: 10, line: '1' };
    await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: 600,
      now: NOW,
    });

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: 'alarm:early:강남',
        trigger: { type: 'date', date: new Date(NOW + 1_320_000) },
      }),
    );
  });

  it('now를 생략하면 Date.now()를 사용한다', async () => {
    const route: DirectRoute = { type: 'direct', stops: 10, line: '1' };
    const before = Date.now();
    const result = await scheduleAlarmsForRoute({
      route,
      destinationName: '강남',
      nextStationEtaSeconds: 600,
    });
    const after = Date.now();

    // early fireDate ≈ now + 1320s
    const fire = result[0].fireDate.getTime();
    expect(fire).toBeGreaterThanOrEqual(before + 1_320_000);
    expect(fire).toBeLessThanOrEqual(after + 1_320_000);
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
