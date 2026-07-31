import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  SAFETY_NET_ALARM_PREFIX,
  SAFETY_NET_BUFFER_MS,
  deriveSafetyNetWaypoints,
  registerSafetyNetAlarms,
  cancelAllSafetyNetAlarms,
  cancelSafetyNetByStationKind,
  rescheduleSafetyNetAlarm,
  readSafetyNetData,
  deviceLocalTripId,
  resolveEffectiveTripToken,
} from '../safetyNetScheduler';
import { makeDirectRoute, makeTransferRoute, makeMultiTransferRoute } from '../../../../testUtils/routeFixtures';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

jest.mock('expo-notifications');

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../stationNotification', () => ({
  buildAlarmContent: (event: { phaseId: string; stationName: string }) => ({
    title: `T:${event.phaseId}`,
    body: `B:${event.stationName}`,
  }),
}));

const mockedSchedule = Notifications.scheduleNotificationAsync as jest.MockedFunction<
  typeof Notifications.scheduleNotificationAsync
>;
const mockedGetAll = Notifications.getAllScheduledNotificationsAsync as jest.MockedFunction<
  typeof Notifications.getAllScheduledNotificationsAsync
>;
const mockedCancel = Notifications.cancelScheduledNotificationAsync as jest.MockedFunction<
  typeof Notifications.cancelScheduledNotificationAsync
>;
const mockedGetPresented = Notifications.getPresentedNotificationsAsync as jest.MockedFunction<
  typeof Notifications.getPresentedNotificationsAsync
>;
const mockedDismiss = Notifications.dismissNotificationAsync as jest.MockedFunction<
  typeof Notifications.dismissNotificationAsync
>;

const START_TIME = new Date('2026-07-31T09:00:00Z').getTime();
const TRIP_TOKEN = 'TOKEN-A';
const GANGNAM = canonicalStationName('강남', '2');
const SEOUL_STATION = canonicalStationName('서울역', '1');
const 교대 = canonicalStationName('교대', '2');

beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(Platform, 'OS', 'ios');
  mockedSchedule.mockResolvedValue('id');
  mockedGetAll.mockResolvedValue([]);
  mockedCancel.mockResolvedValue(undefined);
  mockedGetPresented.mockResolvedValue([]);
  mockedDismiss.mockResolvedValue(undefined);
});

function scheduledIdentifiers(): string[] {
  return mockedSchedule.mock.calls.map((call) => call[0].identifier as string);
}

function scheduledFireMs(): number[] {
  return mockedSchedule.mock.calls.map((call) => {
    const trigger = call[0].trigger as { date: Date };
    return trigger.date.getTime();
  });
}

function makeReq(
  identifier: string,
  data: Record<string, unknown> | null,
): Notifications.NotificationRequest {
  return { identifier, content: { data } } as unknown as Notifications.NotificationRequest;
}

