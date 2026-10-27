/**
 * #3100 — 안전망(OS 예약 백업)의 칸별 예약 / 부분 취소 / 칸별 reschedule.
 * 사용자 요구는 "칸마다 울림"이라 예약 단위가 waypoint × 칸이다. 기본(칸 1개) 바이트는
 * `sleepAlarmN.defaultGolden.test.ts`가 고정한다.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  SAFETY_NET_BUFFER_MS,
  registerSafetyNetAlarms,
  cancelSafetyNetByStationKind,
  rescheduleSafetyNetAlarm,
  readSafetyNetData,
} from '../safetyNetScheduler';
import { makeDirectRoute, makeMultiTransferRoute } from '../../../../testUtils/routeFixtures';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import type { Route } from '../../../../shared/utils/stationRoute';
import type { SleepAlarmConfig } from '../../../../shared/constants/sleepAlarm';

jest.mock('expo-notifications');
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const mockBuildAlarmContent = jest.fn((event: { phaseId: string; stationName: string; band?: number }) => ({
  title: `T:${event.phaseId}:${event.band ?? '-'}`,
  body: `B:${event.stationName}:${event.band ?? '-'}`,
}));
jest.mock('../stationNotification', () => ({
  buildAlarmContent: (...args: unknown[]) => mockBuildAlarmContent(...(args as [never])),
}));
const mockLogScheduledAlarm = jest.fn();
jest.mock('../alarmLog', () => ({ logScheduledAlarm: (...args: unknown[]) => mockLogScheduledAlarm(...args) }));

// 쿼터 캡 테스트용 — 상한을 6으로 낮춘다 (실제 값 60은 waypoint 21개가 필요해 fixture로 만들 수 없다).
jest.mock('../../../../shared/constants/iosScheduledLimit', () => ({
  ...jest.requireActual('../../../../shared/constants/iosScheduledLimit'),
  SAFETY_NET_MAX_WAYPOINTS: 6,
}));

const mockedSchedule = Notifications.scheduleNotificationAsync as jest.Mock;
const mockedGetAll = Notifications.getAllScheduledNotificationsAsync as jest.Mock;
const mockedCancel = Notifications.cancelScheduledNotificationAsync as jest.Mock;

const START = new Date('2026-07-31T09:00:00Z').getTime();
const TOKEN = 'TOKEN-C';
const GANGNAM = canonicalStationName('강남', '2');
const 교대 = canonicalStationName('교대', '2');
const SEOUL = canonicalStationName('서울역', '1');
const LEG_MS_PER_STOP = 120_000;

const SELECTED_3_1: SleepAlarmConfig = { mode: 'selected', stops: [3, 1] };
const EVERY_3: SleepAlarmConfig = { mode: 'every', stops: [3] };

beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(Platform, 'OS', 'ios');
  mockedSchedule.mockResolvedValue('id');
  mockedGetAll.mockResolvedValue([]);
  mockedCancel.mockResolvedValue(undefined);
});

async function register(route: Route, dest: string, sleepAlarm?: SleepAlarmConfig) {
  return registerSafetyNetAlarms({
    tripToken: TOKEN,
    route,
    destinationName: dest,
    startTime: START,
    now: START,
    outageConfirmed: true,
    sleepAlarm,
  });
}

function scheduled() {
  return mockedSchedule.mock.calls.map(([arg]) => ({
    identifier: arg.identifier as string,
    fireMs: (arg.trigger as { date: Date }).date.getTime(),
    data: arg.content.data as Record<string, unknown>,
    title: arg.content.title as string,
  }));
}

function req(identifier: string, data: Record<string, unknown>): Notifications.NotificationRequest {
  return { identifier, content: { data } } as unknown as Notifications.NotificationRequest;
}

describe('registerSafetyNetAlarms — 칸별 예약', () => {
  it('선택 {3,1} × L=6: 3역 전·1역 전 두 건. 3역 전은 -s3 id + data.remaining=3, 1역 전은 기본 바이트', async () => {
    const result = await register(makeDirectRoute(6, '2'), GANGNAM, SELECTED_3_1);
    expect(result).toEqual({ scheduled: 2 });
    const arrival = START + 6 * LEG_MS_PER_STOP;
    const [first, second] = scheduled();
    expect(first.identifier).toBe(`alarm-${TOKEN}-${GANGNAM}-destination-s3`);
    expect(first.fireMs).toBe(arrival - 3 * LEG_MS_PER_STOP + SAFETY_NET_BUFFER_MS);
    expect(first.data).toEqual({
      channel: 'safety-net',
      tripToken: TOKEN,
      station: GANGNAM,
      kind: 'destination',
      occurrenceIdx: 0,
      remaining: 3,
    });
    expect(second.identifier).toBe(`alarm-${TOKEN}-${GANGNAM}-destination`);
    expect(second.fireMs).toBe(arrival - LEG_MS_PER_STOP + SAFETY_NET_BUFFER_MS);
    expect(Object.prototype.hasOwnProperty.call(second.data, 'remaining')).toBe(false);
  });

  it('N역 전 칸의 알림 문구는 band(남은 수)를 담아 빌드, 1역 전 칸은 band 없음', async () => {
    await register(makeDirectRoute(6, '2'), GANGNAM, SELECTED_3_1);
    const events = mockBuildAlarmContent.mock.calls.map(([event]) => event as { band?: number });
    expect(events.map((e) => e.band)).toEqual([3, undefined]);
  });

  it('선택 {3,1} × L=2 (짧은 leg): 출발역은 칸이 아니므로 첫 역에서 1회 — 기본 id 한 건', async () => {
    const result = await register(makeDirectRoute(2, '2'), GANGNAM, SELECTED_3_1);
    expect(result).toEqual({ scheduled: 1 });
    expect(scheduled().map((s) => s.identifier)).toEqual([`alarm-${TOKEN}-${GANGNAM}-destination`]);
  });

  it('매 역 3 × L=6: 3·2·1 세 건 (내림차순 예약)', async () => {
    await register(makeDirectRoute(6, '2'), GANGNAM, EVERY_3);
    expect(scheduled().map((s) => s.identifier)).toEqual([
      `alarm-${TOKEN}-${GANGNAM}-destination-s3`,
      `alarm-${TOKEN}-${GANGNAM}-destination-s2`,
      `alarm-${TOKEN}-${GANGNAM}-destination`,
    ]);
  });

  it('칸의 예상 시각이 과거면 그 칸만 건너뛴다 (나머지 칸은 예약)', async () => {
    const arrival = START + 6 * LEG_MS_PER_STOP;
    const thirdFire = arrival - 3 * LEG_MS_PER_STOP + SAFETY_NET_BUFFER_MS;
    const result = await registerSafetyNetAlarms({
      tripToken: TOKEN,
      route: makeDirectRoute(6, '2'),
      destinationName: GANGNAM,
      startTime: START,
      now: thirdFire,
      outageConfirmed: true,
      sleepAlarm: SELECTED_3_1,
    });
    expect(result).toEqual({ scheduled: 1 });
    expect(scheduled().map((s) => s.identifier)).toEqual([`alarm-${TOKEN}-${GANGNAM}-destination`]);
  });

  it('중복 occurrence는 칸 접미 뒤에 #n', async () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: GANGNAM, fromLine: '2', toLine: '3', stopsToTransfer: 4 },
        { transferName: GANGNAM, fromLine: '3', toLine: '2', stopsToTransfer: 4 },
      ],
      stopsAfterLastTransfer: 4,
    });
    await register(route, SEOUL, { mode: 'selected', stops: [3] });
    const ids = scheduled().map((s) => s.identifier);
    expect(ids).toContain(`alarm-${TOKEN}-${GANGNAM}-transfer-s3`);
    expect(ids).toContain(`alarm-${TOKEN}-${GANGNAM}-transfer-s3#1`);
  });

  it('환승 2 + 도착, 매 역 2: waypoint 순서대로 각자 leg 길이로 clamp한 칸', async () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: 교대, fromLine: '2', toLine: '3', stopsToTransfer: 2 },
        { transferName: SEOUL, fromLine: '3', toLine: '1', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 3,
    });
    await register(route, GANGNAM, { mode: 'every', stops: [2] });
    expect(scheduled().map((s) => s.identifier)).toEqual([
      `alarm-${TOKEN}-${교대}-transfer`,
      `alarm-${TOKEN}-${SEOUL}-transfer-s2`,
      `alarm-${TOKEN}-${SEOUL}-transfer`,
      `alarm-${TOKEN}-${GANGNAM}-destination-s2`,
      `alarm-${TOKEN}-${GANGNAM}-destination`,
    ]);
  });

  it('OS 예약 상한 초과 시 1역 전(기본) 칸을 먼저 보존하고 나머지 칸은 이른 시각 순으로 채운다', async () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: 교대, fromLine: '2', toLine: '3', stopsToTransfer: 4 },
        { transferName: SEOUL, fromLine: '3', toLine: '1', stopsToTransfer: 4 },
      ],
      stopsAfterLastTransfer: 4,
    });
    // waypoint 3 × 칸 3 = 9건, 상한 6 → 1역 전 3건 + 가장 이른 비기본 3건(교대 s3·s2, 서울역 s3).
    const result = await register(route, GANGNAM, EVERY_3);
    expect(result.scheduled).toBe(6);
    const ids = scheduled().map((s) => s.identifier);
    expect(ids).toEqual([
      `alarm-${TOKEN}-${교대}-transfer-s3`,
      `alarm-${TOKEN}-${교대}-transfer-s2`,
      `alarm-${TOKEN}-${교대}-transfer`,
      `alarm-${TOKEN}-${SEOUL}-transfer-s3`,
      `alarm-${TOKEN}-${SEOUL}-transfer`,
      `alarm-${TOKEN}-${GANGNAM}-destination`,
    ]);
  });
});

describe('cancelSafetyNetByStationKind — 부분 취소', () => {
  const id = (suffix: string) => `alarm-${TOKEN}-${GANGNAM}-destination${suffix}`;
  const entries = () => [
    req(id('-s3'), { channel: 'safety-net', station: GANGNAM, tripToken: TOKEN, kind: 'destination', occurrenceIdx: 0, remaining: 3 }),
    req(id('-s2'), { channel: 'safety-net', station: GANGNAM, tripToken: TOKEN, kind: 'destination', occurrenceIdx: 0, remaining: 2 }),
    req(id(''), { channel: 'safety-net', station: GANGNAM, tripToken: TOKEN, kind: 'destination', occurrenceIdx: 0 }),
  ];
  const cancelledIds = () => mockedCancel.mock.calls.map(([x]) => x as string).sort();

  it('3역 전 companion(fromRemaining=3): 3역 백업만 취소, 2·1역 백업은 유지', async () => {
    mockedGetAll.mockResolvedValueOnce(entries());
    await cancelSafetyNetByStationKind(GANGNAM, 'destination', 3);
    expect(cancelledIds()).toEqual([id('-s3')]);
  });

  it('2역 전 companion(fromRemaining=2): 3·2역 취소, 1역 유지', async () => {
    mockedGetAll.mockResolvedValueOnce(entries());
    await cancelSafetyNetByStationKind(GANGNAM, 'destination', 2);
    expect(cancelledIds()).toEqual([id('-s2'), id('-s3')]);
  });

  it('1역 전 companion(fromRemaining=1): data.remaining 없는 기본 백업 포함 전부 취소', async () => {
    mockedGetAll.mockResolvedValueOnce(entries());
    await cancelSafetyNetByStationKind(GANGNAM, 'destination', 1);
    expect(cancelledIds()).toEqual([id(''), id('-s2'), id('-s3')]);
  });

  it('fromRemaining 미지정(GPS 도착 등)은 전부 취소 — 기존 동작', async () => {
    mockedGetAll.mockResolvedValueOnce(entries());
    await cancelSafetyNetByStationKind(GANGNAM, 'destination');
    expect(cancelledIds()).toEqual([id(''), id('-s2'), id('-s3')]);
  });
});

describe('rescheduleSafetyNetAlarm — 칸별 재예약', () => {
  const route = makeDirectRoute(6, '2'); // legMs = 720_000, stops = 6
  const entry = (suffix: string, remaining?: number) =>
    req(`alarm-${TOKEN}-${GANGNAM}-destination${suffix}`, {
      channel: 'safety-net',
      station: GANGNAM,
      tripToken: TOKEN,
      kind: 'destination',
      occurrenceIdx: 0,
      ...(remaining === undefined ? {} : { remaining }),
    });

  it('매치마다 자기 칸의 lead로 재예약한다 (3역 백업은 3 stop lead, 기본은 1 stop lead)', async () => {
    mockedGetAll.mockResolvedValueOnce([entry('-s3', 3), entry('')]);
    const newArrival = START + 800_000;
    const result = await rescheduleSafetyNetAlarm({
      tripToken: TOKEN,
      route,
      destinationName: GANGNAM,
      stationName: GANGNAM,
      newArrivalMs: newArrival,
      now: START,
    });
    expect(result).toEqual({ cancelled: 2, scheduled: 2 });
    const byId = Object.fromEntries(scheduled().map((s) => [s.identifier, s]));
    expect(byId[`alarm-${TOKEN}-${GANGNAM}-destination-s3`].fireMs).toBe(
      newArrival - 3 * LEG_MS_PER_STOP + SAFETY_NET_BUFFER_MS,
    );
    expect(byId[`alarm-${TOKEN}-${GANGNAM}-destination-s3`].data.remaining).toBe(3);
    expect(byId[`alarm-${TOKEN}-${GANGNAM}-destination`].fireMs).toBe(
      newArrival - LEG_MS_PER_STOP + SAFETY_NET_BUFFER_MS,
    );
  });

  it('다른 앱 알림·다른 역/occurrence 예약은 건드리지 않는다', async () => {
    mockedGetAll.mockResolvedValueOnce([
      req('other-app', { foo: 1 }),
      req(`alarm-${TOKEN}-${교대}-transfer`, {
        channel: 'safety-net', station: 교대, tripToken: TOKEN, kind: 'transfer', occurrenceIdx: 0,
      }),
      entry('-s3', 3),
    ]);
    const result = await rescheduleSafetyNetAlarm({
      tripToken: TOKEN,
      route,
      destinationName: GANGNAM,
      stationName: GANGNAM,
      newArrivalMs: START + 800_000,
      now: START,
    });
    expect(result).toEqual({ cancelled: 1, scheduled: 1 });
    expect(mockedCancel.mock.calls.map(([x]) => x)).toEqual([`alarm-${TOKEN}-${GANGNAM}-destination-s3`]);
  });

  it('보정 후 이미 지난 칸은 취소만 하고 남은 칸은 재예약한다', async () => {
    mockedGetAll.mockResolvedValueOnce([entry('-s3', 3), entry('')]);
    const newArrival = START + 800_000;
    const thirdFire = newArrival - 3 * LEG_MS_PER_STOP + SAFETY_NET_BUFFER_MS;
    const result = await rescheduleSafetyNetAlarm({
      tripToken: TOKEN,
      route,
      destinationName: GANGNAM,
      stationName: GANGNAM,
      newArrivalMs: newArrival,
      now: thirdFire,
    });
    expect(result).toEqual({ cancelled: 2, scheduled: 1 });
    expect(scheduled().map((s) => s.identifier)).toEqual([`alarm-${TOKEN}-${GANGNAM}-destination`]);
  });
});

describe('readSafetyNetData — remaining', () => {
  const data = (extra: Record<string, unknown>) =>
    readSafetyNetData(
      req(`alarm-${TOKEN}-${GANGNAM}-destination-s3`, {
        channel: 'safety-net',
        station: GANGNAM,
        tripToken: TOKEN,
        kind: 'destination',
        occurrenceIdx: 0,
        ...extra,
      }),
    );

  it('data.remaining(정수 ≥ 1)을 읽는다', () => {
    expect(data({ remaining: 3 })?.remaining).toBe(3);
  });

  it.each([[0], [-1], [1.5], ['3'], [null]])('유효하지 않은 remaining(%p)은 없는 것으로 취급 (구 OS 예약 호환 → 기본 칸)', (bad) => {
    expect(data({ remaining: bad })?.remaining).toBeUndefined();
  });

  it('remaining 필드가 없는 구 예약도 정상 파싱', () => {
    expect(data({})).toEqual({
      channel: 'safety-net',
      tripToken: TOKEN,
      station: GANGNAM,
      kind: 'destination',
      occurrenceIdx: 0,
    });
  });
});
