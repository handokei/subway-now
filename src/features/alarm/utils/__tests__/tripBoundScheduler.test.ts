import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  TRIP_BOUND_ALARM_PREFIX,
  cancelTripBoundAlarms,
  deriveTripBoundStops,
  prescheduleStationAlerts,
  tripBoundAlarmIdentifier,
  type TripBoundStop,
} from '../tripBoundScheduler';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

jest.mock('expo-notifications');

const mockLoggerWarn = jest.fn();
const mockLoggerInfo = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
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

const NOW = new Date('2026-06-05T09:00:00Z').getTime();

// 합리적인 trip — 3 stop, 첫 두 stop은 transfer, 마지막 stop이 destination.
// 각 hop 2분(120_000ms). data-driven — 함수가 길이/타입에 분기하지 않음을 확인.
const defaultStops: TripBoundStop[] = [
  { stationName: '동대문', alarmType: 'transfer' },
  { stationName: '서울역', alarmType: 'transfer' },
  { stationName: '강남', alarmType: 'destination' },
];
const defaultHops = [120_000, 120_000, 120_000];

describe('tripBoundAlarmIdentifier', () => {
  it('prefix + phaseId + stationName 결합 identifier를 만든다', () => {
    expect(tripBoundAlarmIdentifier({ phaseId: 'early', stationName: '강남' })).toBe(
      'tba:early:강남',
    );
    expect(tripBoundAlarmIdentifier({ phaseId: 'imminent', stationName: '시청' })).toBe(
      'tba:imminent:시청',
    );
  });
  it('prefix 상수는 노출된 값과 일치한다', () => {
    expect(TRIP_BOUND_ALARM_PREFIX).toBe('tba:');
  });
});