describe('deriveSafetyNetWaypoints', () => {
  it('route/destinationName이 null이면 빈 배열', () => {
    expect(deriveSafetyNetWaypoints(null, '강남')).toEqual([]);
    expect(deriveSafetyNetWaypoints(makeDirectRoute(3, '2'), null)).toEqual([]);
  });

  it('"1역차 금지" — stops<=1인 waypoint는 필터링된다', () => {
    const route = makeDirectRoute(1, '2');
    expect(deriveSafetyNetWaypoints(route, GANGNAM)).toEqual([]);
  });

  it('direct route: stops>1이면 단일 waypoint(destination) 반환', () => {
    const route = makeDirectRoute(5, '2');
    const waypoints = deriveSafetyNetWaypoints(route, GANGNAM);
    expect(waypoints).toEqual([
      { stationName: GANGNAM, kind: 'destination', stops: 5, legMs: 5 * 120_000 },
    ]);
  });

  it('transfer route: transfer + destination 두 waypoint', () => {
    const route = makeTransferRoute({
      transferName: 교대,
      fromLine: '2',
      toLine: '3',
      stopsToTransfer: 3,
      stopsFromTransfer: 4,
    });
    const waypoints = deriveSafetyNetWaypoints(route, GANGNAM);
    expect(waypoints.map((w) => w.stationName)).toEqual([교대, GANGNAM]);
    expect(waypoints.map((w) => w.kind)).toEqual(['transfer', 'destination']);
  });

  it('multi-transfer route: 각 transfer + destination', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: 교대, fromLine: '2', toLine: '3', stopsToTransfer: 2 },
        { transferName: SEOUL_STATION, fromLine: '3', toLine: '1', stopsToTransfer: 3 },
      ],
      stopsAfterLastTransfer: 4,
    });
    const waypoints = deriveSafetyNetWaypoints(route, GANGNAM);
    expect(waypoints.map((w) => w.stationName)).toEqual([교대, SEOUL_STATION, GANGNAM]);
  });

  it('legMs가 NaN/0 이하면 HOP_TIME_MS로 fallback', () => {
    const route = makeDirectRoute(3, '2');
    // travelSeconds를 0으로 덮어써 legMs<=0 케이스를 만든다.
    const zeroed = { ...route, travelSeconds: 0 };
    const waypoints = deriveSafetyNetWaypoints(zeroed, GANGNAM);
    expect(waypoints[0].legMs).toBe(90_000);
  });
});

