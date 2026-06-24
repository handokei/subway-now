/**
 * #1758 — 60s cron jitter 흡수 unit test (#1538 Sub 3 핵심).
 *
 * 핵심 주장: prescheduleStationAlerts / scheduleHopsForLock가 OS local notification을
 * **절대 시각(epoch ms)**으로 사전 등록하므로, backend cron이 60s 주기에서 벗어나거나
 * cycle을 전혀 보내지 않아도 알람 발사 시각은 영향받지 않는다.
 *
 * 시나리오:
 *   S1 — cron 60s 정상 cycle: pre-scheduled 정시 발사 OK (baseline)
 *   S2 — cron 90s delay (1.5x): pre-scheduled 발사 무관 (jitter 흡수)
 *   S3 — cron 120s+ skip 2 cycle: pre-scheduled 발사 무관 (multi-skip 흡수)
 *   S4 — cron 비정상 종료 (5+ cycle 누락): pre-scheduled가 backup으로 동작
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  TRIP_BOUND_ALARM_PREFIX,
  prescheduleStationAlerts,
  type TripBoundStop,
} from '../tripBoundScheduler';

jest.mock('expo-notifications');

// motion gate: 기본 false(움직이는 상태) → schedule 진행
const mockGetCurrentMotionStationary = jest.fn<boolean, []>(() => false);
jest.mock('../../../nearest-station/utils/motionActivity', () => ({
  getCurrentMotionStationary: () => mockGetCurrentMotionStationary(),
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
  buildAlarmContent: (event: { phaseId: string; stationName: string }) => ({
    title: `T:${event.phaseId}`,
    body: `B:${event.stationName}`,
  }),
}));

jest.mock('../prescheduledMetrics', () => ({
  recordScheduledAlarm: jest.fn().mockResolvedValue(undefined),
}));

const mockedSchedule = Notifications.scheduleNotificationAsync as jest.MockedFunction<
  typeof Notifications.scheduleNotificationAsync
>;

/**
 * trip: 강남(transfer, 2분) → 교대(transfer, 2분) → 서울역(destination, 2분)
 * startTime 기준 누적 도착 시각:
 *   강남: startTime + 120_000
 *   교대: startTime + 240_000
 *   서울역: startTime + 360_000
 */
const STOPS: TripBoundStop[] = [
  { stationName: '강남', alarmType: 'transfer' },
  { stationName: '교대', alarmType: 'transfer' },
  { stationName: '서울역', alarmType: 'destination' },
];
const HOP_MS = 120_000; // 2분
const HOPS = [HOP_MS, HOP_MS, HOP_MS];

/** 발사될 것으로 기대되는 알람의 절대 시각 집합(ms) */
function expectedFireTimes(startTime: number): number[] {
  // ALARM_PHASES: early(lead=hopMs), imminent(lead=10_000ms)
  // stop0(강남) arrival=startTime+120_000: early fire=startTime(=skip), imminent fire=startTime+110_000
  // stop1(교대) arrival=startTime+240_000: early fire=startTime+120_000, imminent=startTime+230_000
  // stop2(서울역) arrival=startTime+360_000: early=startTime+240_000, imminent=startTime+350_000
  return [
    startTime + 110_000,  // 강남 imminent
    startTime + 120_000,  // 교대 early
    startTime + 230_000,  // 교대 imminent
    startTime + 240_000,  // 서울역 early
    startTime + 350_000,  // 서울역 imminent
  ];
}

/** scheduleNotificationAsync 호출에서 date(ms) 배열 추출 */
function capturedFireTimes(): number[] {
  return mockedSchedule.mock.calls.map((call) => {
    const trigger = call[0].trigger as { date: Date };
    return trigger.date.getTime();
  });
}

/** cron silent push 도달 시뮬레이션 — pre-scheduled와 관계 없이 외부 신호 */
function simulateCronSilentPush(_delayMs: number): void {
  // cron이 push를 보내든 안 보내든 pre-scheduled OS 알람 발사 시각은 동일하다.
  // 이 함수는 테스트 의도를 명시하기 위한 no-op placeholder다.
}

