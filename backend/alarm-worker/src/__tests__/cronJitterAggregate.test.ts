import { beforeEach, describe, expect, it } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  JITTER_SAMPLE_EVERY_N_TICKS,
  JITTER_SAMPLES_MAX_LEN,
  appendJitterSample,
  computeJitterPercentiles,
  readJitterSamples,
  resetJitterSamples,
  shouldEmitHeartbeat,
  shouldSampleJitterTick,
  stampHeartbeat,
} from '../cronJitterAggregate';
import { InMemoryKV } from './inMemoryKv';

describe('cronJitterAggregate (#2054)', () => {
  let kv: InMemoryKV;
  beforeEach(() => {
    kv = new InMemoryKV();
  });

  describe('appendJitterSample + readJitterSamples', () => {
    it('appends samples in order', async () => {
      await appendJitterSample(kv as unknown as KVNamespace, 100);
      await appendJitterSample(kv as unknown as KVNamespace, 200);
      await appendJitterSample(kv as unknown as KVNamespace, 300);
      const samples = await readJitterSamples(kv as unknown as KVNamespace);
      expect(samples).toEqual([100, 200, 300]);
    });

    it('graceful no-op when kv is undefined', async () => {
      await expect(appendJitterSample(undefined, 100)).resolves.toBeUndefined();
      expect(await readJitterSamples(undefined)).toEqual([]);
    });

    it('caps samples at JITTER_SAMPLES_MAX_LEN (drops oldest)', async () => {
      // 상한 초과 append — 첫 값이 drop 되어야.
      for (let i = 0; i < JITTER_SAMPLES_MAX_LEN + 3; i++) {
        await appendJitterSample(kv as unknown as KVNamespace, i);
      }
      const samples = await readJitterSamples(kv as unknown as KVNamespace);
      expect(samples.length).toBe(JITTER_SAMPLES_MAX_LEN);
      // 초기 3 값(0,1,2) 은 drop, 마지막 값은 유지.
      expect(samples[0]).toBe(3);
      expect(samples[samples.length - 1]).toBe(JITTER_SAMPLES_MAX_LEN + 2);
    });

    it('empty on corrupt json / non-array', async () => {
      await (kv as unknown as KVNamespace).put('scheduled:jitter-samples', 'not-json');
      expect(await readJitterSamples(kv as unknown as KVNamespace)).toEqual([]);
      await (kv as unknown as KVNamespace).put('scheduled:jitter-samples', JSON.stringify({ not: 'array' }));
      expect(await readJitterSamples(kv as unknown as KVNamespace)).toEqual([]);
    });

    it('filters non-number entries defensively', async () => {
      await (kv as unknown as KVNamespace).put(
        'scheduled:jitter-samples',
        JSON.stringify([1, 'x', 2, null, 3, Number.NaN]),
      );
      const samples = await readJitterSamples(kv as unknown as KVNamespace);
      expect(samples).toEqual([1, 2, 3]);
    });

    it('read graceful when kv.get throws', async () => {
      const throwingKv = {
        get: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      expect(await readJitterSamples(throwingKv)).toEqual([]);
    });

    it('append graceful when kv.put throws', async () => {
      const throwingKv = {
        get: async () => null,
        put: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      await expect(appendJitterSample(throwingKv, 100)).resolves.toBeUndefined();
    });
  });

  describe('resetJitterSamples', () => {
    it('clears samples', async () => {
      await appendJitterSample(kv as unknown as KVNamespace, 100);
      await resetJitterSamples(kv as unknown as KVNamespace);
      expect(await readJitterSamples(kv as unknown as KVNamespace)).toEqual([]);
    });

    it('graceful no-op when kv is undefined', async () => {
      await expect(resetJitterSamples(undefined)).resolves.toBeUndefined();
    });

    it('graceful when kv.delete throws', async () => {
      const throwingKv = {
        delete: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      await expect(resetJitterSamples(throwingKv)).resolves.toBeUndefined();
    });
  });

  describe('computeJitterPercentiles', () => {
    it('returns null on empty input', () => {
      expect(computeJitterPercentiles([])).toBeNull();
    });

    it('handles single sample', () => {
      const result = computeJitterPercentiles([42]);
      expect(result).toEqual({ p50: 42, p99: 42 });
    });

    it('returns p50 and p99 nearest-rank', () => {
      const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
      const result = computeJitterPercentiles(samples);
      expect(result).not.toBeNull();
      // p50: ceil(0.5 * 100) - 1 = 49 → index 49 → value 50.
      expect(result?.p50).toBe(50);
      // p99: ceil(0.99 * 100) - 1 = 98 → index 98 → value 99.
      expect(result?.p99).toBe(99);
    });

    it('sorts internally without mutating input', () => {
      const samples = [30, 10, 20];
      const snapshot = [...samples];
      const result = computeJitterPercentiles(samples);
      expect(samples).toEqual(snapshot);
      expect(result?.p50).toBe(20);
    });
  });

  describe('shouldEmitHeartbeat + stampHeartbeat', () => {
    const NOW = 1_700_000_000_000;

    it('returns false when kv is undefined', async () => {
      expect(await shouldEmitHeartbeat(undefined, NOW)).toBe(false);
    });

    it('returns true when no last-heartbeat stamp exists', async () => {
      expect(await shouldEmitHeartbeat(kv as unknown as KVNamespace, NOW)).toBe(true);
    });

    it('returns false within HEARTBEAT_INTERVAL_MS after stamp', async () => {
      await stampHeartbeat(kv as unknown as KVNamespace, NOW);
      expect(await shouldEmitHeartbeat(kv as unknown as KVNamespace, NOW + 60_000)).toBe(false);
      expect(
        await shouldEmitHeartbeat(kv as unknown as KVNamespace, NOW + HEARTBEAT_INTERVAL_MS - 1),
      ).toBe(false);
    });

    it('returns true at/after HEARTBEAT_INTERVAL_MS since last stamp', async () => {
      await stampHeartbeat(kv as unknown as KVNamespace, NOW);
      expect(
        await shouldEmitHeartbeat(kv as unknown as KVNamespace, NOW + HEARTBEAT_INTERVAL_MS),
      ).toBe(true);
    });

    it('returns true when stamped value is corrupt (NaN)', async () => {
      await (kv as unknown as KVNamespace).put('scheduled:last-heartbeat', 'not-a-number');
      expect(await shouldEmitHeartbeat(kv as unknown as KVNamespace, NOW)).toBe(true);
    });

    it('returns false when kv.get throws (conservative)', async () => {
      const throwingKv = {
        get: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      expect(await shouldEmitHeartbeat(throwingKv, NOW)).toBe(false);
    });

    it('stampHeartbeat graceful when kv undefined or throws', async () => {
      await expect(stampHeartbeat(undefined, NOW)).resolves.toBeUndefined();
      const throwingKv = {
        put: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      await expect(stampHeartbeat(throwingKv, NOW)).resolves.toBeUndefined();
    });
  });

  describe('shouldSampleJitterTick (#2073 Issue D)', () => {
    const TICK_MS = 60_000;

    it('samples true on tick index 0 (and every JITTER_SAMPLE_EVERY_N_TICKS multiple)', () => {
      expect(shouldSampleJitterTick(0, TICK_MS)).toBe(true);
      const tenthTick = TICK_MS * JITTER_SAMPLE_EVERY_N_TICKS;
      expect(shouldSampleJitterTick(tenthTick, TICK_MS)).toBe(true);
      const twentiethTick = TICK_MS * JITTER_SAMPLE_EVERY_N_TICKS * 2;
      expect(shouldSampleJitterTick(twentiethTick, TICK_MS)).toBe(true);
    });

    it('samples false on non-multiple tick indices', () => {
      for (let tick = 1; tick < JITTER_SAMPLE_EVERY_N_TICKS; tick++) {
        expect(shouldSampleJitterTick(tick * TICK_MS, TICK_MS)).toBe(false);
      }
    });

    it('is deterministic — only depends on now/tickIntervalMs, not call order', () => {
      const now = 1_700_000_000_000;
      const first = shouldSampleJitterTick(now, TICK_MS);
      const second = shouldSampleJitterTick(now, TICK_MS);
      expect(first).toBe(second);
    });
  });
});
