/**
 * #2160 (follow-up of #2151) — `handler.scheduled`가 매 tick의 `scheduledStats` boardingPrompt
 * 계열 delta를 누적 KV 키(`boardingPromptCounterAccumulator`)에 read-modify-write하는지,
 * idle tick(delta 전부 0)에서 KV write가 발생하지 않는지 검증.
 *
 * `runScheduled`를 모킹해 index.ts의 배선(wiring)만 단위 격리 테스트한다 — 누적 로직 자체는
 * boardingPromptCounterAccumulator.test.ts가 커버한다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';
import {
  BOARDING_PROMPT_COUNTER_KEY,
  readBoardingPromptCounters,
} from '../boardingPromptCounterAccumulator';

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
    // TELEMETRY_R2 미설정 — obs-metrics hourly 집계 블록은 no-op, 누적 write는 독립적으로 발생해야 함.
  };
}

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

function boardingPromptStats(
  overrides: Partial<{
    boardingPromptEvaluated: number;
    boardingPromptFired: number;
    boardingPromptBlocked: number;
    boardingPromptSkippedNoContext: number;
    boardingPromptSkippedStale: number;
    boardingPromptSkippedTooFar: number;
    boardingPromptSkippedEmpty: number;
    boardingPromptSkippedTrainDuplicate: number;
  }> = {},
) {
  return {
    scanned: 0,
    pendingActivityPossible: false,
    boardingPromptEvaluated: 0,
    boardingPromptFired: 0,
    boardingPromptBlocked: 0,
    boardingPromptSkippedNoContext: 0,
    boardingPromptSkippedStale: 0,
    boardingPromptSkippedTooFar: 0,
    boardingPromptSkippedEmpty: 0,
    boardingPromptSkippedTrainDuplicate: 0,
    ...overrides,
  };
}

describe('handler.scheduled — #2160 boardingPrompt counter 누적 배선', () => {
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

  it('idle tick(모든 boardingPrompt 계열 stat 0) — 누적 KV 키 write 없음', async () => {
    const kv = new InMemoryKV();
    runScheduledMock.mockResolvedValue(boardingPromptStats());
    await handler.scheduled(makeScheduledController(), makeEnv(kv), makeExecutionContext());
    expect(kv.store.has(BOARDING_PROMPT_COUNTER_KEY)).toBe(false);
  });

  it('활성 tick(evaluated/fired > 0) — 누적 KV 키에 write', async () => {
    const kv = new InMemoryKV();
    runScheduledMock.mockResolvedValue(
      boardingPromptStats({ boardingPromptEvaluated: 1, boardingPromptFired: 1 }),
    );
    await handler.scheduled(makeScheduledController(), makeEnv(kv), makeExecutionContext());
    const stored = await readBoardingPromptCounters(kv as unknown as KVNamespace);
    expect(stored).not.toBeNull();
    expect(stored?.evaluated).toBe(1);
    expect(stored?.fired).toBe(1);
  });

  // #2350 — skippedEmpty(RC-13, candidateTrains 0건)가 evaluated/fired/blocked 등 기존 필드에는
  // 없어 KV counter로 노출되지 않던 관측 사각. 다른 skip 필드와 동일하게 배선돼야 한다.
  it('#2350 — skippedEmpty>0인 tick도 활성 tick으로 누적 KV 키에 write', async () => {
    const kv = new InMemoryKV();
    runScheduledMock.mockResolvedValue(
      boardingPromptStats({ boardingPromptEvaluated: 1, boardingPromptSkippedEmpty: 1 }),
    );
    await handler.scheduled(makeScheduledController(), makeEnv(kv), makeExecutionContext());
    const stored = await readBoardingPromptCounters(kv as unknown as KVNamespace);
    expect(stored?.skippedEmpty).toBe(1);
  });

  it('연속 활성 tick 2회 — 누적(스냅샷 덮어쓰기 아님)', async () => {
    const kv = new InMemoryKV();
    runScheduledMock.mockResolvedValue(
      boardingPromptStats({ boardingPromptEvaluated: 2, boardingPromptBlocked: 1 }),
    );
    await handler.scheduled(makeScheduledController(), makeEnv(kv), makeExecutionContext());
    runScheduledMock.mockResolvedValue(
      boardingPromptStats({ boardingPromptEvaluated: 3, boardingPromptFired: 1 }),
    );
    await handler.scheduled(makeScheduledController(), makeEnv(kv), makeExecutionContext());
    const stored = await readBoardingPromptCounters(kv as unknown as KVNamespace);
    expect(stored?.evaluated).toBe(5);
    expect(stored?.blocked).toBe(1);
    expect(stored?.fired).toBe(1);
  });

  it('runScheduled 결과가 boardingPrompt 필드를 포함하지 않아도(구 mock 호환) throw 없이 완주', async () => {
    const kv = new InMemoryKV();
    runScheduledMock.mockResolvedValue({ scanned: 0, pendingActivityPossible: false });
    await expect(
      handler.scheduled(makeScheduledController(), makeEnv(kv), makeExecutionContext()),
    ).resolves.not.toThrow();
    expect(kv.store.has(BOARDING_PROMPT_COUNTER_KEY)).toBe(false);
  });
});
