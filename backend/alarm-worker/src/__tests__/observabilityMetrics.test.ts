/**
 * observabilityMetrics.test.ts — #1752 observabilityMetrics unit tests.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import {
  buildAlarmLogNdjsonFixture,
  makeEmptyFakeR2,
  makeFakeR2,
} from './helpers/r2Fixtures';
import {
  computeObservabilityMetrics,
  hourBucketKey,
  readObservabilityMetrics,
  storeObservabilityMetrics,
} from '../observabilityMetrics';

const NOW = 1_700_000_000_000;

// ──────────────────────────────────────────────────────────────────────────────
// hourBucketKey
// ──────────────────────────────────────────────────────────────────────────────

describe('hourBucketKey', () => {
  it('returns same key within the same 1h window', () => {
    const base = Math.floor(NOW / (60 * 60 * 1000)) * (60 * 60 * 1000);
    expect(hourBucketKey(base)).toBe(hourBucketKey(base + 59 * 60 * 1000));
  });

  it('returns different key for next hour', () => {
    const k1 = hourBucketKey(NOW);
    const k2 = hourBucketKey(NOW + 60 * 60 * 1000);
    expect(k1).not.toBe(k2);
  });

  it('key starts with obs-metrics:24h: prefix', () => {
    expect(hourBucketKey(NOW)).toMatch(/^obs-metrics:24h:/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// storeObservabilityMetrics + readObservabilityMetrics
// ──────────────────────────────────────────────────────────────────────────────

describe('storeObservabilityMetrics + readObservabilityMetrics', () => {
  it('round-trips stored metrics from KV', async () => {
    const kv = new InMemoryKV();
    const metrics = {
      accuracyRatio: { value: 5, total: 8, ratio: 5 / 8 },
      silentPushDeliveryRatio: { value: 3, total: 4, ratio: 0.75 },
      locklessMissRatio: { value: 1, total: 8, ratio: 1 / 8 },
      boardableMissRatio: { value: 0, total: 0, ratio: 0 },
      window: '24h' as const,
      timestamp: NOW,
    };
    await storeObservabilityMetrics(kv as unknown as KVNamespace, metrics, NOW);
    const result = await readObservabilityMetrics(kv as unknown as KVNamespace, NOW);
    expect(result).toEqual(metrics);
  });

  it('returns null when no metrics stored yet', async () => {
    const kv = new InMemoryKV();
    const result = await readObservabilityMetrics(kv as unknown as KVNamespace, NOW);
    expect(result).toBeNull();
  });

  it('returns null for malformed KV value', async () => {
    const kv = new InMemoryKV();
    const key = hourBucketKey(NOW);
    kv.store.set(key, { value: '{not-json' });
    const result = await readObservabilityMetrics(kv as unknown as KVNamespace, NOW);
    expect(result).toBeNull();
  });

  it('uses 1h TTL for KV put', async () => {
    const kv = new InMemoryKV();
    const metrics = {
      accuracyRatio: { value: 1, total: 2, ratio: 0.5 },
      silentPushDeliveryRatio: { value: 0, total: 0, ratio: 0 },
      locklessMissRatio: { value: 0, total: 0, ratio: 0 },
      boardableMissRatio: { value: 0, total: 0, ratio: 0 },
      window: '24h' as const,
      timestamp: NOW,
    };
    const beforePut = Date.now();
    await storeObservabilityMetrics(kv as unknown as KVNamespace, metrics, NOW);
    const afterPut = Date.now();
    const key = hourBucketKey(NOW);
    const entry = kv.store.get(key);
    // expiresAt should be ~1h after the actual put time (InMemoryKV.put uses Date.now() internally)
    expect(entry?.expiresAt).toBeGreaterThan(beforePut + 59 * 60 * 1000);
    expect(entry?.expiresAt).toBeLessThanOrEqual(afterPut + 61 * 60 * 1000);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — accuracyRatio
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — accuracyRatio', () => {
  it('empty R2 → accuracyRatio total=0, ratio=0', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.accuracyRatio).toEqual({ value: 0, total: 0, ratio: 0 });
  });

  it('computes fired/(fired+suppressed) from alarmLog', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/a.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'fg-arvlcd', outcome: 'fired' },
            { source: 'fg-arvlcd', outcome: 'fired' },
            { source: 'fg-arvlcd', outcome: 'suppressed', reason: 'gate-stale-location' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.accuracyRatio.value).toBe(2);
    expect(result.accuracyRatio.total).toBe(3);
    expect(result.accuracyRatio.ratio).toBeCloseTo(2 / 3);
  });

  it('all fired → ratio=1', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/b.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'fg', outcome: 'fired' },
            { source: 'fg', outcome: 'fired' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.accuracyRatio.ratio).toBe(1);
    expect(result.accuracyRatio.total).toBe(2);
  });

  it('all suppressed → ratio=0, total>0', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/c.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [{ source: 'fg', outcome: 'suppressed', reason: 'gate-stale-location' }],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.accuracyRatio.ratio).toBe(0);
    expect(result.accuracyRatio.total).toBe(1);
    expect(result.accuracyRatio.value).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — locklessMissRatio
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — locklessMissRatio', () => {
  it('counts lockless-forward-only-block reason correctly', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/d.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'fg', outcome: 'suppressed', reason: 'lockless-forward-only-block' },
            { source: 'fg', outcome: 'suppressed', reason: 'gate-stale-location' },
            { source: 'fg', outcome: 'fired' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.locklessMissRatio.value).toBe(1);
    expect(result.locklessMissRatio.total).toBe(3); // fired + suppressed
    expect(result.locklessMissRatio.ratio).toBeCloseTo(1 / 3);
  });

  it('zero lockless misses → ratio=0', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/e.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'fg', outcome: 'fired' },
            { source: 'fg', outcome: 'suppressed', reason: 'gate-stale-location' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.locklessMissRatio.value).toBe(0);
    expect(result.locklessMissRatio.ratio).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — silentPushDeliveryRatio
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — silentPushDeliveryRatio', () => {
  it('undefined pendingPushesKv → graceful placeholder (0/0)', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.silentPushDeliveryRatio).toEqual({ value: 0, total: 0, ratio: 0 });
  });

  it('computes received / (received + pending)', async () => {
    const kv = new InMemoryKV();
    // 2 received entries within 1h
    kv.store.set('received:p1', {
      value: JSON.stringify({ pushId: 'p1', receivedAt: NOW - 10_000, stationName: 'A', phase: 'imminent' }),
    });
    kv.store.set('received:p2', {
      value: JSON.stringify({ pushId: 'p2', receivedAt: NOW - 20_000, stationName: 'B', phase: 'imminent' }),
    });
    // 1 pending (in-flight)
    kv.store.set('pending:p3', {
      value: JSON.stringify({ pushId: 'p3', sentAt: NOW - 30_000 }),
    });
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, kv as unknown as KVNamespace, NOW);
    // received=2, pending=1, total=3
    expect(result.silentPushDeliveryRatio.value).toBe(2);
    expect(result.silentPushDeliveryRatio.total).toBe(3);
    expect(result.silentPushDeliveryRatio.ratio).toBeCloseTo(2 / 3);
  });

  it('no KV entries → 0/0 ratio=0', async () => {
    const kv = new InMemoryKV();
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, kv as unknown as KVNamespace, NOW);
    expect(result.silentPushDeliveryRatio).toEqual({ value: 0, total: 0, ratio: 0 });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — boardableMissRatio (placeholder)
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — boardableMissRatio', () => {
  it('always returns placeholder 0/0', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.boardableMissRatio).toEqual({ value: 0, total: 0, ratio: 0 });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — response shape
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — response shape', () => {
  it('window is always "24h"', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.window).toBe('24h');
  });

  it('timestamp matches now', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.timestamp).toBe(NOW);
  });
});
