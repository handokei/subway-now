import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  TRIPBOUND_WINDOW_SIZE,
  TRIP_BOUND_ALARM_PREFIX,
  cancelTripBoundAlarms,
  clearRegisteredTripRouteSig,
  deriveTripBoundStops,
  getRegisteredTripRouteSig,
  parseTripBoundAlarmIdentifier,
  prescheduleStationAlerts,
  rescheduleTripBoundAlarm,
  setRegisteredTripRouteSig,
  topUpTripBoundWindow,
  tripBoundAlarmIdentifier,
  type TripBoundStop,
} from '../tripBoundScheduler';
import { TRIP_BOUND_ROUTE_SIG_KEY } from '../../../../shared/constants/storageKeys';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';
import {
  makeUniformHops,
  makeUniformStops,
} from '../../testHelpers/tripBoundTestFactory';

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

// `prescheduleStationAlerts` wrapper that fills NOW + defaults — eliminates copy-pasted
// `routeStops/estimatedHopTimesMs/startTime` triples across ~15 call sites.
const prescheduleWith = (
  overrides: Partial<Parameters<typeof prescheduleStationAlerts>[0]> = {},
) =>
  prescheduleStationAlerts({
    routeStops: defaultStops,
    estimatedHopTimesMs: defaultHops,
    startTime: NOW,
    ...overrides,
  });

// Shared iOS + fake-timer setup used by both `prescheduleStationAlerts` describes.
const setupIosFakeTimers = () => {
  jest.clearAllMocks();
  mockLoggerWarn.mockClear();
  mockLoggerInfo.mockClear();
  mockedSchedule.mockResolvedValue('id');
  jest.replaceProperty(Platform, 'OS', 'ios');
  jest.useFakeTimers().setSystemTime(NOW);
};
const teardownFakeTimers = () => {
  jest.useRealTimers();
};

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

describe('parseTripBoundAlarmIdentifier (#918 A3 PR2 → #1193 확장)', () => {
  it('tba:phase:station 형식을 정상 파싱한다 (occurrenceIdx=0)', () => {
    expect(parseTripBoundAlarmIdentifier('tba:early:강남')).toEqual({
      phaseId: 'early',
      stationName: '강남',
      occurrenceIdx: 0,
    });
    expect(parseTripBoundAlarmIdentifier('tba:imminent:시청')).toEqual({
      phaseId: 'imminent',
      stationName: '시청',
      occurrenceIdx: 0,
    });
  });

  // #1193 — :n suffix를 분리해 stationName과 occurrenceIdx를 따로 반환. 이전 PR4까지는
  // stationName에 ':n'이 합쳐진 채 반환되어 reschedule cancel 매칭이 mismatch였다.
  it.each([
    ['tba:imminent:시청:1', 'imminent', '시청', 1],
    ['tba:early:강남:2', 'early', '강남', 2],
    ['tba:imminent:홍대입구:10', 'imminent', '홍대입구', 10],
  ] as const)('occurrence suffix를 분리해 반환한다 (%s)', (id, phaseId, stationName, occurrenceIdx) => {
    expect(parseTripBoundAlarmIdentifier(id)).toEqual({
      phaseId,
      stationName,
      occurrenceIdx,
    });
  });

  it('suffix가 숫자가 아니면 stationName에 흡수 (graceful: 역명에 콜론 포함 케이스)', () => {
    expect(parseTripBoundAlarmIdentifier('tba:early:역명:abc')).toEqual({
      phaseId: 'early',
      stationName: '역명:abc',
      occurrenceIdx: 0,
    });
  });

  it(':0 suffix는 graceful하게 0으로 해석 (round-trip 안전)', () => {
    // `prescheduleStationAlerts`는 base ID(:0 생략)를 발급하지만, 외부에서 `:0`이 들어와도 동작.
    expect(parseTripBoundAlarmIdentifier('tba:early:강남:0')).toEqual({
      phaseId: 'early',
      stationName: '강남',
      occurrenceIdx: 0,
    });
  });

  it('prefix가 다르면 null', () => {
    expect(parseTripBoundAlarmIdentifier('alarm:early:강남')).toBeNull();
    expect(parseTripBoundAlarmIdentifier('bl:T1:0:early:강남')).toBeNull();
    expect(parseTripBoundAlarmIdentifier('current-station')).toBeNull();
  });

  it('포맷이 망가지면 null (콜론 없음 / phaseId 비어 있음 / stationName 비어 있음)', () => {
    expect(parseTripBoundAlarmIdentifier('tba:onlyphase')).toBeNull();
    expect(parseTripBoundAlarmIdentifier('tba::강남')).toBeNull();
    expect(parseTripBoundAlarmIdentifier('tba:early:')).toBeNull();
  });
});