describe('prescheduleStationAlerts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoggerWarn.mockClear();
    mockLoggerInfo.mockClear();
    mockedSchedule.mockResolvedValue('id');
    jest.replaceProperty(Platform, 'OS', 'ios');
    // wall-clock 가드 (Date.now())가 NOW 기준 fixture를 통과시키도록 fake timer 시점을 NOW에 고정.
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stop별 early/imminent 두 phase를 예약한다 — stop 0 early는 정의상 fire=startTime이라 skip', async () => {
    // 첫 stop의 early lead는 자기 자신의 hopMs라 fire = startTime + hopMs - hopMs = startTime.
    // `fireMs <= startTime` 가드로 skip된다. 따라서 N stop trip은 (N*2 - 1)건 예약된다.
    const result = await prescheduleStationAlerts({
      routeStops: defaultStops,
      estimatedHopTimesMs: defaultHops,
      startTime: NOW,
    });

    expect(result).toHaveLength(defaultStops.length * 2 - 1);
    expect(mockedSchedule).toHaveBeenCalledTimes(defaultStops.length * 2 - 1);
  });

  it('각 stop의 early는 (arrival - hopMs), imminent는 (arrival - 10s)에 fire한다', async () => {
    const result = await prescheduleStationAlerts({
      routeStops: defaultStops,
      estimatedHopTimesMs: defaultHops,
      startTime: NOW,
    });

    // stop 0: arrival=NOW+120_000, early=NOW+0(=startTime → skip), imminent=NOW+110_000
    // stop 1: arrival=NOW+240_000, early=NOW+120_000, imminent=NOW+230_000
    // stop 2: arrival=NOW+360_000, early=NOW+240_000, imminent=NOW+350_000
    // → stop 0 early는 fire<=startTime이라 skip → 총 5건
    expect(result).toHaveLength(5);
    expect(result.map((r) => r.identifier)).toEqual([
      'tba:imminent:동대문',
      'tba:early:서울역',
      'tba:imminent:서울역',
      'tba:early:강남',
      'tba:imminent:강남',
    ]);
    expect(result[0].fireDate).toEqual(new Date(NOW + 110_000));
    expect(result[1].fireDate).toEqual(new Date(NOW + 120_000));
    expect(result[4].fireDate).toEqual(new Date(NOW + 350_000));
  });

  it('alarmType이 event.type으로 그대로 전달된다 (transfer/destination 데이터 주도)', async () => {
    const result = await prescheduleStationAlerts({
      routeStops: defaultStops,
      estimatedHopTimesMs: defaultHops,
      startTime: NOW,
    });
    const types = result.map((r) => `${r.event.stationName}/${r.event.type}`);
    expect(types).toContain('동대문/transfer');
    expect(types).toContain('서울역/transfer');
    expect(types).toContain('강남/destination');
  });

  it('routeStops가 비어 있으면 0건 반환, schedule을 호출하지 않는다', async () => {
    const result = await prescheduleStationAlerts({
      routeStops: [],
      estimatedHopTimesMs: [],
      startTime: NOW,
    });
    expect(result).toEqual([]);
    expect(mockedSchedule).not.toHaveBeenCalled();
    // 빈 입력은 정상 — warn 없음.
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('routeStops와 estimatedHopTimesMs 길이가 다르면 0건 + warn', async () => {
    const result = await prescheduleStationAlerts({
      routeStops: defaultStops,
      estimatedHopTimesMs: [120_000, 120_000],
      startTime: NOW,
    });
    expect(result).toEqual([]);
    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('reason=length-mismatch stops=3 hops=2'),
    );
  });

  it('모든 fireMs가 startTime 이하라면 0건 + reason=all-past warn', async () => {
    // 단일 stop + hop=0ms → arrival=startTime, 모든 phase의 fireMs<=startTime → 전부 skip.
    const result = await prescheduleStationAlerts({
      routeStops: [{ stationName: '강남', alarmType: 'destination' }],
      estimatedHopTimesMs: [0],
      startTime: NOW,
    });
    expect(result).toEqual([]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('reason=all-past'),
    );
  });

  it('정상 예약 케이스에서는 warn을 발화하지 않고 info만 남긴다', async () => {
    await prescheduleStationAlerts({
      routeStops: defaultStops,
      estimatedHopTimesMs: defaultHops,
      startTime: NOW,
    });
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('prescheduled 5 alarms for 3 stops'),
    );
  });

  it('iOS imminent phase는 interruptionLevel=timeSensitive', async () => {
    await prescheduleStationAlerts({
      routeStops: defaultStops,
      estimatedHopTimesMs: defaultHops,
      startTime: NOW,
    });
    // imminent phase 호출 — 적어도 한 번은 timeSensitive로 호출되어야 한다.
    const calls = mockedSchedule.mock.calls.map((c) => c[0]);
    const imminent = calls.find((c) => c.identifier?.startsWith('tba:imminent:'));
    expect(imminent?.content).toMatchObject({ interruptionLevel: 'timeSensitive' });
  });

  it('iOS early phase는 interruptionLevel=active', async () => {
    await prescheduleStationAlerts({
      routeStops: defaultStops,
      estimatedHopTimesMs: defaultHops,
      startTime: NOW,
    });
    const calls = mockedSchedule.mock.calls.map((c) => c[0]);
    const early = calls.find((c) => c.identifier?.startsWith('tba:early:'));
    expect(early?.content).toMatchObject({ interruptionLevel: 'active' });
  });

  it('Android는 channelId + priority MAX를 포함, iOS interruptionLevel은 없음', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await prescheduleStationAlerts({
      routeStops: defaultStops,
      estimatedHopTimesMs: defaultHops,
      startTime: NOW,
    });
    const call = mockedSchedule.mock.calls[0][0];
    expect(call.content).toMatchObject({
      channelId: 'station-alarm',
      priority: Notifications.AndroidNotificationPriority.MAX,
      sound: 'alarm.wav',
    });
    expect(call.content).not.toHaveProperty('interruptionLevel');
  });

  it('trigger.date에 fireDate가 전달된다', async () => {
    const result = await prescheduleStationAlerts({
      routeStops: defaultStops,
      estimatedHopTimesMs: defaultHops,
      startTime: NOW,
    });
    const firstCall = mockedSchedule.mock.calls[0][0];
    expect(firstCall.trigger).toEqual({
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: result[0].fireDate,
    });
  });

  it('scheduleNotificationAsync가 throw하면 caller로 전파한다 (try/catch 미흡수)', async () => {
    mockedSchedule.mockRejectedValueOnce(new Error('permission denied'));
    await expect(
      prescheduleStationAlerts({
        routeStops: defaultStops,
        estimatedHopTimesMs: defaultHops,
        startTime: NOW,
      }),
    ).rejects.toThrow('permission denied');
  });

  it('stop 1개짜리 trip(direct route)도 데이터 그대로 처리한다', async () => {
    // startTime 30s 전부터 시작 → early fire=NOW-30s+600s-600s=NOW-30s? 아님: fire=arrival-hopMs.
    // arrival=startTime+600_000, early lead=hopMs=600_000 → fire=startTime(=NOW-30_000) → skip.
    // 그래서 30s 전 시작이라도 early는 항상 startTime에 떨어진다. 미래로 보내려면 hop을 분리해야.
    // 단일 stop 시나리오에서 early는 정의상 fire=startTime이라 skip된다 — 의도된 정책.
    // imminent만 1건 예약된다.
    const result = await prescheduleStationAlerts({
      routeStops: [{ stationName: '강남', alarmType: 'destination' }],
      estimatedHopTimesMs: [600_000],
      startTime: NOW,
    });
    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('tba:imminent:강남');
    expect(result[0].fireDate).toEqual(new Date(NOW + 590_000));
  });

  it('hopMs가 NaN/Infinity/음수면 해당 stop skip + warn', async () => {
    const result = await prescheduleStationAlerts({
      routeStops: [
        { stationName: '동대문', alarmType: 'transfer' },
        { stationName: '서울역', alarmType: 'transfer' },
        { stationName: '강남', alarmType: 'destination' },
      ],
      estimatedHopTimesMs: [120_000, Number.NaN, 120_000],
      startTime: NOW,
    });
    // NaN stop은 cumulativeMs에 누적되지 않아 다음 stop fireMs가 startTime+120_000 그대로.
    // result는 정상 hop stop만 포함.
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('invalid-hop stop=서울역'),
    );
    // 적어도 하나 이상 정상 stop의 알람이 예약되어야 한다 (NaN propagation 차단 확인).
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => Number.isFinite(r.fireDate.getTime()))).toBe(true);
  });

  it('route에 같은 stationName이 중복 등장하면 두 번째부터 :n suffix로 unique', async () => {
    // 순환 노선/route 다시 방문 케이스. iOS scheduleNotificationAsync는 동일 identifier 시
    // silent overwrite하므로 phaseStationOccurrence map으로 idx suffix 추가.
    const result = await prescheduleStationAlerts({
      routeStops: [
        { stationName: '시청', alarmType: 'transfer' },
        { stationName: '강남', alarmType: 'transfer' },
        { stationName: '시청', alarmType: 'destination' },
      ],
      estimatedHopTimesMs: [120_000, 120_000, 120_000],
      startTime: NOW,
    });
    const ids = result.map((r) => r.identifier);
    // 첫 시청 imminent → 기본 identifier, 두 번째 시청 imminent → :1 suffix.
    expect(ids).toContain('tba:imminent:시청');
    expect(ids).toContain('tba:imminent:시청:1');
    // 모두 unique
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('cancelTripBoundAlarms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoggerInfo.mockClear();
  });

  it('tba: prefix 알람만 취소하고 다른 prefix는 건드리지 않는다', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: 'tba:early:강남' },
      { identifier: 'tba:imminent:강남' },
      { identifier: 'alarm:early:강남' }, // 기존 alarmScheduler 예약
      { identifier: 'bl:T1:0:early:강남' }, // boardingLockScheduler 예약
      { identifier: 'current-station' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    await cancelTripBoundAlarms();

    expect(mockedCancel).toHaveBeenCalledTimes(2);
    expect(mockedCancel).toHaveBeenCalledWith('tba:early:강남');
    expect(mockedCancel).toHaveBeenCalledWith('tba:imminent:강남');
    expect(mockedCancel).not.toHaveBeenCalledWith('alarm:early:강남');
    expect(mockedCancel).not.toHaveBeenCalledWith('bl:T1:0:early:강남');
    expect(mockedCancel).not.toHaveBeenCalledWith('current-station');
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('cancelled 2 trip-bound alarms'),
    );
  });

  it('취소 대상이 없으면 cancel을 호출하지 않고 info 로그도 남기지 않는다', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: 'alarm:early:강남' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    await cancelTripBoundAlarms();
    expect(mockedCancel).not.toHaveBeenCalled();
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it('OS 큐가 비어 있으면 안전하게 통과한다', async () => {
    mockedGetAll.mockResolvedValue([]);
    await expect(cancelTripBoundAlarms()).resolves.toBeUndefined();
    expect(mockedCancel).not.toHaveBeenCalled();
  });
});