describe('registerSafetyNetAlarms', () => {
  it('waypoint가 없으면 0건 예약', async () => {
    const result = await registerSafetyNetAlarms({
      tripToken: TRIP_TOKEN,
      route: makeDirectRoute(1, '2'),
      destinationName: GANGNAM,
      startTime: START_TIME,
    });
    expect(result).toEqual({ scheduled: 0 });
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('direct route — "1역 전 + 180s 버퍼" 시각에 단일 fire 예약', async () => {
    const route = makeDirectRoute(5, '2'); // legMs=600_000, stops=5
    const result = await registerSafetyNetAlarms({
      tripToken: TRIP_TOKEN,
      route,
      destinationName: GANGNAM,
      startTime: START_TIME,
      now: START_TIME,
    });
    expect(result.scheduled).toBe(1);
    // arrival = start+600_000, earlyLeadMs = 600_000/5=120_000, fire = arrival-lead+buffer
    const expectedFire = START_TIME + 600_000 - 120_000 + SAFETY_NET_BUFFER_MS;
    expect(scheduledFireMs()).toEqual([expectedFire]);
    expect(scheduledIdentifiers()).toEqual([`alarm-${TRIP_TOKEN}-${GANGNAM}-destination`]);
  });

  it('과거 시각(fireMs <= startTime/now)은 skip', async () => {
    const route = makeDirectRoute(2, '2'); // legMs=240_000
    // now를 아주 미래로 둬서 fireMs가 now보다 과거가 되게 한다.
    const result = await registerSafetyNetAlarms({
      tripToken: TRIP_TOKEN,
      route,
      destinationName: GANGNAM,
      startTime: START_TIME,
      now: START_TIME + 10_000_000,
    });
    expect(result.scheduled).toBe(0);
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('중복역(occurrenceIdx) — 같은 kind+역명 재등장 시 #n suffix identifier', async () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: GANGNAM, fromLine: '2', toLine: '3', stopsToTransfer: 3 },
        { transferName: GANGNAM, fromLine: '3', toLine: '2', stopsToTransfer: 3 },
      ],
      stopsAfterLastTransfer: 3,
    });
    await registerSafetyNetAlarms({
      tripToken: TRIP_TOKEN,
      route,
      destinationName: SEOUL_STATION,
      startTime: START_TIME,
      now: START_TIME,
    });
    const ids = scheduledIdentifiers();
    expect(ids).toContain(`alarm-${TRIP_TOKEN}-${GANGNAM}-transfer`);
    expect(ids).toContain(`alarm-${TRIP_TOKEN}-${GANGNAM}-transfer#1`);
  });

  it('now 미지정 시 Date.now() 사용', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(START_TIME);
    const route = makeDirectRoute(5, '2');
    await registerSafetyNetAlarms({
      tripToken: TRIP_TOKEN,
      route,
      destinationName: GANGNAM,
      startTime: START_TIME,
    });
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('scheduleOne content — platform 분기', () => {
  it('android: channelId + priority 부여, interruptionLevel 없음', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const route = makeDirectRoute(5, '2');
    await registerSafetyNetAlarms({
      tripToken: TRIP_TOKEN,
      route,
      destinationName: GANGNAM,
      startTime: START_TIME,
      now: START_TIME,
    });
    const content = mockedSchedule.mock.calls[0][0].content as Record<string, unknown>;
    expect(content.channelId).toBe('station-alarm');
    expect(content.priority).toBe(Notifications.AndroidNotificationPriority.MAX);
    expect(content.interruptionLevel).toBeUndefined();
  });

  it('ios: interruptionLevel=timeSensitive, channelId 없음', async () => {
    const route = makeDirectRoute(5, '2');
    await registerSafetyNetAlarms({
      tripToken: TRIP_TOKEN,
      route,
      destinationName: GANGNAM,
      startTime: START_TIME,
      now: START_TIME,
    });
    const content = mockedSchedule.mock.calls[0][0].content as Record<string, unknown>;
    expect(content.interruptionLevel).toBe('timeSensitive');
    expect(content.channelId).toBeUndefined();
  });
});

describe('cancelAllSafetyNetAlarms', () => {
  it('tripToken prefix로 pending + delivered 모두 cancel/dismiss', async () => {
    mockedGetAll.mockResolvedValueOnce([
      { identifier: `alarm-${TRIP_TOKEN}-${GANGNAM}-destination`, content: {}, trigger: null },
      { identifier: `alarm-OTHER-역-destination`, content: {}, trigger: null },
    ] as unknown as Notifications.NotificationRequest[]);
    mockedGetPresented.mockResolvedValueOnce([
      { request: { identifier: `alarm-${TRIP_TOKEN}-${GANGNAM}-destination` } },
    ] as unknown as Notifications.Notification[]);

    await cancelAllSafetyNetAlarms(TRIP_TOKEN);

    expect(mockedCancel).toHaveBeenCalledWith(`alarm-${TRIP_TOKEN}-${GANGNAM}-destination`);
    expect(mockedCancel).toHaveBeenCalledTimes(1);
    expect(mockedDismiss).toHaveBeenCalledWith(`alarm-${TRIP_TOKEN}-${GANGNAM}-destination`);
  });

  it('대상 없으면 cancel/dismiss 호출 없음', async () => {
    await cancelAllSafetyNetAlarms(TRIP_TOKEN);
    expect(mockedCancel).not.toHaveBeenCalled();
    expect(mockedDismiss).not.toHaveBeenCalled();
  });

  it('delivered tray 조회 실패 시 pending cancel은 보존 (graceful)', async () => {
    mockedGetAll.mockResolvedValueOnce([
      { identifier: `alarm-${TRIP_TOKEN}-${GANGNAM}-destination`, content: {}, trigger: null },
    ] as unknown as Notifications.NotificationRequest[]);
    mockedGetPresented.mockRejectedValueOnce(new Error('os fail'));

    await cancelAllSafetyNetAlarms(TRIP_TOKEN);

    expect(mockedCancel).toHaveBeenCalledWith(`alarm-${TRIP_TOKEN}-${GANGNAM}-destination`);
  });

  it('cancel 1차 reject 시 재시도 후 성공 카운트에 반영', async () => {
    mockedGetAll.mockResolvedValueOnce([
      { identifier: `alarm-${TRIP_TOKEN}-A역-destination`, content: {}, trigger: null },
      { identifier: `alarm-${TRIP_TOKEN}-B역-destination`, content: {}, trigger: null },
    ] as unknown as Notifications.NotificationRequest[]);
    mockedCancel
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await cancelAllSafetyNetAlarms(TRIP_TOKEN);

    // 1차 pass 2건(1 reject) + 2차 pass 1건(retry) = 총 3회 호출.
    expect(mockedCancel).toHaveBeenCalledTimes(3);
  });

  it('cancel 재시도 후에도 실패하면 최종 실패로 집계(예외 전파 없음)', async () => {
    mockedGetAll.mockResolvedValueOnce([
      { identifier: `alarm-${TRIP_TOKEN}-A역-destination`, content: {}, trigger: null },
    ] as unknown as Notifications.NotificationRequest[]);
    mockedCancel.mockRejectedValue(new Error('always fails'));

    await expect(cancelAllSafetyNetAlarms(TRIP_TOKEN)).resolves.toBeUndefined();
    expect(mockedCancel).toHaveBeenCalledTimes(2);
  });

  it('4건 이상 1차 reject 시 로그 메시지가 "..." truncate 포함(3건 초과 분기)', async () => {
    const targets = Array.from({ length: 4 }, (_, i) => ({
      identifier: `alarm-${TRIP_TOKEN}-역${i}-destination`,
      content: {},
      trigger: null,
    })) as unknown as Notifications.NotificationRequest[];
    mockedGetAll.mockResolvedValueOnce(targets);
    // 1차 전부 reject, 2차 전부 성공 — pass-1 truncate 분기(4>3)만 정확히 타겟.
    mockedCancel
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await cancelAllSafetyNetAlarms(TRIP_TOKEN);

    expect(mockedCancel).toHaveBeenCalledTimes(8);
  });

  it('4건 이상 2차(최종) reject 시 로그 메시지가 "..." truncate 포함(3건 초과 분기)', async () => {
    const targets = Array.from({ length: 4 }, (_, i) => ({
      identifier: `alarm-${TRIP_TOKEN}-역${i}-destination`,
      content: {},
      trigger: null,
    })) as unknown as Notifications.NotificationRequest[];
    mockedGetAll.mockResolvedValueOnce(targets);
    mockedCancel.mockRejectedValue(new Error('always fails'));

    await expect(cancelAllSafetyNetAlarms(TRIP_TOKEN)).resolves.toBeUndefined();
    expect(mockedCancel).toHaveBeenCalledTimes(8);
  });

  it('delivered dismiss가 일부 reject해도 성공분만 dismissedCount에 반영', async () => {
    mockedGetAll.mockResolvedValueOnce([
      { identifier: `alarm-${TRIP_TOKEN}-${GANGNAM}-destination`, content: {}, trigger: null },
      { identifier: `alarm-${TRIP_TOKEN}-${교대}-transfer`, content: {}, trigger: null },
    ] as unknown as Notifications.NotificationRequest[]);
    mockedGetPresented.mockResolvedValueOnce([
      { request: { identifier: `alarm-${TRIP_TOKEN}-${GANGNAM}-destination` } },
      { request: { identifier: `alarm-${TRIP_TOKEN}-${교대}-transfer` } },
    ] as unknown as Notifications.Notification[]);
    mockedDismiss.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('dismiss fail'));

    await expect(cancelAllSafetyNetAlarms(TRIP_TOKEN)).resolves.toBeUndefined();
    expect(mockedDismiss).toHaveBeenCalledTimes(2);
  });
});