const START_TIME = new Date('2026-06-24T09:00:00Z').getTime();

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCurrentMotionStationary.mockReturnValue(false);
  jest.replaceProperty(Platform, 'OS', 'ios');
  jest.useFakeTimers().setSystemTime(START_TIME);
  mockedSchedule.mockResolvedValue('id');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('cron jitter 흡수 — pre-scheduled 알람 발사 시각 불변성', () => {
  it('S1: cron 60s 정상 cycle — pre-scheduled 발사 시각 기준선', async () => {
    // trip 등록 시점에 OS 알람 사전 예약
    const result = await prescheduleStationAlerts({
      routeStops: STOPS,
      estimatedHopTimesMs: HOPS,
      startTime: START_TIME,
    });

    // cron이 60s 후 정상 도달 시뮬레이션 (pre-scheduled와 독립)
    simulateCronSilentPush(60_000);

    // pre-scheduled 알람은 이미 OS 큐에 절대 시각으로 등록됨
    expect(result).toHaveLength(5);
    expect(mockedSchedule).toHaveBeenCalledTimes(5);

    // 모든 발사 시각이 START_TIME 이후여야 함 (과거 시각 skip 정상 동작)
    const fireTimes = capturedFireTimes();
    const expected = expectedFireTimes(START_TIME);
    expect(fireTimes.sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
  });

  it('S2: cron 90s delay (1.5x jitter) — pre-scheduled 발사 시각 동일', async () => {
    const result = await prescheduleStationAlerts({
      routeStops: STOPS,
      estimatedHopTimesMs: HOPS,
      startTime: START_TIME,
    });

    // cron이 90s 지연 (jitter 1.5x) — pre-scheduled 시각에 영향 없음
    simulateCronSilentPush(90_000);
    jest.advanceTimersByTime(90_000);

    // 알람은 OS에 이미 절대 시각으로 등록되어 있음 — cron 지연과 무관
    expect(result).toHaveLength(5);
    const fireTimes = capturedFireTimes();
    const expected = expectedFireTimes(START_TIME);
    expect(fireTimes.sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
  });

  it('S3: cron 120s+ skip 2 cycle — pre-scheduled가 cover (2 cycle 누락 흡수)', async () => {
    const result = await prescheduleStationAlerts({
      routeStops: STOPS,
      estimatedHopTimesMs: HOPS,
      startTime: START_TIME,
    });

    // cron 2 cycle(240s) 완전 누락 — silent push 0건
    simulateCronSilentPush(0); // push 없음
    jest.advanceTimersByTime(240_000); // 4분 경과 (2 cycle × 120s)

    // pre-scheduled OS 알람은 여전히 절대 시각으로 OS 큐에 있음
    expect(result).toHaveLength(5);

    // 이미 지난 알람 발사 시각 확인 (240s window 안에 포함되는 알람)
    // 강남 imminent(110_000), 교대 early(120_000), 교대 imminent(230_000), 서울역 early(240_000) = 4건
    const fireTimes = capturedFireTimes();
    const inWindow = fireTimes.filter(
      (t) => t >= START_TIME && t <= START_TIME + 240_000,
    );
    expect(inWindow).toHaveLength(4);
  });

  it('S4: cron 5+ cycle 누락 — pre-scheduled가 trip 전체 backup으로 동작', async () => {
    const result = await prescheduleStationAlerts({
      routeStops: STOPS,
      estimatedHopTimesMs: HOPS,
      startTime: START_TIME,
    });

    // cron 완전 dead (5 cycle = 300s 동안 push 0건)
    jest.advanceTimersByTime(300_000); // 5분 경과

    // pre-scheduled 알람 전체(5건)가 OS 큐에 등록되어 있어야 함
    // cron 없이도 OS 로컬 알람으로 trip 전체 발사 보장
    expect(result).toHaveLength(5);
    expect(mockedSchedule).toHaveBeenCalledTimes(5);

    // 모든 알람 식별자가 tba: prefix를 가짐
    const identifiers = mockedSchedule.mock.calls.map((call) => call[0].identifier as string);
    expect(identifiers.every((id) => id.startsWith(TRIP_BOUND_ALARM_PREFIX))).toBe(true);

    // 발사 시각 전체가 startTime 이후임 확인
    const fireTimes = capturedFireTimes();
    expect(fireTimes.every((t) => t > START_TIME)).toBe(true);
  });

  it('발사 시각 불변성 — startTime이 동일하면 cron 상태와 무관하게 동일한 fire date 집합', async () => {
    // 1차 예약 (cron 정상 가정)
    await prescheduleStationAlerts({
      routeStops: STOPS,
      estimatedHopTimesMs: HOPS,
      startTime: START_TIME,
    });
    const firstRunTimes = capturedFireTimes();

    jest.clearAllMocks();
    mockedSchedule.mockResolvedValue('id');

    // 2차 예약 (cron 완전 dead 가정) — 같은 startTime이면 동일 fire 시각
    await prescheduleStationAlerts({
      routeStops: STOPS,
      estimatedHopTimesMs: HOPS,
      startTime: START_TIME,
    });
    const secondRunTimes = capturedFireTimes();

    expect(firstRunTimes.sort((a, b) => a - b)).toEqual(secondRunTimes.sort((a, b) => a - b));
  });

  it('windowSize 제한 시에도 예약된 알람은 cron jitter 무관 발사', async () => {
    // windowSize=2 — 처음 2 stop만 예약
    const result = await prescheduleStationAlerts({
      routeStops: STOPS,
      estimatedHopTimesMs: HOPS,
      startTime: START_TIME,
      windowSize: 2,
    });

    // cron 3 cycle 누락
    jest.advanceTimersByTime(180_000);

    // windowSize=2이므로 강남(1건 imminent) + 교대(early+imminent) = 3건
    expect(result).toHaveLength(3);

    // 예약된 모든 알람의 발사 시각이 startTime보다 미래
    const fireTimes = capturedFireTimes();
    expect(fireTimes.every((t) => t > START_TIME)).toBe(true);
  });
});
