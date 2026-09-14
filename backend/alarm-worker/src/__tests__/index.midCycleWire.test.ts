/**
 * #2615 (서비스체인① 1단계, cycle 내 +30초 재폴링·재발사 pass) — `handler.scheduled`가
 * 1차 `runScheduled` 완료 후 `scanned>0`일 때만 `ctx.waitUntil`로 t+30 경량 2차
 * (`midCycle: true`) pass를 스케줄하는지, 그리고 t+50 초과 시작 가드가 동작하는지 검증.
 *
 * `runScheduled`를 모킹해 wiring만 단위 격리 테스트한다 — 2차 pass 내부의 스코프 축소
 * (self-poll/telemetry/prompt skip 등) 자체 로직은 `scheduled.midCycle.test.ts`가 커버.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { MID_CYCLE_OFFSET_MS, MID_CYCLE_START_GUARD_MS } from '../cronConstants';

const runScheduledMock = vi.fn();

vi.mock('../scheduled', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scheduled')>();
  return { ...actual, runScheduled: (...args: unknown[]) => runScheduledMock(...args) };
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

function baseScheduledStats(overrides: Partial<{ scanned: number; pendingActivityPossible: boolean }> = {}) {
  return { scanned: 0, pendingActivityPossible: false, ...overrides };
}

describe('#2615 — 순수 함수 isMidCycleStartGuarded (t+50 가드)', () => {
  it(`elapsedMs <= ${MID_CYCLE_START_GUARD_MS} — guard 미발동(false)`, () => {
    expect(isMidCycleStartGuarded(0)).toBe(false);
    expect(isMidCycleStartGuarded(MID_CYCLE_OFFSET_MS)).toBe(false);
    expect(isMidCycleStartGuarded(MID_CYCLE_START_GUARD_MS)).toBe(false);
  });

  it(`elapsedMs > ${MID_CYCLE_START_GUARD_MS} — guard 발동(true)`, () => {
    expect(isMidCycleStartGuarded(MID_CYCLE_START_GUARD_MS + 1)).toBe(true);
    expect(isMidCycleStartGuarded(60_000)).toBe(true);
  });
});

describe('handler.scheduled — #2615 midCycle pass 스케줄링', () => {
  beforeEach(() => {
    runScheduledMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1차 pass scanned=0 (idle cycle) — midCycle pass용 runScheduled 2차 호출 없음', async () => {
    runScheduledMock.mockResolvedValue(baseScheduledStats({ scanned: 0 }));
    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();

    await handler.scheduled(makeScheduledController(), makeEnv(kv), ctx);
    await vi.advanceTimersByTimeAsync(MID_CYCLE_OFFSET_MS + 1_000);

    expect(runScheduledMock).toHaveBeenCalledTimes(1);
  });

  it('1차 pass scanned>0 — t+30ms 뒤 runScheduled를 midCycle:true로 2차 호출한다', async () => {
    runScheduledMock.mockResolvedValue(baseScheduledStats({ scanned: 1 }));
    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();

    await handler.scheduled(makeScheduledController(), makeEnv(kv), ctx);
    expect(runScheduledMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MID_CYCLE_OFFSET_MS + 1_000);

    expect(runScheduledMock).toHaveBeenCalledTimes(2);
    const [, midDeps] = runScheduledMock.mock.calls[1] as [unknown, { midCycle?: boolean }];
    expect(midDeps.midCycle).toBe(true);
  });

  it('t+50 초과 시작(worker 지연 시뮬레이션) — 2차 pass를 skip한다', async () => {
    runScheduledMock.mockResolvedValue(baseScheduledStats({ scanned: 1 }));
    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();
    const startTime = Date.now();

    await handler.scheduled(makeScheduledController(), makeEnv(kv), ctx);
    // worker가 밀려 실제 시작 시각이 cycle 시작 기준 55s 지난 상황을 시뮬레이션.
    vi.setSystemTime(startTime + 55_000);
    await vi.advanceTimersByTimeAsync(MID_CYCLE_OFFSET_MS + 1_000);

    expect(runScheduledMock).toHaveBeenCalledTimes(1);
  });
});