describe('readSafetyNetData', () => {
  it('SAFETY_NET_ALARM_PREFIX가 아니면 null', () => {
    expect(readSafetyNetData(makeReq('other:id', { channel: 'safety-net' }))).toBeNull();
  });

  it(`${SAFETY_NET_ALARM_PREFIX} prefix라도 data가 없으면 null`, () => {
    expect(readSafetyNetData(makeReq(`${SAFETY_NET_ALARM_PREFIX}x`, null))).toBeNull();
  });

  it('channel !== safety-net이면 null', () => {
    expect(
      readSafetyNetData(makeReq(`${SAFETY_NET_ALARM_PREFIX}x`, { channel: 'other' })),
    ).toBeNull();
  });

  it('station/tripToken이 string이 아니면 null', () => {
    expect(
      readSafetyNetData(
        makeReq(`${SAFETY_NET_ALARM_PREFIX}x`, {
          channel: 'safety-net',
          station: 42,
          tripToken: TRIP_TOKEN,
          kind: 'transfer',
        }),
      ),
    ).toBeNull();
  });

  it('kind가 유효하지 않으면 null', () => {
    expect(
      readSafetyNetData(
        makeReq(`${SAFETY_NET_ALARM_PREFIX}x`, {
          channel: 'safety-net',
          station: GANGNAM,
          tripToken: TRIP_TOKEN,
          kind: 'bogus',
        }),
      ),
    ).toBeNull();
  });

  it('occurrenceIdx 없으면 0으로 기본값', () => {
    const parsed = readSafetyNetData(
      makeReq(`${SAFETY_NET_ALARM_PREFIX}x`, {
        channel: 'safety-net',
        station: GANGNAM,
        tripToken: TRIP_TOKEN,
        kind: 'destination',
      }),
    );
    expect(parsed).toEqual({
      channel: 'safety-net',
      tripToken: TRIP_TOKEN,
      station: GANGNAM,
      kind: 'destination',
      occurrenceIdx: 0,
    });
  });

  it('유효한 data는 그대로 파싱', () => {
    const parsed = readSafetyNetData(
      makeReq(`${SAFETY_NET_ALARM_PREFIX}x`, {
        channel: 'safety-net',
        station: GANGNAM,
        tripToken: TRIP_TOKEN,
        kind: 'transfer',
        occurrenceIdx: 3,
      }),
    );
    expect(parsed).toEqual({
      channel: 'safety-net',
      tripToken: TRIP_TOKEN,
      station: GANGNAM,
      kind: 'transfer',
      occurrenceIdx: 3,
    });
  });
});

