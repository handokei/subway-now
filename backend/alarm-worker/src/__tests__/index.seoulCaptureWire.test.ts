/**
 * #2579 (Epic #2239 P0-a) — `handler.scheduled`가 seoulCapture recorder를
 * `SeoulArrivalClient`에 fetchImpl로 주입하고, cycle 종료 시 R2로 flush하는지 검증.
 *
 * `runScheduled`를 모킹해 deps.seoul을 통해 실제 fetch를 발생시키고, `flushSeoulCapture`를
 * 모킹해 호출 여부/인자만 관찰한다. recorder/flush 자체 로직은 seoulCapture.test.ts가 커버.
 *
 * 참고: index.scheduledGate.test.ts 주석대로 Sentry.withSentry HOC가 named export
 * `handler`도 같은 객체 참조로 mutate해 instrumentation이 자체적으로 ctx.waitUntil을
 * 호출할 수 있다 — 그래서 `ctx.waitUntil` 호출 횟수 대신 `flushSeoulCapture` mock 호출
 * 여부로 wiring을 검증한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';
import type { SeoulArrivalClient } from '../seoul';

const runScheduledMock = vi.fn();
const flushSeoulCaptureMock = vi.fn();

vi.mock('../scheduled', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scheduled')>();
  return { ...actual, runScheduled: (...args: unknown[]) => runScheduledMock(...args) };
});
vi.mock('../seoulCapture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../seoulCapture')>();
  return { ...actual, flushSeoulCapture: (...args: unknown[]) => flushSeoulCaptureMock(...args) };
});

const { handler } = await import('../index');
const { buildSeoulCaptureKey } = await import('../seoulCapture');

function makeEnv(kv: InMemoryKV, r2?: R2Bucket): Env {
  return {
    TRIPS: kv as unknown as Env['TRIPS'],
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'test-key',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
    ...(r2 ? { TELEMETRY_R2: r2 } : {}),
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

/** runScheduled mock 구현이 deps.seoul.fetchArrivals를 호출해 recorder에 entry를 남기게 한다. */
function triggerSeoulFetch(stats: ReturnType<typeof baseScheduledStats>) {
  return async (_env: Env, deps: { seoul: SeoulArrivalClient }) => {
    await deps.seoul.fetchArrivals('교대');
    return stats;
  };
}

/** waitUntil로 넘겨진 프로미스를 전부 기다린다 (Sentry HOC의 자체 waitUntil 포함, 무해). */
async function drainWaitUntil(ctx: ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> }) {
  await Promise.all(ctx.waitUntil.mock.calls.map((call) => (call[0] as Promise<unknown>).catch(() => {})));
}