// #918 (A3 후속) — useTripBoundAlarmScheduler가 호출하는 caller-side helper.
// route 종류별 hop 매핑 + legStops=0 fallback을 검증.
describe('deriveTripBoundStops', () => {
  it('route=null이면 빈 배열', () => {
    const { routeStops, estimatedHopTimesMs } = deriveTripBoundStops(null, '강남');
    expect(routeStops).toEqual([]);
    expect(estimatedHopTimesMs).toEqual([]);
  });

  it('destinationName=null이면 빈 배열', () => {
    const { routeStops } = deriveTripBoundStops(makeDirectRoute(2, '2'), null);
    expect(routeStops).toEqual([]);
  });

  it('direct route → destination 1개 waypoint, hopMs=full leg time', () => {
    const route = makeDirectRoute(3, '2');
    const { routeStops, estimatedHopTimesMs } = deriveTripBoundStops(route, '강남');
    expect(routeStops).toEqual([{ stationName: '강남', alarmType: 'destination' }]);
    expect(estimatedHopTimesMs.length).toBe(1);
    // waypoint-level: hopMs = travelSeconds * 1000 (평균 X). 360 * 1000 = 360_000.
    expect(estimatedHopTimesMs[0]).toBe(360_000);
  });

  it('transfer route → 환승역 + 도착역 2개 waypoint, 각 leg full seconds', () => {
    const route = makeTransferRoute({
      transferName: '교대',
      fromLine: '2',
      toLine: '3',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const { routeStops, estimatedHopTimesMs } = deriveTripBoundStops(route, '강남');
    expect(routeStops).toEqual([
      { stationName: '교대', alarmType: 'transfer' },
      { stationName: '강남', alarmType: 'destination' },
    ]);
    // hopMs는 각 leg full seconds. 양수 검증 (정확 값은 makeTransferRoute fixture 의존).
    expect(estimatedHopTimesMs.length).toBe(2);
    expect(estimatedHopTimesMs[0]).toBeGreaterThan(0);
    expect(estimatedHopTimesMs[1]).toBeGreaterThan(0);
  });

  it('multi-transfer route → 환승역 N개 + 마지막 leg 도착역, hopIndex 매핑 정확', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 2 },
        { transferName: '종로3가', fromLine: '1', toLine: '3', stopsToTransfer: 3 },
      ],
      stopsAfterLastTransfer: 4,
    });
    const { routeStops, estimatedHopTimesMs } = deriveTripBoundStops(route, '약수');
    expect(routeStops.map((s) => s.stationName)).toEqual(['시청', '종로3가', '약수']);
    expect(routeStops.map((s) => s.alarmType)).toEqual(['transfer', 'transfer', 'destination']);
    expect(estimatedHopTimesMs.length).toBe(3);
    expect(estimatedHopTimesMs.every((ms) => ms > 0)).toBe(true);
  });

  it('legSeconds=0/음수/NaN/Infinity면 HOP_TIME_MS fallback', () => {
    const route = { type: 'direct' as const, stops: 1, line: '2' as const, travelSeconds: 0 };
    const { estimatedHopTimesMs } = deriveTripBoundStops(route, '강남');
    expect(estimatedHopTimesMs).toEqual([90_000]);
  });
});