describe('cancelSafetyNetByStationKind', () => {
  it('일치하는 station+kind만 cancel', async () => {
    mockedGetAll.mockResolvedValueOnce([
      makeReq(`${SAFETY_NET_ALARM_PREFIX}${TRIP_TOKEN}-${GANGNAM}-destination`, {
        channel: 'safety-net',
        station: GANGNAM,
        tripToken: TRIP_TOKEN,
        kind: 'destination',
      }),
      makeReq(`${SAFETY_NET_ALARM_PREFIX}${TRIP_TOKEN}-${교대}-transfer`, {
        channel: 'safety-net',
        station: 교대,
        tripToken: TRIP_TOKEN,
        kind: 'transfer',
      }),
    ]);

    await cancelSafetyNetByStationKind(GANGNAM, 'destination');

    expect(mockedCancel).toHaveBeenCalledTimes(1);
    expect(mockedCancel).toHaveBeenCalledWith(`${SAFETY_NET_ALARM_PREFIX}${TRIP_TOKEN}-${GANGNAM}-destination`);
  });

  it('매칭 없으면 cancel 호출 없음', async () => {
    mockedGetAll.mockResolvedValueOnce([]);
    await cancelSafetyNetByStationKind(GANGNAM, 'destination');
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('매칭은 있지만 cancel이 재시도까지 모두 실패하면 info 로그 없이 종료(cancelled=0)', async () => {
    mockedGetAll.mockResolvedValueOnce([
      makeReq(`${SAFETY_NET_ALARM_PREFIX}${TRIP_TOKEN}-${GANGNAM}-destination`, {
        channel: 'safety-net',
        station: GANGNAM,
        tripToken: TRIP_TOKEN,
        kind: 'destination',
      }),
    ]);
    mockedCancel.mockRejectedValue(new Error('always fails'));

    await expect(cancelSafetyNetByStationKind(GANGNAM, 'destination')).resolves.toBeUndefined();
    expect(mockedCancel).toHaveBeenCalledTimes(2);
  });
});

describe('rescheduleSafetyNetAlarm', () => {
  const route = makeDirectRoute(5, '2'); // legMs=600_000

  it('past-time(newArrivalMs <= now)이면 no-op', async () => {
    const result = await rescheduleSafetyNetAlarm({
      tripToken: TRIP_TOKEN,
      route,
      destinationName: GANGNAM,
      stationName: GANGNAM,
      newArrivalMs: START_TIME,
      now: START_TIME,
    });
    expect(result).toEqual({ cancelled: 0, scheduled: 0 });
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('waypoint 매칭 실패 시 no-op', async () => {
    const result = await rescheduleSafetyNetAlarm({
      tripToken: TRIP_TOKEN,
      route,
      destinationName: GANGNAM,
      stationName: '존재안함역',
      newArrivalMs: START_TIME + 100_000,
      now: START_TIME,
    });
    expect(result).toEqual({ cancelled: 0, scheduled: 0 });
  });

  it('매칭되면 cancel + 새 시각으로 재예약', async () => {
    mockedGetAll.mockResolvedValueOnce([
      makeReq(`${SAFETY_NET_ALARM_PREFIX}${TRIP_TOKEN}-${GANGNAM}-destination`, {
        channel: 'safety-net',
        station: GANGNAM,
        tripToken: TRIP_TOKEN,
        kind: 'destination',
        occurrenceIdx: 0,
      }),
    ]);
    const newArrival = START_TIME + 700_000;
    const result = await rescheduleSafetyNetAlarm({
      tripToken: TRIP_TOKEN,
      route,
      destinationName: GANGNAM,
      stationName: GANGNAM,
      newArrivalMs: newArrival,
      now: START_TIME,
    });
    expect(result).toEqual({ cancelled: 1, scheduled: 1 });
    expect(mockedCancel).toHaveBeenCalledWith(`${SAFETY_NET_ALARM_PREFIX}${TRIP_TOKEN}-${GANGNAM}-destination`);
    const expectedLead = 600_000 / 5;
    expect(scheduledFireMs()).toEqual([newArrival - expectedLead + SAFETY_NET_BUFFER_MS]);
  });

  it('재예약 시각도 과거면 cancel만 하고 재스케줄 없음', async () => {
    // #2112 — cancel-only 가드(matches.length===0 조기 반환)가 fireMs 분기보다 앞에 있으므로,
    // "과거 시각" 분기(L473-477)에 결정적으로 도달하려면 매칭 예약을 seed해야 한다.
    mockedGetAll.mockResolvedValueOnce([
      makeReq(`${SAFETY_NET_ALARM_PREFIX}${TRIP_TOKEN}-${GANGNAM}-destination`, {
        channel: 'safety-net',
        station: GANGNAM,
        tripToken: TRIP_TOKEN,
        kind: 'destination',
        occurrenceIdx: 0,
      }),
    ]);
    // makeDirectRoute 픽스처는 legMs=stops*120_000이라 earlyLead가 항상 120_000(<버퍼 180_000)로
    // 고정돼 fireMs가 항상 newArrivalMs보다 미래 — "재예약 시각도 과거" 분기가 구조적으로 불가능.
    // earlyLead(=legMs/stops)가 버퍼보다 큰 route를 직접 구성해 fireMs < newArrivalMs를 만든다.
    // travelSeconds=1000s, stops=2 → legMs=1_000_000, earlyLead=500_000 > 180_000 버퍼.
    const bigLeadRoute = { type: 'direct' as const, stops: 2, line: '2' as const, travelSeconds: 1000 };
    // newArrivalMs > now(첫 past-time 가드 통과)이지만 fireMs(=newArrival-earlyLead+buffer)가
    // now보다 과거가 되도록 now를 fireMs~newArrivalMs 사이로 둔다.
    const newArrival = START_TIME + 700_000;
    const now = newArrival - 100_000; // fireMs = newArrival - 500_000 + 180_000 = newArrival - 320_000 < now
    const result = await rescheduleSafetyNetAlarm({
      tripToken: TRIP_TOKEN,
      route: bigLeadRoute,
      destinationName: GANGNAM,
      stationName: GANGNAM,
      newArrivalMs: newArrival,
      now,
    });
    expect(result.scheduled).toBe(0);
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('now 미지정 시 Date.now() 사용', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(START_TIME);
    // #2089 리뷰 P1-1 — reschedule은 기존 armed 예약이 있어야만 재예약(cancel-only 정책).
    // Date.now() 기본값 검증이 목적이므로 매칭 예약 1건을 seed한다.
    mockedGetAll.mockResolvedValueOnce([
      makeReq(`${SAFETY_NET_ALARM_PREFIX}${TRIP_TOKEN}-${GANGNAM}-destination`, {
        channel: 'safety-net',
        station: GANGNAM,
        tripToken: TRIP_TOKEN,
        kind: 'destination',
        occurrenceIdx: 0,
      }),
    ]);
    const result = await rescheduleSafetyNetAlarm({
      tripToken: TRIP_TOKEN,
      route,
      destinationName: GANGNAM,
      stationName: GANGNAM,
      newArrivalMs: START_TIME + 700_000,
    });
    expect(result.scheduled).toBe(1);
    spy.mockRestore();
  });

  it('occurrenceIdx 지정 시 해당 occurrence만 매칭', async () => {
    const dupRoute = makeMultiTransferRoute({
      transfers: [
        { transferName: GANGNAM, fromLine: '2', toLine: '3', stopsToTransfer: 3 },
        { transferName: GANGNAM, fromLine: '3', toLine: '2', stopsToTransfer: 3 },
      ],
      stopsAfterLastTransfer: 3,
    });
    mockedGetAll.mockResolvedValueOnce([
      makeReq(`${SAFETY_NET_ALARM_PREFIX}${TRIP_TOKEN}-${GANGNAM}-transfer#1`, {
        channel: 'safety-net',
        station: GANGNAM,
        tripToken: TRIP_TOKEN,
        kind: 'transfer',
        occurrenceIdx: 1,
      }),
    ]);
    const result = await rescheduleSafetyNetAlarm({
      tripToken: TRIP_TOKEN,
      route: dupRoute,
      destinationName: SEOUL_STATION,
      stationName: GANGNAM,
      occurrenceIdx: 1,
      newArrivalMs: START_TIME + 700_000,
      now: START_TIME,
    });
    expect(result.cancelled).toBe(1);
    expect(scheduledIdentifiers()).toEqual([`alarm-${TRIP_TOKEN}-${GANGNAM}-transfer#1`]);
  });
});

// #2112 P1-2 — device-local arming id의 결정성 + effective token 우선순위 3분기.
// (환경 의존 없이 순수 함수로 직접 커버 — CI/로컬 커버리지 드리프트 방지)
describe('deviceLocalTripId / resolveEffectiveTripToken (#2112 P1-2)', () => {
  it('deviceLocalTripId는 tripStart 기반 결정적 id를 생성한다', () => {
    expect(deviceLocalTripId(1_000_000)).toBe('local-1000000');
    expect(deviceLocalTripId(1_000_000)).toBe(deviceLocalTripId(1_000_000));
  });

  it('backend token이 있으면 그대로 사용한다', () => {
    expect(resolveEffectiveTripToken('BACKEND-TOK', 1_000_000)).toBe('BACKEND-TOK');
  });

  it('backend token이 없고 tripStart가 있으면 device-local id로 fallback', () => {
    expect(resolveEffectiveTripToken(null, 1_000_000)).toBe('local-1000000');
  });

  it('둘 다 없으면 null (trip 미시작)', () => {
    expect(resolveEffectiveTripToken(null, null)).toBeNull();
  });
});
