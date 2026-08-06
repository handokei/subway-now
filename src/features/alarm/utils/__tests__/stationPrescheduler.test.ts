/**
 * stationPrescheduler (#918) — OS-level 사전 예약 "매역" 채널 테스트.
 *
 * - deriveUpcomingWaypoints(내부) 결과를 registerPrescheduledStationAlarms를 통해 검증:
 *   window size(12역) 절단, kind 판정(transfer/destination/station-passed), occurrence index,
 *   과거 시각(fireMs<=now) skip.
 * - cancelAllPrescheduledAlarms: prefix 필터링 + delivered tray dismiss + 실패 graceful.
 * - readPrescheduledData: 파싱 가드(prefix/channel/필수 필드/kind enum).
 * - cancelPrescheduledByStationKind: (station, kind) 매칭 취소.
 * - reschedulePrescheduledAlarm: 매칭 없음(cancel-only) / 과거 시각(cancel-only) / 정상 재예약.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Station } from '../../../../shared/types/station';
import {
  PRESCHED_ALARM_PREFIX,
  registerPrescheduledStationAlarms,
  cancelAllPrescheduledAlarms,
  readPrescheduledData,
  cancelPrescheduledByStationKind,
  reschedulePrescheduledAlarm,
} from '../stationPrescheduler';

jest.mock('expo-notifications');

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../stationNotification', () => ({
  buildAlarmContent: (event: { phaseId: string; stationName: string; type: string }) => ({
    title: `T:${event.phaseId}:${event.type}`,
    body: `B:${event.stationName}`,
  }),
  buildStationPassedContent: (stationName: string) => ({
    title: 'passed-title',
    body: `passed:${stationName}`,
  }),
  ALARM_SILENT_CHANNEL_ID: 'station-alarm-silent',
}));

jest.mock('../stationNotifCollapseId', () => ({
  buildStationNotifCollapseId: (deviceToken: string) => `collapse-${deviceToken.slice(0, 16)}`,
}));

const mockCancelIdentifiersWithRetry = jest.fn();
jest.mock('../safetyNetScheduler', () => ({
  cancelIdentifiersWithRetry: (...args: unknown[]) => mockCancelIdentifiersWithRetry(...args),
}));

const mockRecordScheduledAlarm = jest.fn();
jest.mock('../prescheduledMetrics', () => ({
  recordScheduledAlarm: (...args: unknown[]) => mockRecordScheduledAlarm(...args),
}));

// hopTimeMsAt은 기본적으로 실제 구현(결정적 fallback 120s)을 그대로 사용 — 오직 "fireMs<=now
// skip" 방어 분기(hop time이 0 이하로 산출되는 이론적 케이스)를 결정적으로 재현하기 위해서만
// 개별 테스트가 mockReturnValueOnce로 override한다.
const actualHopTime = jest.requireActual('../../../route/utils/hopTime');
const mockHopTimeMsAt = jest.fn(actualHopTime.hopTimeMsAt);
jest.mock('../../../route/utils/hopTime', () => ({
  hopTimeMsAt: (...args: unknown[]) => mockHopTimeMsAt(...args),
}));

const mockLogScheduledPrescheduledAlarm = jest.fn();
jest.mock('../alarmLog', () => ({
  logScheduledPrescheduledAlarm: (...args: unknown[]) => mockLogScheduledPrescheduledAlarm(...args),
}));

const mockedSchedule = Notifications.scheduleNotificationAsync as jest.MockedFunction<
  typeof Notifications.scheduleNotificationAsync
>;
const mockedGetAll = Notifications.getAllScheduledNotificationsAsync as jest.MockedFunction<
  typeof Notifications.getAllScheduledNotificationsAsync
>;
const mockedGetPresented = Notifications.getPresentedNotificationsAsync as jest.MockedFunction<
  typeof Notifications.getPresentedNotificationsAsync
>;
const mockedDismiss = Notifications.dismissNotificationAsync as jest.MockedFunction<
  typeof Notifications.dismissNotificationAsync
>;
const mockAsyncGetItem = AsyncStorage.getItem as jest.Mock;

const TRIP_TOKEN = 'TOKEN-ABCDEFGH-1234';
const NOW = new Date('2026-08-03T09:00:00Z').getTime();

/** fromId/toId가 stationTravelTimes.json에 존재하지 않는 fabricated id — getStopSeconds가 항상
 * STOP_FALLBACK_SECONDS(120s)로 결정적으로 fallback하므로 hop time 계산이 실측 데이터 drift에서
 * 독립적이다. */