describe('registered trip route sig storage (#918 A3 PR2)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('set → get round-trip 동일 값을 반환한다', async () => {
    await setRegisteredTripRouteSig('A:1|B:2');
    expect(await getRegisteredTripRouteSig()).toBe('A:1|B:2');
  });

  it('미설정 시 null', async () => {
    expect(await getRegisteredTripRouteSig()).toBeNull();
  });

  it('clear는 다시 null을 반환하게 한다', async () => {
    await setRegisteredTripRouteSig('A:1');
    await clearRegisteredTripRouteSig();
    expect(await getRegisteredTripRouteSig()).toBeNull();
  });

  it('set은 TRIP_BOUND_ROUTE_SIG_KEY 키에 저장한다', async () => {
    await setRegisteredTripRouteSig('A:1|B:2');
    expect(await AsyncStorage.getItem(TRIP_BOUND_ROUTE_SIG_KEY)).toBe('A:1|B:2');
  });

  it('AsyncStorage setItem이 throw해도 graceful (예외 전파 없음)', async () => {
    const spy = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk'));
    await expect(setRegisteredTripRouteSig('A:1')).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('AsyncStorage getItem이 throw해도 null 반환', async () => {
    const spy = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    expect(await getRegisteredTripRouteSig()).toBeNull();
    spy.mockRestore();
  });

  it('AsyncStorage removeItem이 throw해도 graceful', async () => {
    const spy = jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('disk'));
    await expect(clearRegisteredTripRouteSig()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('prescheduleStationAlerts', () => {
  beforeEach(setupIosFakeTimers);
  afterEach(teardownFakeTimers);

  it('stop별 early/imminent 두 phase를 예약한다 — stop 0 early는 정의상 fire=startTime이라 skip', async () => {
    // 첫 stop의 early lead는 자기 자신의 hopMs라 fire = startTime + hopMs - hopMs = startTime.
    // `fireMs <= startTime` 가드로 skip된다. 따라서 N stop trip은 (N*2 - 1)건 예약된다.
    const result = await prescheduleWith();

    expect(result).toHaveLength(defaultStops.length * 2 - 1);
    expect(mockedSchedule).toHaveBeenCalledTimes(defaultStops.length * 2 - 1);
  });

  it('각 stop의 early는 (arrival - hopMs), imminent는 (arrival - 10s)에 fire한다', async () => {
    const result = await prescheduleWith();

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
    const result = await prescheduleWith();
    const types = result.map((r) => `${r.event.stationName}/${r.event.type}`);
    expect(types).toContain('동대문/transfer');
    expect(types).toContain('서울역/transfer');
    expect(types).toContain('강남/destination');
  });

  it('routeStops가 비어 있으면 0건 반환, schedule을 호출하지 않는다', async () => {
    const result = await prescheduleWith({ routeStops: [], estimatedHopTimesMs: [] });
    expect(result).toEqual([]);
    expect(mockedSchedule).not.toHaveBeenCalled();
    // 빈 입력은 정상 — warn 없음.
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('routeStops와 estimatedHopTimesMs 길이가 다르면 0건 + warn', async () => {
    const result = await prescheduleWith({ estimatedHopTimesMs: [120_000, 120_000] });
    expect(result).toEqual([]);
    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('reason=length-mismatch stops=3 hops=2'),
    );
  });

  it('모든 fireMs가 startTime 이하라면 0건 + reason=all-past warn', async () => {
    // 단일 stop + hop=0ms → arrival=startTime, 모든 phase의 fireMs<=startTime → 전부 skip.
    const result = await prescheduleWith({
      routeStops: [{ stationName: '강남', alarmType: 'destination' }],
      estimatedHopTimesMs: [0],
    });
    expect(result).toEqual([]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('reason=all-past'),
    );
  });

  it('정상 예약 케이스에서는 warn을 발화하지 않고 info만 남긴다', async () => {
    await prescheduleWith();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('prescheduled 5 alarms for 3 stops'),
    );
  });

  // iOS phase별 interruptionLevel — phase identifier prefix + 기대 level 매핑.
  it.each([
    ['imminent', 'tba:imminent:', 'timeSensitive'],
    ['early', 'tba:early:', 'active'],
  ])('iOS %s phase는 interruptionLevel=%s', async (_phase, prefix, level) => {
    await prescheduleWith();
    const calls = mockedSchedule.mock.calls.map((c) => c[0]);
    const match = calls.find((c) => c.identifier?.startsWith(prefix));
    expect(match?.content).toMatchObject({ interruptionLevel: level });
  });

  it('Android는 channelId + priority MAX를 포함, iOS interruptionLevel은 없음', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await prescheduleWith();
    const call = mockedSchedule.mock.calls[0][0];
    expect(call.content).toMatchObject({
      channelId: 'station-alarm',
      priority: Notifications.AndroidNotificationPriority.MAX,
      sound: 'alarm.wav',
    });
    expect(call.content).not.toHaveProperty('interruptionLevel');
  });

  it('trigger.date에 fireDate가 전달된다', async () => {
    const result = await prescheduleWith();
    const firstCall = mockedSchedule.mock.calls[0][0];
    expect(firstCall.trigger).toEqual({
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: result[0].fireDate,
    });
  });

  it('scheduleNotificationAsync가 throw하면 caller로 전파한다 (try/catch 미흡수)', async () => {
    mockedSchedule.mockRejectedValueOnce(new Error('permission denied'));
    await expect(prescheduleWith()).rejects.toThrow('permission denied');
  });

  it('stop 1개짜리 trip(direct route)도 데이터 그대로 처리한다', async () => {
    // startTime 30s 전부터 시작 → early fire=NOW-30s+600s-600s=NOW-30s? 아님: fire=arrival-hopMs.
    // arrival=startTime+600_000, early lead=hopMs=600_000 → fire=startTime(=NOW-30_000) → skip.
    // 그래서 30s 전 시작이라도 early는 항상 startTime에 떨어진다. 미래로 보내려면 hop을 분리해야.
    // 단일 stop 시나리오에서 early는 정의상 fire=startTime이라 skip된다 — 의도된 정책.
    // imminent만 1건 예약된다.
    const result = await prescheduleWith({
      routeStops: [{ stationName: '강남', alarmType: 'destination' }],
      estimatedHopTimesMs: [600_000],
    });
    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('tba:imminent:강남');
    expect(result[0].fireDate).toEqual(new Date(NOW + 590_000));
  });

  it('hopMs가 NaN/Infinity/음수면 해당 stop skip + warn', async () => {
    const result = await prescheduleWith({
      estimatedHopTimesMs: [120_000, Number.NaN, 120_000],
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
    const result = await prescheduleWith({
      routeStops: [
        { stationName: '시청', alarmType: 'transfer' },
        { stationName: '강남', alarmType: 'transfer' },
        { stationName: '시청', alarmType: 'destination' },
      ],
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

  it('#918 A3 PR2 — sig storage도 함께 클리어한다 (재예약 사이 stale sig 차단)', async () => {
    // spy로 set 호출 횟수만 검증 — auto-mock storage state는 테스트 순서에 의존하지 않게.
    const removeSpy = jest.spyOn(AsyncStorage, 'removeItem');
    mockedGetAll.mockResolvedValue([]);
    await cancelTripBoundAlarms();
    expect(removeSpy).toHaveBeenCalledWith(TRIP_BOUND_ROUTE_SIG_KEY);
    removeSpy.mockRestore();
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

// #918 A3 PR3 — rolling window 64 cap 회피.
describe('TRIPBOUND_WINDOW_SIZE', () => {
  it('64 pending notification cap 안쪽에 들어가는 양수 상수', () => {
    expect(TRIPBOUND_WINDOW_SIZE).toBeGreaterThan(0);
    // 한 stop당 2 phase × WINDOW_SIZE + bl: 채널 여유(20여 개) < 64.
    expect(TRIPBOUND_WINDOW_SIZE * 2).toBeLessThan(64);
  });
});

describe('prescheduleStationAlerts windowSize/startStopIndex (#918 A3 PR3)', () => {
  beforeEach(setupIosFakeTimers);
  afterEach(teardownFakeTimers);

  // 5-stop ABCDE fixture — windowSize/startStopIndex 테스트 공통.
  const fiveStops = makeUniformStops(['A', 'B', 'C', 'D', 'E']);
  const fiveHops = makeUniformHops(5);

  it('windowSize=1이면 첫 stop만 schedule (나머지 stop의 누적은 진행)', async () => {
    // 5 stop trip, window=1 → stop 0의 imminent만(=fire>startTime) 예약.
    // stop 0 early는 fire=startTime이라 skip.
    const result = await prescheduleWith({
      routeStops: fiveStops,
      estimatedHopTimesMs: fiveHops,
      windowSize: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0].identifier).toBe('tba:imminent:A');
  });

  it('startStopIndex=2 + windowSize=2면 stop[2], stop[3]만 schedule, 누적은 정확히 보존', async () => {
    const result = await prescheduleWith({
      routeStops: fiveStops,
      estimatedHopTimesMs: fiveHops,
      startStopIndex: 2,
      windowSize: 2,
    });
    // C의 arrival = NOW + 360_000, early = NOW + 240_000, imminent = NOW + 350_000
    // D의 arrival = NOW + 480_000, early = NOW + 360_000, imminent = NOW + 470_000
    expect(result.map((r) => r.identifier)).toEqual([
      'tba:early:C',
      'tba:imminent:C',
      'tba:early:D',
      'tba:imminent:D',
    ]);
    expect(result[0].fireDate).toEqual(new Date(NOW + 240_000));
    expect(result[1].fireDate).toEqual(new Date(NOW + 350_000));
  });

  it('windowSize=0이면 0건 schedule', async () => {
    const result = await prescheduleWith({ windowSize: 0 });
    expect(result).toEqual([]);
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('startStopIndex 음수는 0으로 clamp (caller bug 흡수)', async () => {
    const result = await prescheduleWith({ startStopIndex: -5 });
    // 음수 clamp → 평소 동작과 동일하게 stop 0부터 (stop 0 early skip).
    expect(result).toHaveLength(5);
  });

  it('windowSize 음수는 0으로 clamp (no-op)', async () => {
    const result = await prescheduleWith({ windowSize: -3 });
    expect(result).toEqual([]);
  });

  it('중복 stationName이 윈도우 밖에 있어도 occurrence suffix가 보존된다', async () => {
    // 윈도우 안 두 번째 등장이 :1 suffix를 받도록 — 윈도우 밖 첫 등장도 occurrence 누적.
    const result = await prescheduleWith({
      routeStops: [
        { stationName: '시청', alarmType: 'transfer' }, // skipped(window 밖)
        { stationName: '강남', alarmType: 'transfer' },
        { stationName: '시청', alarmType: 'destination' }, // 두 번째 등장
      ],
      startStopIndex: 1,
      windowSize: 2,
    });
    const ids = result.map((r) => r.identifier);
    // 두 번째 시청은 :1 suffix를 받아야 한다 — 윈도우 밖 첫 시청의 occurrence가 누적됨.
    expect(ids).toContain('tba:imminent:시청:1');
  });
});

describe('topUpTripBoundWindow (#918 A3 PR3)', () => {
  beforeEach(() => {
    setupIosFakeTimers();
    mockedGetAll.mockResolvedValue([]);
  });
  afterEach(teardownFakeTimers);

  const longStops = makeUniformStops(Array.from({ length: 10 }, (_, i) => `S${i}`));
  const longHops = makeUniformHops(10);

  it('passedStationName이 routeStops에 없으면 no-op', async () => {
    const result = await topUpTripBoundWindow({
      routeStops: longStops,
      estimatedHopTimesMs: longHops,
      startTime: NOW,
      passedStationName: 'UNKNOWN',
      windowSize: 3,
    });
    expect(result).toEqual({ cancelled: 0, scheduled: 0 });
    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('routeStops가 비어 있으면 no-op', async () => {
    const result = await topUpTripBoundWindow({
      routeStops: [],
      estimatedHopTimesMs: [],
      startTime: NOW,
      passedStationName: 'X',
    });
    expect(result).toEqual({ cancelled: 0, scheduled: 0 });
  });

  it('passedIndex 이전 stop의 tba 알람은 cancel, 윈도우 안 stop은 schedule', async () => {
    // 큐에 stop S1(passedStation 이전) + S2(현재 윈도우 안) + S5(이전 윈도우 잔여, 새 윈도우 밖) 존재.
    mockedGetAll.mockResolvedValue([
      { identifier: 'tba:imminent:S1' },
      { identifier: 'tba:early:S2' },
      { identifier: 'tba:imminent:S5' },
      { identifier: 'bl:T:0:early:X' }, // 다른 prefix — 건드리지 않음.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    const result = await topUpTripBoundWindow({
      routeStops: longStops,
      estimatedHopTimesMs: longHops,
      startTime: NOW,
      passedStationName: 'S2', // window = [3, 6)
      windowSize: 3,
    });

    // 새 윈도우 = stops index 3,4,5 = stationName S3, S4, S5. S5는 윈도우 안.
    // S1, S2는 윈도우 밖 → cancel. S5는 윈도우 안 → cancel 안 함.
    expect(mockedCancel).toHaveBeenCalledWith('tba:imminent:S1');
    expect(mockedCancel).toHaveBeenCalledWith('tba:early:S2');
    expect(mockedCancel).not.toHaveBeenCalledWith('tba:imminent:S5');
    expect(mockedCancel).not.toHaveBeenCalledWith('bl:T:0:early:X');
    expect(result.cancelled).toBe(2);
    // schedule된 stop은 S3, S4, S5 — 각 (early, imminent) 2 phase × 3 stop = 6건.
    expect(result.scheduled).toBe(6);
  });

  it('잘못된 identifier(parse=null)는 cancel skip', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: 'tba:malformed' }, // parse → null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    const result = await topUpTripBoundWindow({
      routeStops: longStops,
      estimatedHopTimesMs: longHops,
      startTime: NOW,
      passedStationName: 'S0',
      windowSize: 2,
    });
    expect(mockedCancel).not.toHaveBeenCalledWith('tba:malformed');
    expect(result.cancelled).toBe(0);
  });

  it('windowSize 미지정 시 TRIPBOUND_WINDOW_SIZE 기본값 사용', async () => {
    const result = await topUpTripBoundWindow({
      routeStops: longStops,
      estimatedHopTimesMs: longHops,
      startTime: NOW,
      passedStationName: 'S0',
    });
    // window = [1, min(10, 1+20)] = [1, 10] → 9 stop × 2 phase = 18.
    expect(result.scheduled).toBe(18);
  });

  it('passedIndex가 마지막 stop이면 새 stop 없이 cancel만', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: 'tba:imminent:S0' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    const result = await topUpTripBoundWindow({
      routeStops: longStops,
      estimatedHopTimesMs: longHops,
      startTime: NOW,
      passedStationName: 'S9', // 마지막
      windowSize: 3,
    });
    expect(result.scheduled).toBe(0);
    expect(result.cancelled).toBe(1);
  });

  it('info 로그에 윈도우 범위 + 카운트 출력', async () => {
    await topUpTripBoundWindow({
      routeStops: longStops,
      estimatedHopTimesMs: longHops,
      startTime: NOW,
      passedStationName: 'S0',
      windowSize: 2,
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('topUp passedIndex=0 window=[1,3)'),
    );
  });
});

// #918 A3 PR4 — backend의 reschedule push(tba 채널)을 받아 단일 hop 사전 예약 정정.
describe('rescheduleTripBoundAlarm (#918 A3 PR4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoggerInfo.mockClear();
    mockedSchedule.mockResolvedValue('id');
    jest.replaceProperty(Platform, 'OS', 'ios');
  });

  const directRoute = makeDirectRoute(3, '2');
  const NOW_MS = new Date('2026-06-12T09:00:00Z').getTime();

  // fixture sanity: 회귀 가드(early fire == newArrivalMs - hopMs)의 의미가 fixture에 의해
  // 약해지지 않도록 hopMs 도출 기반인 travelSeconds가 양수임을 명시. fixture가 0이 되면
  // 아래 silent-drop 회귀 가드도 동시에 trivially 통과해 의미를 잃는다.
  it('fixture sanity: directRoute.travelSeconds > 0 (회귀 가드 의미 보장)', () => {
    expect(directRoute.travelSeconds).toBeGreaterThan(0);
  });

  it('past-time이면 cancel/schedule 둘 다 skip + 0건 반환', async () => {
    mockedGetAll.mockResolvedValue([]);
    const r = await rescheduleTripBoundAlarm({
      stationName: '강남',
      newArrivalMs: NOW_MS - 1,
      route: directRoute,
      destinationName: '강남',
      now: NOW_MS,
    });
    expect(r).toEqual({ cancelled: 0, scheduled: 0 });
    expect(mockedGetAll).not.toHaveBeenCalled();
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('route=null이면 graceful no-op', async () => {
    mockedGetAll.mockResolvedValue([]);
    const r = await rescheduleTripBoundAlarm({
      stationName: '강남',
      newArrivalMs: NOW_MS + 60_000,
      route: null,
      destinationName: '강남',
      now: NOW_MS,
    });
    expect(r).toEqual({ cancelled: 0, scheduled: 0 });
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('destinationName=null이면 graceful no-op', async () => {
    mockedGetAll.mockResolvedValue([]);
    const r = await rescheduleTripBoundAlarm({
      stationName: '강남',
      newArrivalMs: NOW_MS + 60_000,
      route: directRoute,
      destinationName: null,
      now: NOW_MS,
    });
    expect(r).toEqual({ cancelled: 0, scheduled: 0 });
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('stationName이 routeStops에 없으면 no-op', async () => {
    mockedGetAll.mockResolvedValue([]);
    const r = await rescheduleTripBoundAlarm({
      stationName: '없는역',
      newArrivalMs: NOW_MS + 60_000,
      route: directRoute,
      destinationName: '강남',
      now: NOW_MS,
    });
    expect(r).toEqual({ cancelled: 0, scheduled: 0 });
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('해당 stationName의 tba: 알람만 cancel하고 newArrivalMs 기준으로 재예약', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: 'tba:early:강남' },
      { identifier: 'tba:imminent:강남' },
      { identifier: 'tba:early:다른역' }, // 보존
      { identifier: 'bl:T1:0:early:강남' }, // 다른 prefix 보존
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    const newArrivalMs = NOW_MS + 600_000;
    const r = await rescheduleTripBoundAlarm({
      stationName: '강남',
      newArrivalMs,
      route: directRoute,
      destinationName: '강남',
      now: NOW_MS,
    });
    expect(r.cancelled).toBe(2);
    // 두 phase 모두 재예약 — 이전엔 toBeGreaterThan(0)이라 early phase silent drop을 통과시켰다.
    expect(r.scheduled).toBe(2);
    expect(mockedCancel).toHaveBeenCalledWith('tba:early:강남');
    expect(mockedCancel).toHaveBeenCalledWith('tba:imminent:강남');
    expect(mockedCancel).not.toHaveBeenCalledWith('tba:early:다른역');
    expect(mockedCancel).not.toHaveBeenCalledWith('bl:T1:0:early:강남');
    // imminent 알람은 newArrivalMs - 10s에 발사.
    const scheduledCalls = mockedSchedule.mock.calls;
    const imminentCall = scheduledCalls.find(
      ([opts]) => (opts as { identifier?: string }).identifier === 'tba:imminent:강남',
    );
    expect(imminentCall).toBeDefined();
    const imminentTrigger = (
      imminentCall?.[0] as { trigger: { date: Date } }
    ).trigger;
    expect(imminentTrigger.date.getTime()).toBe(newArrivalMs - 10_000);
  });

  it('parse 실패 identifier는 skip하고 valid한 것만 처리', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: 'tba:malformed' }, // colon 1개뿐 → parse null
      { identifier: 'tba:early:강남' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    const r = await rescheduleTripBoundAlarm({
      stationName: '강남',
      newArrivalMs: NOW_MS + 600_000,
      route: directRoute,
      destinationName: '강남',
      now: NOW_MS,
    });
    expect(r.cancelled).toBe(1);
    expect(mockedCancel).not.toHaveBeenCalledWith('tba:malformed');
  });

  it('now 미지정 시 Date.now() 기준으로 past-time 판정', async () => {
    jest.useFakeTimers().setSystemTime(NOW_MS);
    try {
      mockedGetAll.mockResolvedValue([]);
      const r = await rescheduleTripBoundAlarm({
        stationName: '강남',
        newArrivalMs: NOW_MS - 1,
        route: directRoute,
        destinationName: '강남',
      });
      expect(r).toEqual({ cancelled: 0, scheduled: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  // 회귀: 이전 구현은 startTime = newArrivalMs - hopMs로 역산해 prescheduleStationAlerts에
  // 단일 stop을 통과시켰고, 그 결과 early phase의 fireMs가 startTime과 정확히 같아져
  // `fireMs <= startTime` 가드에 silent drop됐다. primitive 직접 호출로 전환 후 검증.
  it('early phase는 (newArrivalMs - hopMs)에 정확히 fire한다 (silent drop 회귀 차단)', async () => {
    mockedGetAll.mockResolvedValue([]);
    const newArrivalMs = NOW_MS + 600_000;
    const r = await rescheduleTripBoundAlarm({
      stationName: '강남',
      newArrivalMs,
      route: directRoute,
      destinationName: '강남',
      now: NOW_MS,
    });
    expect(r.scheduled).toBe(2);
    const scheduledCalls = mockedSchedule.mock.calls;
    const earlyCall = scheduledCalls.find(
      ([opts]) => (opts as { identifier?: string }).identifier === 'tba:early:강남',
    );
    expect(earlyCall).toBeDefined();
    const earlyTrigger = (earlyCall?.[0] as { trigger: { date: Date } }).trigger;
    const expectedHopMs = directRoute.travelSeconds * 1000;
    expect(earlyTrigger.date.getTime()).toBe(newArrivalMs - expectedHopMs);
  });

  it('early phase fireMs가 now 이하면 early만 skip, imminent는 예약', async () => {
    mockedGetAll.mockResolvedValue([]);
    // newArrivalMs가 hopMs(=directRoute.travelSeconds*1000)보다 짧은 시간 뒤라
    // early = newArrivalMs - hopMs ≤ now → drop, imminent = newArrivalMs - 10s > now → 예약.
    const hopMs = directRoute.travelSeconds * 1000;
    const newArrivalMs = NOW_MS + hopMs - 1; // early fire = NOW_MS - 1
    const r = await rescheduleTripBoundAlarm({
      stationName: '강남',
      newArrivalMs,
      route: directRoute,
      destinationName: '강남',
      now: NOW_MS,
    });
    expect(r.scheduled).toBe(1);
    const ids = mockedSchedule.mock.calls.map(
      ([opts]) => (opts as { identifier?: string }).identifier,
    );
    expect(ids).toEqual(['tba:imminent:강남']);
  });

  it('imminent phase fireMs도 now 이하면 둘 다 skip', async () => {
    mockedGetAll.mockResolvedValue([]);
    // newArrivalMs가 IMMINENT_LEAD_MS(10s)보다 짧은 시간 뒤 → imminent도 과거.
    const newArrivalMs = NOW_MS + 5_000;
    const r = await rescheduleTripBoundAlarm({
      stationName: '강남',
      newArrivalMs,
      route: directRoute,
      destinationName: '강남',
      now: NOW_MS,
    });
    expect(r.scheduled).toBe(0);
    expect(mockedSchedule).not.toHaveBeenCalled();
  });
});

// #1193 — 중복역 trip(같은 transferName이 route에 두 번 등장)에서 occurrenceIdx로
// 정확한 occurrence만 cancel + 재예약. base ID와 :n suffix가 충돌 없이 격리되는지 검증.
describe('rescheduleTripBoundAlarm 중복역 occurrenceIdx (#1193)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSchedule.mockResolvedValue('id');
    jest.replaceProperty(Platform, 'OS', 'ios');
  });

  // 같은 환승역명을 두 번 등장시키는 multi-transfer route — routeStops는 [회차역, 회차역, 도착역].
  // (deriveTripBoundStops가 transfer name과 destination name을 그대로 stop으로 평탄화함)
  const loopRoute = makeMultiTransferRoute({
    transfers: [
      { transferName: '회차역', fromLine: '2', toLine: '2', stopsToTransfer: 3 },
      { transferName: '회차역', fromLine: '2', toLine: '2', stopsToTransfer: 3 },
    ],
    stopsAfterLastTransfer: 2,
  });
  const NOW_MS = new Date('2026-06-12T09:00:00Z').getTime();
  const destinationName = '강남';
  // 두 occurrence 알람 + 다른 역 알람이 함께 큐에 있는 상태.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fullScheduled = [
    { identifier: 'tba:early:회차역' },
    { identifier: 'tba:imminent:회차역' },
    { identifier: 'tba:early:회차역:1' },
    { identifier: 'tba:imminent:회차역:1' },
    { identifier: 'tba:early:강남' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any;

  const getScheduledIds = () =>
    mockedSchedule.mock.calls.map(
      ([opts]) => (opts as { identifier?: string }).identifier,
    );

  // occurrenceIdx 별로 cancel/schedule 대상 ID가 어떻게 갈리는지만 데이터로 명시.
  it.each([
    {
      label: 'occurrenceIdx=0: base ID만 cancel + 재예약, :1은 보존',
      occurrenceIdx: 0,
      cancelTargets: ['tba:early:회차역', 'tba:imminent:회차역'],
      preserveTargets: ['tba:early:회차역:1', 'tba:imminent:회차역:1', 'tba:early:강남'],
    },
    {
      label: 'occurrenceIdx=1: :1 suffix ID만 cancel + 재예약, base ID는 보존',
      occurrenceIdx: 1,
      cancelTargets: ['tba:early:회차역:1', 'tba:imminent:회차역:1'],
      preserveTargets: ['tba:early:회차역', 'tba:imminent:회차역', 'tba:early:강남'],
    },
  ])('$label', async ({ occurrenceIdx, cancelTargets, preserveTargets }) => {
    mockedGetAll.mockResolvedValue(fullScheduled);
    const r = await rescheduleTripBoundAlarm({
      stationName: '회차역',
      newArrivalMs: NOW_MS + 600_000,
      route: loopRoute,
      destinationName,
      now: NOW_MS,
      occurrenceIdx,
    });
    expect(r.cancelled).toBe(2);
    for (const id of cancelTargets) expect(mockedCancel).toHaveBeenCalledWith(id);
    for (const id of preserveTargets) expect(mockedCancel).not.toHaveBeenCalledWith(id);
    const scheduledIds = getScheduledIds();
    expect(scheduledIds).toEqual(expect.arrayContaining(cancelTargets));
    // 같은 stop의 다른 occurrence ID는 재예약 대상에 포함되지 않음.
    for (const id of preserveTargets) expect(scheduledIds).not.toContain(id);
  });

  it('occurrenceIdx 미지정 시 0(첫 등장)으로 fallback', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: 'tba:early:회차역' },
      { identifier: 'tba:early:회차역:1' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    const r = await rescheduleTripBoundAlarm({
      stationName: '회차역',
      newArrivalMs: NOW_MS + 600_000,
      route: loopRoute,
      destinationName,
      now: NOW_MS,
      // occurrenceIdx 생략
    });
    expect(r.cancelled).toBe(1);
    expect(mockedCancel).toHaveBeenCalledWith('tba:early:회차역');
    expect(mockedCancel).not.toHaveBeenCalledWith('tba:early:회차역:1');
  });

  it('등장 횟수가 occurrenceIdx 이하면 no-op (route 동기화 race)', async () => {
    mockedGetAll.mockResolvedValue([]);
    const r = await rescheduleTripBoundAlarm({
      stationName: '회차역',
      newArrivalMs: NOW_MS + 600_000,
      route: loopRoute,
      destinationName,
      now: NOW_MS,
      occurrenceIdx: 5, // 5번째 등장은 없음
    });
    expect(r).toEqual({ cancelled: 0, scheduled: 0 });
    expect(mockedSchedule).not.toHaveBeenCalled();
  });
});

// #1193 — topUpTripBoundWindow의 활성 윈도우 판정이 stationName 단위가 아닌
// `${stationName}:${occurrenceIdx}` 단위로 동작해야 같은 역의 다른 occurrence를 혼동하지 않는다.
describe('topUpTripBoundWindow 중복역 occurrence 격리 (#1193)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSchedule.mockResolvedValue('id');
    jest.replaceProperty(Platform, 'OS', 'ios');
  });

  it('passed 이후 같은 역의 다음 occurrence가 윈도우 안이면, 이전 occurrence(:0)는 cancel되고 :1은 보존', async () => {
    // routeStops = [A:0, B, A:1, C] (A가 두 번 등장).
    const routeStops: TripBoundStop[] = [
      { stationName: 'A', alarmType: 'transfer' },
      { stationName: 'B', alarmType: 'transfer' },
      { stationName: 'A', alarmType: 'transfer' },
      { stationName: 'C', alarmType: 'destination' },
    ];
    const hops = [60_000, 60_000, 60_000, 60_000];

    mockedGetAll.mockResolvedValue([
      { identifier: 'tba:early:A' }, // A의 첫 occurrence(이미 통과한 stop) — cancel 대상.
      { identifier: 'tba:imminent:A' },
      { identifier: 'tba:early:A:1' }, // 윈도우 안 — 보존.
      { identifier: 'tba:imminent:A:1' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    const r = await topUpTripBoundWindow({
      routeStops,
      estimatedHopTimesMs: hops,
      startTime: NOW,
      passedStationName: 'B', // window starts at index 2 → [A:1, C]
      windowSize: 2,
    });
    expect(mockedCancel).toHaveBeenCalledWith('tba:early:A');
    expect(mockedCancel).toHaveBeenCalledWith('tba:imminent:A');
    expect(mockedCancel).not.toHaveBeenCalledWith('tba:early:A:1');
    expect(mockedCancel).not.toHaveBeenCalledWith('tba:imminent:A:1');
    expect(r.cancelled).toBe(2);
  });
});
