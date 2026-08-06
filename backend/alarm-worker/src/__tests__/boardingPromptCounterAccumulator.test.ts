/**
 * boardingPromptCounterAccumulator.test.ts — #2160 (follow-up of #2151 / PR #2156 P2 리뷰).
 */
import { describe, expect, it } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import {
  BOARDING_PROMPT_COUNTER_KEY,
  EMPTY_BOARDING_PROMPT_COUNTERS,
  accumulateBoardingPromptCounters,
  readBoardingPromptCounters,
  type BoardingPromptCounterDelta,
} from '../boardingPromptCounterAccumulator';

const NOW = 1_700_000_000_000;

const ZERO_DELTA: BoardingPromptCounterDelta = {
  evaluated: 0,
  fired: 0,
  blocked: 0,
  skippedNoContext: 0,
  skippedStale: 0,
  skippedTooFar: 0,
  skippedTrainDuplicate: 0,
};

describe('readBoardingPromptCounters', () => {
  it('키 없음 → null', async () => {
    const kv = new InMemoryKV();
    const result = await readBoardingPromptCounters(kv as unknown as KVNamespace);
    expect(result).toBeNull();
  });

  it('malformed JSON → null', async () => {
    const kv = new InMemoryKV();
    kv.store.set(BOARDING_PROMPT_COUNTER_KEY, { value: '{not-json' });
    const result = await readBoardingPromptCounters(kv as unknown as KVNamespace);
    expect(result).toBeNull();
  });

  it('cacheTtl >= 30s로 KV read — 런타임 제약(cacheTtl<30 throw) 위반하지 않는다', async () => {
    // #2160 — lesson_cron_cachettl_runtime_constraint: Cloudflare KV는 cacheTtl<30을 400으로
    // throw한다. InMemoryKV가 동일하게 시뮬레이션 — 이 호출이 throw하지 않으면 cacheTtl>=30.
    const kv = new InMemoryKV();
    await expect(readBoardingPromptCounters(kv as unknown as KVNamespace)).resolves.not.toThrow();
  });
});

describe('accumulateBoardingPromptCounters — idle tick 0 write (#2160)', () => {
  it('delta 전부 0(lock 미형성 trip이 활성인 tick 없음 — idle tick 포함) → KV write 없음', async () => {
    const kv = new InMemoryKV();
    const result = await accumulateBoardingPromptCounters(kv as unknown as KVNamespace, ZERO_DELTA, NOW);
    expect(result).toBeNull();
    expect(kv.store.size).toBe(0);
  });

  it('idle tick 반복 호출해도 write 누적 0 (quota burn 재발 방지 시뮬레이션)', async () => {
    const kv = new InMemoryKV();
    for (let i = 0; i < 100; i++) {
      await accumulateBoardingPromptCounters(kv as unknown as KVNamespace, ZERO_DELTA, NOW + i * 60_000);
    }
    expect(kv.store.size).toBe(0);
  });
});

describe('accumulateBoardingPromptCounters — 활성 trip tick 누적', () => {
  it('첫 활성 tick — delta 그대로 저장 + self-describing window/sampledAt', async () => {
    const kv = new InMemoryKV();
    const result = await accumulateBoardingPromptCounters(
      kv as unknown as KVNamespace,
      { ...ZERO_DELTA, evaluated: 1, fired: 1 },
      NOW,
    );
    expect(result).toEqual({
      evaluated: 1,
      fired: 1,
      blocked: 0,
      skippedNoContext: 0,
      skippedStale: 0,
      skippedTooFar: 0,
      skippedTrainDuplicate: 0,
      window: '24h-rolling-ttl',
      sampledAt: NOW,
    });
    const stored = await readBoardingPromptCounters(kv as unknown as KVNamespace);
    expect(stored).toEqual(result);
  });

  it('여러 활성 tick — read-modify-write로 누적(1틱 스냅샷 아님)', async () => {
    const kv = new InMemoryKV();
    await accumulateBoardingPromptCounters(
      kv as unknown as KVNamespace,
      { ...ZERO_DELTA, evaluated: 3, blocked: 1 },
      NOW,
    );
    await accumulateBoardingPromptCounters(
      kv as unknown as KVNamespace,
      { ...ZERO_DELTA, evaluated: 2, fired: 1, skippedTrainDuplicate: 1 },
      NOW + 60_000,
    );
    const result = await readBoardingPromptCounters(kv as unknown as KVNamespace);
    expect(result).toEqual({
      evaluated: 5,
      fired: 1,
      blocked: 1,
      skippedNoContext: 0,
      skippedStale: 0,
      skippedTooFar: 0,
      skippedTrainDuplicate: 1,
      window: '24h-rolling-ttl',
      sampledAt: NOW + 60_000,
    });
  });

  it('idle tick이 활성 tick 사이에 끼어도 누적치를 훼손하지 않는다', async () => {
    const kv = new InMemoryKV();
    await accumulateBoardingPromptCounters(
      kv as unknown as KVNamespace,
      { ...ZERO_DELTA, evaluated: 4 },
      NOW,
    );
    // idle tick — no-op
    await accumulateBoardingPromptCounters(kv as unknown as KVNamespace, ZERO_DELTA, NOW + 60_000);
    await accumulateBoardingPromptCounters(
      kv as unknown as KVNamespace,
      { ...ZERO_DELTA, evaluated: 1 },
      NOW + 120_000,
    );
    const result = await readBoardingPromptCounters(kv as unknown as KVNamespace);
    expect(result?.evaluated).toBe(5);
  });

  it('TTL 24h로 KV put', async () => {
    const kv = new InMemoryKV();
    const before = Date.now();
    await accumulateBoardingPromptCounters(
      kv as unknown as KVNamespace,
      { ...ZERO_DELTA, evaluated: 1 },
      NOW,
    );
    const after = Date.now();
    const entry = kv.store.get(BOARDING_PROMPT_COUNTER_KEY);
    expect(entry?.expiresAt).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
    expect(entry?.expiresAt).toBeLessThanOrEqual(after + 25 * 60 * 60 * 1000);
  });

  it('malformed 기존 값 위에 누적 시 0부터 다시 시작(throw 없이 복구)', async () => {
    const kv = new InMemoryKV();
    kv.store.set(BOARDING_PROMPT_COUNTER_KEY, { value: '{not-json' });
    const result = await accumulateBoardingPromptCounters(
      kv as unknown as KVNamespace,
      { ...ZERO_DELTA, evaluated: 2 },
      NOW,
    );
    expect(result?.evaluated).toBe(2);
  });
});

describe('EMPTY_BOARDING_PROMPT_COUNTERS', () => {
  it('zero 기본값 + self-describing 필드 포함', () => {
    expect(EMPTY_BOARDING_PROMPT_COUNTERS).toEqual({
      evaluated: 0,
      fired: 0,
      blocked: 0,
      skippedNoContext: 0,
      skippedStale: 0,
      skippedTooFar: 0,
      skippedTrainDuplicate: 0,
      window: '24h-rolling-ttl',
      sampledAt: 0,
    });
  });
});