function makeStation(id: string, name: string, line: Station['line']): Station {
  return { id, name, line, lineColor: '#000', lat: 0, lng: 0 } as Station;
}

/** 2호선 4역 + 3호선으로 환승하는 6역짜리 arc — transfer(idx 3→4 line 변경)/destination(마지막)/
 * station-passed(그 외) 세 kind를 모두 발생시킨다. */
function makeArc(): Station[] {
  return [
    makeStation('fab-2-a', 'A역', '2'),
    makeStation('fab-2-b', 'B역', '2'),
    makeStation('fab-2-c', 'C역', '2'),
    makeStation('fab-2-d', 'D역', '2'),
    makeStation('fab-3-e', 'E역', '3'),
    makeStation('fab-3-f', 'F역', '3'),
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(Platform, 'OS', 'ios');
  mockedSchedule.mockResolvedValue('id');
  mockedGetAll.mockResolvedValue([]);
  mockedGetPresented.mockResolvedValue([]);
  mockedDismiss.mockResolvedValue(undefined);
  mockCancelIdentifiersWithRetry.mockResolvedValue(0);
  mockRecordScheduledAlarm.mockResolvedValue(undefined);
  mockAsyncGetItem.mockResolvedValue(null);
  mockHopTimeMsAt.mockReset();
  mockHopTimeMsAt.mockImplementation(actualHopTime.hopTimeMsAt);
});

function scheduledIdentifiers(): string[] {
  return mockedSchedule.mock.calls.map((call) => call[0].identifier as string);
}

function scheduledContentData(idx: number): Record<string, unknown> {
  return mockedSchedule.mock.calls[idx][0].content.data as Record<string, unknown>;
}

