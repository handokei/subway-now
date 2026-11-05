/**
 * #2615 (재설계, 코드리뷰 10건 판정 — denylist runScheduled 재진입 → allowlist in-memory
 * 연속) — `handler.scheduled`가 1차 `runScheduled`가 반환한 스냅샷(`stats.midCycleSnapshot`)을
 * `polled>0` 게이트로 t+30 `runMidCycleFireOnly`(fire-only, KV/SSoT 상태 변형 0)로 넘기는지,
 * F5(드리프트 보정)/F7(파생 가드 상수) 동작을 검증.
 *
 * `runScheduled`/`runMidCycleFireOnly` 둘 다 모킹해 wiring만 단위 격리 테스트한다 —
 * `runMidCycleFireOnly` 자체 fire-only 로직은 `scheduled.midCycleFireOnly.test.ts`가 커버.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import type { MidCycleTripSnapshot } from '../scheduled';
import { InMemoryKV } from './inMemoryKv';
import {
  MID_CYCLE_MIN_REMAINING_MS,
  MID_CYCLE_OFFSET_MS,
  MID_CYCLE_START_GUARD_MS,
} from '../cronConstants';

const runScheduledMock = vi.fn();
const runMidCycleFireOnlyMock = vi.fn();

vi.mock('../scheduled', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scheduled')>();
  return {
    ...actual,
    runScheduled: (...args: unknown[]) => runScheduledMock(...args),
    runMidCycleFireOnly: (...args: unknown[]) => runMidCycleFireOnlyMock(...args),
  };
});

const { handler, isMidCycleStartGuarded } = await import('../index');

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as Env['TRIPS'],
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  };
}

function makeExecutionContext(): ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> } {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

function makeScheduledController(): ScheduledController {
  return {
    scheduledTime: Date.now(),
    cron: '*/1 * * * *',
    noRetry: () => {},
  } as unknown as ScheduledController;
}

