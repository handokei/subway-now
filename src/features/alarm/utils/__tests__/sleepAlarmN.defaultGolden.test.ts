/**
 * #3100 PR-3+4 golden — 기본 사용자(칸 = 1역 전 하나)의 기기 쪽 바이트가 이 PR 전후로 동일해야 한다.
 *  - 원장(ledger) id / OS 예약 identifier / content.data / fireMs / 예약 개수
 *  - cancelSafetyNetByStationKind(부분 취소 인자 없음) = 같은 역·종류 전부 취소
 * 변경 전 구현에서 통과하는 값으로 고정한다.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  SAFETY_NET_BUFFER_MS,
  registerSafetyNetAlarms,
  cancelSafetyNetByStationKind,
  rescheduleSafetyNetAlarm,
} from '../safetyNetScheduler';
import { buildAlarmLocalId } from '../alarmLocalAuthority';
import { makeDirectRoute, makeMultiTransferRoute } from '../../../../testUtils/routeFixtures';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

jest.mock('expo-notifications');
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../stationNotification', () => ({
  buildAlarmContent: (event: { phaseId: string; stationName: string }) => ({
    title: `T:${event.phaseId}`,
    body: `B:${event.stationName}`,
  }),
}));
jest.mock('../alarmLog', () => ({ logScheduledAlarm: jest.fn() }));

const mockedSchedule = Notifications.scheduleNotificationAsync as jest.Mock;
const mockedGetAll = Notifications.getAllScheduledNotificationsAsync as jest.Mock;
const mockedCancel = Notifications.cancelScheduledNotificationAsync as jest.Mock;

const START_TIME = new Date('2026-07-31T09:00:00Z').getTime();
const TOKEN = 'TOKEN-G';
const GANGNAM = canonicalStationName('강남', '2');
const 교대 = canonicalStationName('교대', '2');
const SEOUL = canonicalStationName('서울역', '1');

beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(Platform, 'OS', 'ios');
  mockedSchedule.mockResolvedValue('id');
  mockedGetAll.mockResolvedValue([]);
  mockedCancel.mockResolvedValue(undefined);
});

function req(identifier: string, data: Record<string, unknown>): Notifications.NotificationRequest {
  return { identifier, content: { data } } as unknown as Notifications.NotificationRequest;
}

describe('#3100 golden — 원장 id', () => {
  it('buildAlarmLocalId(token, station, kind) = alarm-{token}-{station}-{kind}', () => {
    expect(buildAlarmLocalId('trip-1', '강남', 'transfer')).toBe('alarm-trip-1-강남-transfer');
    expect(buildAlarmLocalId('trip-1', '성수', 'destination')).toBe('alarm-trip-1-성수-destination');
  });
});

describe('#3100 golden — 기본 안전망 예약 (설정 없음)', () => {
  it('환승 2 + 도착 1: 개수·identifier·fireMs·content 전체가 고정', async () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: 교대, fromLine: '2', toLine: '3', stopsToTransfer: 3 },
        { transferName: SEOUL, fromLine: '3', toLine: '1', stopsToTransfer: 4 },
      ],
      stopsAfterLastTransfer: 5,
    });
    const result = await registerSafetyNetAlarms({
      tripToken: TOKEN,
      route,
      destinationName: GANGNAM,
      startTime: START_TIME,
      now: START_TIME,
      outageConfirmed: true,
    });
    expect(result).toEqual({ scheduled: 3 });
    const calls = mockedSchedule.mock.calls.map(([arg]) => arg);
    expect(calls.map((c) => c.identifier)).toEqual([
      `alarm-${TOKEN}-${교대}-transfer`,
      `alarm-${TOKEN}-${SEOUL}-transfer`,
      `alarm-${TOKEN}-${GANGNAM}-destination`,
    ]);
    // 각 leg: legMs = stops * 120_000 → 1역 전 lead = 120_000, 도착 시각은 누적.
    const lead = 120_000;
    const arrivals = [3 * 120_000, 3 * 120_000 + 4 * 120_000, 3 * 120_000 + 4 * 120_000 + 5 * 120_000];
    expect(calls.map((c) => (c.trigger as { date: Date }).date.getTime())).toEqual(
      arrivals.map((a) => START_TIME + a - lead + SAFETY_NET_BUFFER_MS),
    );
    expect(calls[0].content).toEqual({
      title: 'T:early',
      body: `B:${교대}`,
      data: { channel: 'safety-net', tripToken: TOKEN, station: 교대, kind: 'transfer', occurrenceIdx: 0 },
      sound: 'alarm.wav',
      interruptionLevel: 'timeSensitive',
    });
  });
});

describe('#3100 golden — 기본 취소/재예약', () => {
  it('cancelSafetyNetByStationKind(station, kind) = 같은 역·종류 예약 전부 취소 (occurrence 무관)', async () => {
    mockedGetAll.mockResolvedValueOnce([
      req('alarm-a', { channel: 'safety-net', station: GANGNAM, tripToken: TOKEN, kind: 'destination', occurrenceIdx: 0 }),
      req('alarm-b', { channel: 'safety-net', station: GANGNAM, tripToken: TOKEN, kind: 'destination', occurrenceIdx: 1 }),
      req('alarm-c', { channel: 'safety-net', station: 교대, tripToken: TOKEN, kind: 'transfer', occurrenceIdx: 0 }),
    ]);
    await cancelSafetyNetByStationKind(GANGNAM, 'destination');
    expect(mockedCancel.mock.calls.map(([id]) => id).sort()).toEqual(['alarm-a', 'alarm-b']);
  });

  it('reschedule: 매치 1건 → 취소 후 "새 도착 - legMs/stops + 버퍼" 1건', async () => {
    const route = makeDirectRoute(5, '2');
    mockedGetAll.mockResolvedValueOnce([
      req(`alarm-${TOKEN}-${GANGNAM}-destination`, {
        channel: 'safety-net',
        station: GANGNAM,
        tripToken: TOKEN,
        kind: 'destination',
        occurrenceIdx: 0,
      }),
    ]);
    const newArrival = START_TIME + 700_000;
    const result = await rescheduleSafetyNetAlarm({
      tripToken: TOKEN,
      route,
      destinationName: GANGNAM,
      stationName: GANGNAM,
      newArrivalMs: newArrival,
      now: START_TIME,
    });
    expect(result).toEqual({ cancelled: 1, scheduled: 1 });
    const [[arg]] = mockedSchedule.mock.calls;
    expect((arg.trigger as { date: Date }).date.getTime()).toBe(newArrival - 120_000 + SAFETY_NET_BUFFER_MS);
    expect(arg.identifier).toBe(`alarm-${TOKEN}-${GANGNAM}-destination`);
    expect(arg.content.data).toEqual({
      channel: 'safety-net',
      tripToken: TOKEN,
      station: GANGNAM,
      kind: 'destination',
      occurrenceIdx: 0,
    });
  });
});