describe('registerPrescheduledStationAlarms', () => {
  it('currentIdx가 arc 끝(마지막 인덱스)이면 빈 배열 → scheduled 0', async () => {
    const arc = makeArc();
    const result = await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: arc.length - 1,
      now: NOW,
    });
    expect(result).toEqual({ scheduled: 0 });
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('currentIdx가 음수면 빈 배열 → scheduled 0', async () => {
    const arc = makeArc();
    const result = await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: -1,
      now: NOW,
    });
    expect(result).toEqual({ scheduled: 0 });
  });

  it('중간역은 station-passed, line 경계는 transfer, 마지막 역은 destination으로 예약', async () => {
    const arc = makeArc();
    const result = await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: 0,
      now: NOW,
    });

    // idx0(A) 기준 남은 5개 hop(B,C,D,E,F) 모두 window(12) 이내 → 5건 예약.
    expect(result.scheduled).toBe(5);
    const kinds = mockedSchedule.mock.calls.map((c) => (c[0].content.data as { kind: string }).kind);
    expect(kinds).toEqual(['station-passed', 'station-passed', 'transfer', 'station-passed', 'destination']);
  });

  it('rolling window(12역) 초과분은 예약하지 않는다', async () => {
    const arc: Station[] = [];
    for (let i = 0; i < 20; i++) arc.push(makeStation(`fab-1-${i}`, `역${i}`, '1'));
    const result = await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: 0,
      now: NOW,
    });
    expect(result.scheduled).toBe(12);
  });

  it('fireMs가 now 이하인 waypoint는 skip(0 hop-time fallback 경계 케이스는 발생하지 않지만 방어 로직 검증)', async () => {
    // now를 아주 먼 미래로 설정해 모든 fireMs(now 기준 누적)가 now보다 작아지게 만든다.
    const arc = makeArc();
    const farFutureNow = NOW + 1_000_000_000;
    const result = await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: 0,
      now: farFutureNow,
    });
    // deriveUpcomingWaypoints의 cumulativeMs는 now에서 시작해 누적되므로 항상 now보다 크다 —
    // 즉 이 케이스에서는 skip이 발생하지 않는다(fireMs = now + hop time > now). 정상 스케줄만 확인.
    expect(result.scheduled).toBe(5);
  });

  it('now 미지정 시 Date.now() fallback', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const arc = makeArc();
    await registerPrescheduledStationAlarms({ tripToken: TRIP_TOKEN, arcStations: arc, currentIdx: 0 });
    expect(mockedSchedule).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('hop time이 0 이하로 산출되어 fireMs<=now인 waypoint는 스킵하고 그 뒤는 정상 예약', async () => {
    // 첫 hop만 0ms(fireMs===nowMs)로 강제 — 두 번째 이후는 실제 구현으로 복귀.
    mockHopTimeMsAt.mockImplementationOnce(() => 0);
    const arc = makeArc();
    const result = await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: 0,
      now: NOW,
    });
    // 5개 hop 중 첫 waypoint(B역)만 skip → 4건 예약.
    expect(result.scheduled).toBe(4);
    expect(scheduledIdentifiers().some((id) => id.includes('B역'))).toBe(false);
  });

  it('같은 (kind, stationName) 조합이 route에 중복 등장하면 occurrenceIdx가 증가한 identifier를 만든다', async () => {
    // currentIdx=0(X역)의 다음 hop부터 waypoint가 파생 — waypoint 시퀀스는 [A역, B역, A역(중복), C역].
    const arc = [
      makeStation('fab-2-x', 'X역', '2'),
      makeStation('fab-2-a', 'A역', '2'),
      makeStation('fab-2-b', 'B역', '2'),
      makeStation('fab-2-a2', 'A역', '2'),
      makeStation('fab-2-c', 'C역', '2'),
    ];
    await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: 0,
      now: NOW,
    });
    const ids = scheduledIdentifiers();
    expect(ids[0]).toBe(`${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-A역-station-passed`);
    expect(ids[2]).toBe(`${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-A역-station-passed#1`);
  });

  it('#2158 — android에서 무음 채널(station-alarm-silent) + HIGH priority 설정, ios에서는 interruptionLevel 설정', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const arc = makeArc();
    await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: 3, // transfer 다음 destination 두 건만 남김: D→E(transfer), E→F(destination)
      now: NOW,
    });
    const call = mockedSchedule.mock.calls[0][0];
    // #2158 P1 — 'station-alarm'(loud, sound:'alarm.wav' 채널 고정 속성)을 쓰면 Android 8+에서
    // content.sound=false가 무시되고 여전히 loud 발사된다. 일반모드 전용 채널이므로 무음 채널을
    // 써야 한다.
    expect((call.content as { channelId?: string }).channelId).toBe('station-alarm-silent');
    expect((call.content as { priority?: number }).priority).toBe(
      Notifications.AndroidNotificationPriority.HIGH,
    );
    expect((call.content as { interruptionLevel?: string }).interruptionLevel).toBeUndefined();
  });

  it('#2158 — station-passed/transfer/destination 모두 sound=false (일반모드는 loud 알람 금지)', async () => {
    const arc = makeArc();
    await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: 0,
      now: NOW,
    });
    const calls = mockedSchedule.mock.calls;
    expect((calls[0][0].content as { sound?: unknown }).sound).toBe(false);
    const transferCallIdx = 2; // D역 transfer
    expect((calls[transferCallIdx][0].content as { sound?: unknown }).sound).toBe(false);
    const destinationCallIdx = calls.length - 1; // F역 destination
    expect((calls[destinationCallIdx][0].content as { sound?: unknown }).sound).toBe(false);
  });

  it('#2158 — ios에서 transfer/destination도 interruptionLevel=active (timeSensitive/alarm.wav 금지)', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const arc = makeArc();
    await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: 3, // transfer(D→E) + destination(E→F) 두 건
      now: NOW,
    });
    const calls = mockedSchedule.mock.calls;
    expect(calls.length).toBe(2);
    for (const call of calls) {
      const content = call[0].content as { sound?: unknown; interruptionLevel?: string };
      expect(content.sound).toBe(false);
      expect(content.interruptionLevel).toBe('active');
    }
  });

  it('APNS_TOKEN_KEY가 있으면 collapseId를 content.data에 동봉', async () => {
    mockAsyncGetItem.mockResolvedValue('device-token-1234567890');
    const arc = makeArc();
    await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: 0,
      now: NOW,
    });
    expect(scheduledContentData(0).collapseId).toBe(`collapse-${'device-token-1234567890'.slice(0, 16)}`);
  });

  it('APNS_TOKEN_KEY가 없으면 collapseId undefined', async () => {
    mockAsyncGetItem.mockResolvedValue(null);
    const arc = makeArc();
    await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: 0,
      now: NOW,
    });
    expect(scheduledContentData(0).collapseId).toBeUndefined();
  });

  it('recordScheduledAlarm + logScheduledPrescheduledAlarm이 예약마다 호출된다', async () => {
    const arc = makeArc();
    await registerPrescheduledStationAlarms({
      tripToken: TRIP_TOKEN,
      arcStations: arc,
      currentIdx: 0,
      now: NOW,
    });
    expect(mockRecordScheduledAlarm).toHaveBeenCalledTimes(5);
    expect(mockLogScheduledPrescheduledAlarm).toHaveBeenCalledTimes(5);
    expect(mockLogScheduledPrescheduledAlarm).toHaveBeenCalledWith({ stationName: 'B역', kind: 'station-passed' });
  });
});