const DUMMY_SNAPSHOT: MidCycleTripSnapshot[] = [
  {
    trip: { token: 'dummy' } as MidCycleTripSnapshot['trip'],
    waypoint: { stationName: '중곡', line: '7', kind: 'intermediate' },
    lock: {
      trainCode: '7246',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: 0,
      segmentStations: ['중곡'],
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  },
];

function baseScheduledStats(
  overrides: Partial<{ polled: number; midCycleSnapshot: MidCycleTripSnapshot[]; pendingActivityPossible: boolean }> = {},
) {
  return {
    scanned: 0,
    polled: 0,
    midCycleSnapshot: [],
    pendingActivityPossible: false,
    ...overrides,
  };
}

describe('#2615 — 순수 함수 isMidCycleStartGuarded (t+50 가드, F7 파생 상수)', () => {
  it(`elapsedMs < ${MID_CYCLE_START_GUARD_MS} — guard 미발동(false)`, () => {
    expect(isMidCycleStartGuarded(0)).toBe(false);
    expect(isMidCycleStartGuarded(MID_CYCLE_OFFSET_MS)).toBe(false);
    expect(isMidCycleStartGuarded(MID_CYCLE_START_GUARD_MS - 1)).toBe(false);
  });

  it(`elapsedMs >= ${MID_CYCLE_START_GUARD_MS} — guard 발동(true)`, () => {
    expect(isMidCycleStartGuarded(MID_CYCLE_START_GUARD_MS)).toBe(true);
    expect(isMidCycleStartGuarded(MID_CYCLE_START_GUARD_MS + 1)).toBe(true);
    expect(isMidCycleStartGuarded(60_000)).toBe(true);
  });
});

describe('handler.scheduled — #2615 midCycle pass 스케줄링 (allowlist 재설계)', () => {
  beforeEach(() => {
    runScheduledMock.mockReset();
    runMidCycleFireOnlyMock.mockReset();
    runMidCycleFireOnlyMock.mockResolvedValue({ evaluated: 0, fired: 0, errors: 0 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1차 pass polled=0 (lock-active 없음) — mid pass용 runMidCycleFireOnly 호출 없음', async () => {
    runScheduledMock.mockResolvedValue(baseScheduledStats({ polled: 0 }));
    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();

    await handler.scheduled(makeScheduledController(), makeEnv(kv), ctx);
    await vi.advanceTimersByTimeAsync(MID_CYCLE_OFFSET_MS + 1_000);

    expect(runMidCycleFireOnlyMock).not.toHaveBeenCalled();
  });

  it('1차 pass polled>0인데 스냅샷 empty(전부 advance됨) — mid pass 호출 없음', async () => {
    runScheduledMock.mockResolvedValue(baseScheduledStats({ polled: 1, midCycleSnapshot: [] }));
    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();

    await handler.scheduled(makeScheduledController(), makeEnv(kv), ctx);
    await vi.advanceTimersByTimeAsync(MID_CYCLE_OFFSET_MS + 1_000);

    expect(runMidCycleFireOnlyMock).not.toHaveBeenCalled();
  });

  it('1차 pass polled>0 + 스냅샷 non-empty — t+30ms 뒤 runMidCycleFireOnly를 그 스냅샷으로 호출한다', async () => {
    runScheduledMock.mockResolvedValue(
      baseScheduledStats({ polled: 1, midCycleSnapshot: DUMMY_SNAPSHOT }),
    );
    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();

    await handler.scheduled(makeScheduledController(), makeEnv(kv), ctx);
    expect(runMidCycleFireOnlyMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MID_CYCLE_OFFSET_MS + 1_000);

    expect(runMidCycleFireOnlyMock).toHaveBeenCalledTimes(1);
    const [, snapshotArg] = runMidCycleFireOnlyMock.mock.calls[0] as [unknown, MidCycleTripSnapshot[]];
    expect(snapshotArg).toBe(DUMMY_SNAPSHOT);
  });

  it('F5 — 1차 pass 처리에 걸린 시간만큼 대기를 보정해 t+30 anchor에 착지한다', async () => {
    runScheduledMock.mockImplementation(async () => {
      // 1차 pass 자체가 처리에 5s 걸렸다고 시뮬레이션.
      vi.advanceTimersByTime(5_000);
      return baseScheduledStats({ polled: 1, midCycleSnapshot: DUMMY_SNAPSHOT });
    });
    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();

    await handler.scheduled(makeScheduledController(), makeEnv(kv), ctx);

    // 보정 없이 고정 30s를 또 기다리면 t+35에 도달해야 정상이지만, 보정 시 25s만 더
    // 기다리면 t+30(전체 경과 30s)에 도달한다 — 24.9s 시점엔 아직 실행되지 않아야 한다.
    await vi.advanceTimersByTimeAsync(MID_CYCLE_OFFSET_MS - 5_000 - 100);
    expect(runMidCycleFireOnlyMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(runMidCycleFireOnlyMock).toHaveBeenCalledTimes(1);
  });

  it(`F5 — 보정 후 남은 시간이 ${MID_CYCLE_MIN_REMAINING_MS}ms 미만이면 스케줄 자체를 skip한다`, async () => {
    runScheduledMock.mockImplementation(async () => {
      // 1차 pass 처리 자체가 t+25초까지 걸려 남은 시간이 5s(<10s)뿐인 상황.
      vi.advanceTimersByTime(MID_CYCLE_OFFSET_MS - MID_CYCLE_MIN_REMAINING_MS + 5_000);
      return baseScheduledStats({ polled: 1, midCycleSnapshot: DUMMY_SNAPSHOT });
    });
    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();

    await handler.scheduled(makeScheduledController(), makeEnv(kv), ctx);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runMidCycleFireOnlyMock).not.toHaveBeenCalled();
  });

  it('t+50 초과 시작(worker 지연 시뮬레이션) — 2차 pass를 skip한다', async () => {
    runScheduledMock.mockResolvedValue(
      baseScheduledStats({ polled: 1, midCycleSnapshot: DUMMY_SNAPSHOT }),
    );
    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();
    const startTime = Date.now();

    await handler.scheduled(makeScheduledController(), makeEnv(kv), ctx);
    // waitUntil 콜백 실행 자체가 극단적으로 지연된 상황(예: 이벤트 루프 정체)을 시뮬레이션 —
    // F5 보정이 계산한 대기가 끝나기 전에 시스템 시계를 guard 임계 너머로 강제 이동.
    vi.setSystemTime(startTime + 55_000);
    await vi.advanceTimersByTimeAsync(MID_CYCLE_OFFSET_MS + 1_000);

    expect(runMidCycleFireOnlyMock).not.toHaveBeenCalled();
  });
});
