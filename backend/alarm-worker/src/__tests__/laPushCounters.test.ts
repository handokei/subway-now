/**
 * laPushCounters.test.ts — #1779 LA push counter accumulation unit tests.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import {
  accumulateLaPushCounters,
  laPushCounterKey,
  LA_PUSH_COUNTER_KEY_PREFIX,
  sumLaPushCounters,
} from '../laPushCounters';

const NOW = 1_700_000_000_000;

// ──────────────────────────────────────────────────────────────────────────────
// laPushCounterKey
// ──────────────────────────────────────────────────────────────────────────────

describe('laPushCounterKey', () => {
  it('returns same key within the same 1h window', () => {
    const base = Math.floor(NOW / (60 * 60 * 1000)) * (60 * 60 * 1000);
    expect(laPushCounterKey(base)).toBe(laPushCounterKey(base + 59 * 60 * 1000));
  });

  it('returns different key for next hour', () => {
    const k1 = laPushCounterKey(NOW);
    const k2 = laPushCounterKey(NOW + 60 * 60 * 1000);
    expect(k1).not.toBe(k2);
  });

  it('key starts with LA_PUSH_COUNTER_KEY_PREFIX', () => {
    expect(laPushCounterKey(NOW)).toMatch(new RegExp(`^${LA_PUSH_COUNTER_KEY_PREFIX}`));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// accumulateLaPushCounters
// ──────────────────────────────────────────────────────────────────────────────

describe('accumulateLaPushCounters', () => {
  it('no-op when sent+failed=0', async () => {
    const kv = new InMemoryKV();
    await accumulateLaPushCounters(kv as unknown as KVNamespace, 0, 0, NOW);
    expect(kv.store.size).toBe(0);
  });

  it('writes first entry for new bucket', async () => {
    const kv = new InMemoryKV();
    await accumulateLaPushCounters(kv as unknown as KVNamespace, 5, 1, NOW);
    const key = laPushCounterKey(NOW);
    const raw = kv.store.get(key)?.value;
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string) as { sent: number; failed: number };
    expect(parsed.sent).toBe(5);
    expect(parsed.failed).toBe(1);
  });

  it('accumulates on existing bucket entry', async () => {
    const kv = new InMemoryKV();
    await accumulateLaPushCounters(kv as unknown as KVNamespace, 3, 1, NOW);
    await accumulateLaPushCounters(kv as unknown as KVNamespace, 2, 0, NOW);
    const key = laPushCounterKey(NOW);
    const raw = kv.store.get(key)?.value;
    const parsed = JSON.parse(raw as string) as { sent: number; failed: number };
    expect(parsed.sent).toBe(5);
    expect(parsed.failed).toBe(1);
  });

  it('treats malformed existing value as zero baseline', async () => {
    const kv = new InMemoryKV();
    const key = laPushCounterKey(NOW);
    kv.store.set(key, { value: '{bad-json' });
    await accumulateLaPushCounters(kv as unknown as KVNamespace, 4, 2, NOW);
    const raw = kv.store.get(key)?.value;
    const parsed = JSON.parse(raw as string) as { sent: number; failed: number };
    expect(parsed.sent).toBe(4);
    expect(parsed.failed).toBe(2);
  });

  it('uses 25h TTL for KV put', async () => {
    const kv = new InMemoryKV();
    const before = Date.now();
    await accumulateLaPushCounters(kv as unknown as KVNamespace, 1, 0, NOW);
    const after = Date.now();
    const key = laPushCounterKey(NOW);
    const entry = kv.store.get(key);
    expect(entry?.expiresAt).toBeGreaterThan(before + 24 * 60 * 60 * 1000);
    expect(entry?.expiresAt).toBeLessThanOrEqual(after + 26 * 60 * 60 * 1000);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// sumLaPushCounters
// ──────────────────────────────────────────────────────────────────────────────

describe('sumLaPushCounters', () => {
  it('returns 0/0 when no entries exist', async () => {
    const kv = new InMemoryKV();
    const result = await sumLaPushCounters(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('sums current hour bucket', async () => {
    const kv = new InMemoryKV();
    await accumulateLaPushCounters(kv as unknown as KVNamespace, 10, 2, NOW);
    const result = await sumLaPushCounters(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(10);
    expect(result.failed).toBe(2);
  });

  it('sums across multiple hour buckets within 24h window', async () => {
    const kv = new InMemoryKV();
    // bucket N (current)
    await accumulateLaPushCounters(kv as unknown as KVNamespace, 5, 1, NOW);
    // bucket N-1 (1h ago)
    await accumulateLaPushCounters(kv as unknown as KVNamespace, 3, 0, NOW - 60 * 60 * 1000);
    // bucket N-23 (23h ago — within window)
    await accumulateLaPushCounters(kv as unknown as KVNamespace, 2, 1, NOW - 23 * 60 * 60 * 1000);
    const result = await sumLaPushCounters(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(10);
    expect(result.failed).toBe(2);
  });

  it('ignores malformed bucket entries', async () => {
    const kv = new InMemoryKV();
    // Good entry
    await accumulateLaPushCounters(kv as unknown as KVNamespace, 7, 1, NOW);
    // Malformed entry for previous bucket
    const prevKey = `${LA_PUSH_COUNTER_KEY_PREFIX}${Math.floor(NOW / (60 * 60 * 1000)) - 1}`;
    kv.store.set(prevKey, { value: 'not-json' });
    const result = await sumLaPushCounters(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(7);
    expect(result.failed).toBe(1);
  });
});