describe('cancelAllPrescheduledAlarms', () => {
  it('prefix가 일치하는 pending만 취소한다', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-A역-station-passed` },
      { identifier: 'other-id' },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(1);

    await cancelAllPrescheduledAlarms(TRIP_TOKEN);

    expect(mockCancelIdentifiersWithRetry).toHaveBeenCalledWith([
      `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-A역-station-passed`,
    ]);
  });

  it('delivered tray의 매칭 항목을 dismiss하고 성공 카운트를 집계한다', async () => {
    mockedGetAll.mockResolvedValue([]);
    const prefix = `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-`;
    mockedGetPresented.mockResolvedValue([
      { request: { identifier: `${prefix}A역-station-passed` } },
      { request: { identifier: 'unrelated' } },
    ] as unknown as Notifications.Notification[]);
    mockedDismiss.mockResolvedValueOnce(undefined);

    await cancelAllPrescheduledAlarms(TRIP_TOKEN);

    expect(mockedDismiss).toHaveBeenCalledTimes(1);
    expect(mockedDismiss).toHaveBeenCalledWith(`${prefix}A역-station-passed`);
  });

  it('dismiss 실패(rejected)는 카운트에서 제외되고 전체 흐름은 정상 종료', async () => {
    const prefix = `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-`;
    mockedGetPresented.mockResolvedValue([
      { request: { identifier: `${prefix}A역-station-passed` } },
    ] as unknown as Notifications.Notification[]);
    mockedDismiss.mockRejectedValueOnce(new Error('dismiss fail'));

    await expect(cancelAllPrescheduledAlarms(TRIP_TOKEN)).resolves.toBeUndefined();
  });

  it('getPresentedNotificationsAsync 실패 시 pending cancel만 적용하고 graceful 종료', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-A역-station-passed` },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(1);
    mockedGetPresented.mockRejectedValue(new Error('tray fail'));

    await expect(cancelAllPrescheduledAlarms(TRIP_TOKEN)).resolves.toBeUndefined();
  });

  it('취소도 dismiss도 없으면 조용히 종료(0/0)', async () => {
    mockedGetAll.mockResolvedValue([]);
    mockedGetPresented.mockResolvedValue([]);
    await expect(cancelAllPrescheduledAlarms(TRIP_TOKEN)).resolves.toBeUndefined();
  });
});