describe('handler.scheduled — #2579 seoul-capture R2 flush wiring', () => {
  beforeEach(() => {
    runScheduledMock.mockReset();
    flushSeoulCaptureMock.mockReset();
    flushSeoulCaptureMock.mockResolvedValue(undefined);
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"realtimeArrivalList":[]}')));
  });

  it('scanned=0 (idle cycle) — flushSeoulCapture를 호출하지 않는다', async () => {
    const r2 = {} as R2Bucket;
    runScheduledMock.mockImplementation(triggerSeoulFetch(baseScheduledStats({ scanned: 0 })));

    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();
    await handler.scheduled(makeScheduledController(), makeEnv(kv, r2), ctx);
    await drainWaitUntil(ctx);

    expect(flushSeoulCaptureMock).not.toHaveBeenCalled();
  });

  it('scanned>0 + entries>0 — flushSeoulCapture를 1회 호출한다 (key 포맷/시크릿 마스킹 확인)', async () => {
    const r2 = {} as R2Bucket;
    runScheduledMock.mockImplementation(triggerSeoulFetch(baseScheduledStats({ scanned: 1 })));

    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();
    await handler.scheduled(makeScheduledController(), makeEnv(kv, r2), ctx);
    await drainWaitUntil(ctx);

    expect(flushSeoulCaptureMock).toHaveBeenCalledTimes(1);
    const [calledR2, cycle] = flushSeoulCaptureMock.mock.calls[0];
    expect(calledR2).toBe(r2);
    expect(cycle.scanned).toBe(1);
    expect(cycle.entries).toHaveLength(1);
    expect(cycle.entries[0].url).not.toContain('test-key');
    expect(buildSeoulCaptureKey(cycle.cycleStartMs)).toMatch(/^seoul-capture\/\d{4}-\d{2}-\d{2}\/\d+\.json$/);
  });

  it('TELEMETRY_R2 미바인딩 — flushSeoulCapture를 호출하지 않는다 (완전 no-op)', async () => {
    runScheduledMock.mockImplementation(triggerSeoulFetch(baseScheduledStats({ scanned: 1 })));

    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();
    await handler.scheduled(makeScheduledController(), makeEnv(kv), ctx);
    await drainWaitUntil(ctx);

    expect(flushSeoulCaptureMock).not.toHaveBeenCalled();
  });

  it('flush 실패해도 handler.scheduled는 정상 resolve (cron 본 흐름 무영향)', async () => {
    const r2 = {} as R2Bucket;
    flushSeoulCaptureMock.mockRejectedValue(new Error('r2 down'));
    runScheduledMock.mockImplementation(triggerSeoulFetch(baseScheduledStats({ scanned: 1 })));

    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();
    await expect(handler.scheduled(makeScheduledController(), makeEnv(kv, r2), ctx)).resolves.toBeUndefined();
    await drainWaitUntil(ctx);

    expect(flushSeoulCaptureMock).toHaveBeenCalledTimes(1);
  });

  // #2579 리뷰(item 1) — runScheduled throw 시 그 cycle의 recorder.entries(RCA에 가장
  // 필요한 실패 cycle)가 flush 없이 통째로 버려지던 결함 회귀 테스트.
  it('runScheduled가 throw해도 그 cycle의 entries를 flush한다 (scanned 게이트 미적용) + rethrow 유지', async () => {
    const r2 = {} as R2Bucket;
    const boom = new Error('runScheduled boom');
    runScheduledMock.mockImplementation(async (_env: Env, deps: { seoul: SeoulArrivalClient }) => {
      await deps.seoul.fetchArrivals('교대');
      throw boom;
    });

    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();
    await expect(handler.scheduled(makeScheduledController(), makeEnv(kv, r2), ctx)).rejects.toThrow(
      'runScheduled boom',
    );
    await drainWaitUntil(ctx);

    expect(flushSeoulCaptureMock).toHaveBeenCalledTimes(1);
    const [, cycle] = flushSeoulCaptureMock.mock.calls[0];
    expect(cycle.entries).toHaveLength(1);
    // scanned를 구하지 못한 throw 경로 — -1 sentinel로 "cycle 실패" 표시(0=idle과 구분).
    expect(cycle.scanned).toBe(-1);
  });

  it('runScheduled가 throw했지만 entries가 0건이면 flush하지 않는다', async () => {
    const r2 = {} as R2Bucket;
    runScheduledMock.mockRejectedValue(new Error('boom before any fetch'));

    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();
    await expect(handler.scheduled(makeScheduledController(), makeEnv(kv, r2), ctx)).rejects.toThrow(
      'boom before any fetch',
    );
    await drainWaitUntil(ctx);

    expect(flushSeoulCaptureMock).not.toHaveBeenCalled();
  });

  // #2579 리뷰(item 5) — active cycle(scanned>0)인데 캡처 0건이면 캡처 자체가 죽은 blackout
  // 신호이므로 flush 없이도 관측 가능하도록 로그 1줄을 남긴다.
  it('scanned>0 인데 entries=0(캡처 blackout)이면 flush 없이 관측 로그를 남긴다', async () => {
    const r2 = {} as R2Bucket;
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runScheduledMock.mockImplementation(async () => baseScheduledStats({ scanned: 1 }));

    const kv = new InMemoryKV();
    const ctx = makeExecutionContext();
    await handler.scheduled(makeScheduledController(), makeEnv(kv, r2), ctx);
    await drainWaitUntil(ctx);

    expect(flushSeoulCaptureMock).not.toHaveBeenCalled();
    const loggedEmptyMsg = consoleLogSpy.mock.calls.some((call) =>
      String(call[0]).includes('seoul-capture empty on active cycle'),
    );
    expect(loggedEmptyMsg).toBe(true);
    consoleLogSpy.mockRestore();
  });
});
