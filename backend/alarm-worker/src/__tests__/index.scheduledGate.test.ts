/**
 * #2073 (Issue A) — `handler.scheduled`가 `runScheduled`의 `pendingActivityPossible` stat으로
 * `runFallbackPushes`/`runRetryPushes` 호출 여부를 게이트하는지 검증.
 *
 * `runScheduled`/`runFallbackPushes`/`runRetryPushes`를 모킹해 index.ts의 게이트 배선(wiring)만
 * 단위 격리 테스트한다 — 각 함수 내부 로직은 scheduled.test.ts / fallback.test.ts /
 * retryPushes.test.ts가 이미 커버한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { readPushActivityRecent } from '../cronIdleGate';

const runScheduledMock = vi.fn();
const runFallbackPushesMock = vi.fn();
const runRetryPushesMock = vi.fn();

vi.mock('../scheduled', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scheduled')>();
  return { ...actual, runScheduled: (...args: unknown[]) => runScheduledMock(...args) };
});
vi.mock('../fallback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fallback')>();
  return { ...actual, runFallbackPushes: (...args: unknown[]) => runFallbackPushesMock(...args) };
});
vi.mock('../retryPushes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../retryPushes')>();
  return { ...actual, runRetryPushes: (...args: unknown[]) => runRetryPushesMock(...args) };
});

// 모듈 모킹 이후 동적 import — vi.mock hoisting과의 순서 보장.
const { handler } = await import('../index');

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

function baseScheduledStats(overrides: Partial<{ pendingActivityPossible: boolean }> = {}) {
  return {
    scanned: 0,
    pendingActivityPossible: true,
    ...overrides,
  };
}

// #2073 — Sentry.withSentry HOC가 default export와 named export `handler`를 같은 객체 참조로
// mutate하므로, 여기서도 real ExecutionContext/ScheduledController 형태의 최소 stub이 필요하다
// (empty object는 Sentry instrumentation 내부에서 throw).
function makeExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

function makeScheduledController(): ScheduledController {
  return {
    scheduledTime: Date.now(),
    cron: '*/1 * * * *',
    noRetry: () => {},
  } as unknown as ScheduledController;
}

describe('handler.scheduled — #2073 idle-skip 게이트', () => {
  beforeEach(() => {
    runScheduledMock.mockReset();
    runFallbackPushesMock.mockReset();
    runRetryPushesMock.mockReset();
    runFallbackPushesMock.mockResolvedValue({ scanned: 0, pushed: 0, errors: 0, deferred: 0 });
    runRetryPushesMock.mockResolvedValue({
      scanned: 0,
      deferred: 0,
      resent: 0,
      rescheduled: 0,
      exhausted: 0,
    });
  });

  it('pendingActivityPossible=false — runFallbackPushes/runRetryPushes를 호출하지 않는다', async () => {
    const kv = new InMemoryKV();
    runScheduledMock.mockResolvedValue(baseScheduledStats({ pendingActivityPossible: false }));
    await handler.scheduled(makeScheduledController(), makeEnv(kv), makeExecutionContext());
    expect(runScheduledMock).toHaveBeenCalledTimes(1);
    expect(runFallbackPushesMock).not.toHaveBeenCalled();
    expect(runRetryPushesMock).not.toHaveBeenCalled();
  });

  it('pendingActivityPossible=true — runFallbackPushes/runRetryPushes를 호출한다', async () => {
    const kv = new InMemoryKV();
    runScheduledMock.mockResolvedValue(baseScheduledStats({ pendingActivityPossible: true }));
    await handler.scheduled(makeScheduledController(), makeEnv(kv), makeExecutionContext());
    expect(runFallbackPushesMock).toHaveBeenCalledTimes(1);
    expect(runRetryPushesMock).toHaveBeenCalledTimes(1);
  });

  it('pendingActivityPossible=true + fallback/retry가 entry를 발견 — activity marker를 재stamp한다', async () => {
    const kv = new InMemoryKV();
    runScheduledMock.mockResolvedValue(baseScheduledStats({ pendingActivityPossible: true }));
    runFallbackPushesMock.mockResolvedValue({ scanned: 1, pushed: 1, errors: 0, deferred: 0 });
    await handler.scheduled(makeScheduledController(), makeEnv(kv), makeExecutionContext());
    expect(await readPushActivityRecent(kv as unknown as KVNamespace)).toBe(true);
  });

  it('pendingActivityPossible=true + fallback/retry 모두 empty — marker를 재stamp하지 않는다', async () => {
    const kv = new InMemoryKV();
    runScheduledMock.mockResolvedValue(baseScheduledStats({ pendingActivityPossible: true }));
    // runFallbackPushes/runRetryPushes 기본 mock 모두 scanned:0.
    await handler.scheduled(makeScheduledController(), makeEnv(kv), makeExecutionContext());
    expect(await readPushActivityRecent(kv as unknown as KVNamespace)).toBe(false);
  });
});