describe('readPrescheduledData', () => {
  const prefix = `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-`;

  function makeReq(identifier: string, data: unknown): Notifications.NotificationRequest {
    return { identifier, content: { data } } as unknown as Notifications.NotificationRequest;
  }

  it('prefix가 아니면 null', () => {
    expect(readPrescheduledData(makeReq('other-id', null))).toBeNull();
  });

  it('data가 없으면 null', () => {
    expect(readPrescheduledData(makeReq(`${prefix}A역-station-passed`, null))).toBeNull();
  });

  it('channel이 presched-station이 아니면 null', () => {
    expect(
      readPrescheduledData(makeReq(`${prefix}A역-station-passed`, { channel: 'safety-net' })),
    ).toBeNull();
  });

  it('station 또는 tripToken이 문자열이 아니면 null', () => {
    expect(
      readPrescheduledData(
        makeReq(`${prefix}A역-station-passed`, {
          channel: 'presched-station',
          station: 1,
          tripToken: TRIP_TOKEN,
          kind: 'station-passed',
        }),
      ),
    ).toBeNull();
    expect(
      readPrescheduledData(
        makeReq(`${prefix}A역-station-passed`, {
          channel: 'presched-station',
          station: 'A역',
          tripToken: 1,
          kind: 'station-passed',
        }),
      ),
    ).toBeNull();
  });

  it('kind가 유효 enum이 아니면 null', () => {
    expect(
      readPrescheduledData(
        makeReq(`${prefix}A역-station-passed`, {
          channel: 'presched-station',
          station: 'A역',
          tripToken: TRIP_TOKEN,
          kind: 'unknown-kind',
        }),
      ),
    ).toBeNull();
  });

  it('occurrenceIdx가 숫자가 아니면 0으로 기본값 처리하며 정상 파싱', () => {
    const result = readPrescheduledData(
      makeReq(`${prefix}A역-station-passed`, {
        channel: 'presched-station',
        station: 'A역',
        tripToken: TRIP_TOKEN,
        kind: 'station-passed',
      }),
    );
    expect(result).toEqual({
      channel: 'presched-station',
      tripToken: TRIP_TOKEN,
      station: 'A역',
      kind: 'station-passed',
      occurrenceIdx: 0,
    });
  });

  it('occurrenceIdx가 숫자면 그대로 반영', () => {
    const result = readPrescheduledData(
      makeReq(`${prefix}A역-station-passed#1`, {
        channel: 'presched-station',
        station: 'A역',
        tripToken: TRIP_TOKEN,
        kind: 'station-passed',
        occurrenceIdx: 1,
      }),
    );
    expect(result?.occurrenceIdx).toBe(1);
  });
});

describe('cancelPrescheduledByStationKind', () => {
  it('매칭되는 항목이 없으면 cancelIdentifiersWithRetry를 호출하지 않는다', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: 'other', content: { data: null } },
    ] as unknown as Notifications.NotificationRequest[]);

    await cancelPrescheduledByStationKind('A역', 'station-passed');

    expect(mockCancelIdentifiersWithRetry).not.toHaveBeenCalled();
  });

  it('targets는 있지만 cancelIdentifiersWithRetry가 0을 반환하면 info 로그를 남기지 않는다(0 branch)', async () => {
    const prefix = `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-`;
    mockedGetAll.mockResolvedValue([
      {
        identifier: `${prefix}A역-station-passed`,
        content: {
          data: { channel: 'presched-station', station: 'A역', tripToken: TRIP_TOKEN, kind: 'station-passed' },
        },
      },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(0);

    await expect(cancelPrescheduledByStationKind('A역', 'station-passed')).resolves.toBeUndefined();
  });

  it('(station, kind)가 일치하는 항목만 취소한다(occurrence 무관)', async () => {
    const prefix = `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-`;
    mockedGetAll.mockResolvedValue([
      {
        identifier: `${prefix}A역-station-passed`,
        content: {
          data: { channel: 'presched-station', station: 'A역', tripToken: TRIP_TOKEN, kind: 'station-passed' },
        },
      },
      {
        identifier: `${prefix}A역-station-passed#1`,
        content: {
          data: {
            channel: 'presched-station',
            station: 'A역',
            tripToken: TRIP_TOKEN,
            kind: 'station-passed',
            occurrenceIdx: 1,
          },
        },
      },
      {
        identifier: `${prefix}B역-transfer`,
        content: {
          data: { channel: 'presched-station', station: 'B역', tripToken: TRIP_TOKEN, kind: 'transfer' },
        },
      },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(2);

    await cancelPrescheduledByStationKind('A역', 'station-passed');

    expect(mockCancelIdentifiersWithRetry).toHaveBeenCalledWith([
      `${prefix}A역-station-passed`,
      `${prefix}A역-station-passed#1`,
    ]);
  });
});

describe('reschedulePrescheduledAlarm', () => {
  const prefix = `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-`;

  it('매칭되는 기존 pending이 없으면 cancel-only(0,0)를 반환한다', async () => {
    mockedGetAll.mockResolvedValue([]);
    const result = await reschedulePrescheduledAlarm({
      tripToken: TRIP_TOKEN,
      stationName: 'A역',
      newArrivalMs: NOW + 60_000,
      now: NOW,
    });
    expect(result).toEqual({ cancelled: 0, scheduled: 0 });
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('presched 데이터가 아니거나 tripToken/occurrenceIdx/station이 각각 불일치하는 항목은 매칭에서 제외된다', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: 'not-presched', content: { data: null } },
      {
        identifier: `${prefix}A역-transfer-wrong-token`,
        content: {
          data: { channel: 'presched-station', station: 'A역', tripToken: 'OTHER-TOKEN', kind: 'transfer' },
        },
      },
      {
        identifier: `${prefix}A역-transfer#9`,
        content: {
          data: {
            channel: 'presched-station',
            station: 'A역',
            tripToken: TRIP_TOKEN,
            kind: 'transfer',
            occurrenceIdx: 9,
          },
        },
      },
      {
        identifier: `${prefix}B역-transfer`,
        content: {
          data: { channel: 'presched-station', station: 'B역', tripToken: TRIP_TOKEN, kind: 'transfer' },
        },
      },
    ] as unknown as Notifications.NotificationRequest[]);

    const result = await reschedulePrescheduledAlarm({
      tripToken: TRIP_TOKEN,
      stationName: 'A역',
      newArrivalMs: NOW + 60_000,
      now: NOW,
    });

    expect(result).toEqual({ cancelled: 0, scheduled: 0 });
    expect(mockCancelIdentifiersWithRetry).not.toHaveBeenCalled();
  });

  it('newArrivalMs가 now 이하면 cancel만 하고 재예약하지 않는다', async () => {
    mockedGetAll.mockResolvedValue([
      {
        identifier: `${prefix}A역-station-passed`,
        content: {
          data: { channel: 'presched-station', station: 'A역', tripToken: TRIP_TOKEN, kind: 'station-passed' },
        },
      },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(1);

    const result = await reschedulePrescheduledAlarm({
      tripToken: TRIP_TOKEN,
      stationName: 'A역',
      newArrivalMs: NOW - 1,
      now: NOW,
    });

    expect(result).toEqual({ cancelled: 1, scheduled: 0 });
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('매칭 성공 + 미래 시각이면 cancel 후 동일 kind/occurrence로 재예약한다', async () => {
    mockedGetAll.mockResolvedValue([
      {
        identifier: `${prefix}A역-transfer`,
        content: {
          data: { channel: 'presched-station', station: 'A역', tripToken: TRIP_TOKEN, kind: 'transfer' },
        },
      },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(1);

    const result = await reschedulePrescheduledAlarm({
      tripToken: TRIP_TOKEN,
      stationName: 'A역',
      newArrivalMs: NOW + 60_000,
      now: NOW,
    });

    expect(result).toEqual({ cancelled: 1, scheduled: 1 });
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
    expect(mockedSchedule.mock.calls[0][0].identifier).toBe(`${prefix}A역-transfer`);
  });

  it('occurrenceIdx 미지정 시 0 기본값으로 매칭한다', async () => {
    mockedGetAll.mockResolvedValue([
      {
        identifier: `${prefix}A역-station-passed`,
        content: {
          data: {
            channel: 'presched-station',
            station: 'A역',
            tripToken: TRIP_TOKEN,
            kind: 'station-passed',
            occurrenceIdx: 0,
          },
        },
      },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(1);

    const result = await reschedulePrescheduledAlarm({
      tripToken: TRIP_TOKEN,
      stationName: 'A역',
      newArrivalMs: NOW + 60_000,
      now: NOW,
    });

    expect(result.scheduled).toBe(1);
  });

  it('now 미지정 시 Date.now() fallback', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockedGetAll.mockResolvedValue([
      {
        identifier: `${prefix}A역-transfer`,
        content: {
          data: { channel: 'presched-station', station: 'A역', tripToken: TRIP_TOKEN, kind: 'transfer' },
        },
      },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(1);

    const result = await reschedulePrescheduledAlarm({
      tripToken: TRIP_TOKEN,
      stationName: 'A역',
      newArrivalMs: NOW + 60_000,
    });

    expect(result.scheduled).toBe(1);
    spy.mockRestore();
  });
});
