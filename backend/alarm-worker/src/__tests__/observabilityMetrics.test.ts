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
      accelPatternHitRatio: {
        automotive: { count: 2, ratio: 0.5 },
        walking: { count: 1, ratio: 0.25 },
        stationary: { count: 1, ratio: 0.25 },
        unknown: { count: 0, ratio: 0 },
      },
      silentPushLatency: null,
      laPushDeliveryRatio: { sent: 10, failed: 2, ratio: 10 / 12 },
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
      accelPatternHitRatio: {
        automotive: { count: 0, ratio: 0 },
        walking: { count: 0, ratio: 0 },
        stationary: { count: 0, ratio: 0 },
        unknown: { count: 0, ratio: 0 },
      },
      silentPushLatency: null,
      laPushDeliveryRatio: { sent: 0, failed: 0, ratio: 0 },
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

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — silentPushLatency (#1772)
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — silentPushLatency (#1772)', () => {
  it('undefined pendingPushesKv → silentPushLatency=null', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.silentPushLatency).toBeNull();
  });

  it('KV에 latencyMs stamp 있으면 p50/p95 집계 결과 반환', async () => {
    const kv = new InMemoryKV();
    // 3개 샘플: 100, 200, 300ms. sorted p50=index1=200, p95=index2=300.
    for (const [i, ms] of [100, 200, 300].entries()) {
      kv.store.set(`received:p-lat-${i}`, {
        value: JSON.stringify({ pushId: `p-lat-${i}`, receivedAt: NOW - 1000, stationName: 'A', phase: 'imminent', latencyMs: ms }),
      });
    }
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, kv as unknown as KVNamespace, NOW);
    expect(result.silentPushLatency).not.toBeNull();
    expect(result.silentPushLatency!.totalSamples).toBe(3);
    expect(result.silentPushLatency!.p50).toBe(200);
    expect(result.silentPushLatency!.p95).toBe(300);
  });

  it('KV에 latencyMs stamp 없으면 silentPushLatency=null', async () => {
    const kv = new InMemoryKV();
    kv.store.set('received:p-no-lat', {
      value: JSON.stringify({ pushId: 'p-no-lat', receivedAt: NOW - 1000, stationName: 'A', phase: 'imminent' }),
    });
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, kv as unknown as KVNamespace, NOW);
    expect(result.silentPushLatency).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — accelPatternHitRatio (#1769)
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — accelPatternHitRatio (#1769)', () => {
  it('empty R2 → all pattern count=0, ratio=0', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.accelPatternHitRatio.automotive.count).toBe(0);
    expect(result.accelPatternHitRatio.walking.count).toBe(0);
    expect(result.accelPatternHitRatio.stationary.count).toBe(0);
    expect(result.accelPatternHitRatio.unknown.count).toBe(0);
    expect(result.accelPatternHitRatio.automotive.ratio).toBe(0);
  });

  it('accel-pattern-observed entries → 4 pattern 분포 계산', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/24/accel-x.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'automotive' },
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'automotive' },
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'walking' },
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'stationary' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    const { accelPatternHitRatio } = result;
    expect(accelPatternHitRatio.automotive.count).toBe(2);
    expect(accelPatternHitRatio.walking.count).toBe(1);
    expect(accelPatternHitRatio.stationary.count).toBe(1);
    expect(accelPatternHitRatio.unknown.count).toBe(0);
    // total = 4, automotive ratio = 2/4 = 0.5
    expect(accelPatternHitRatio.automotive.ratio).toBeCloseTo(0.5);
    expect(accelPatternHitRatio.walking.ratio).toBeCloseTo(0.25);
    expect(accelPatternHitRatio.stationary.ratio).toBeCloseTo(0.25);
    expect(accelPatternHitRatio.unknown.ratio).toBe(0);
  });

  it('ratio 합계는 1.0 (혼합 패턴)', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/24/accel-y.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'automotive' },
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'walking' },
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'stationary' },
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'unknown' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    const { accelPatternHitRatio } = result;
    const ratioSum = accelPatternHitRatio.automotive.ratio +
      accelPatternHitRatio.walking.ratio +
      accelPatternHitRatio.stationary.ratio +
      accelPatternHitRatio.unknown.ratio;
    expect(ratioSum).toBeCloseTo(1.0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — laPushDeliveryRatio (#1779)
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — laPushDeliveryRatio (#1779)', () => {
  it('no tripsKv → placeholder 0/0/0', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW, undefined);
    expect(result.laPushDeliveryRatio).toEqual({ sent: 0, failed: 0, ratio: 0 });
  });

  it('empty tripsKv → 0/0/0', async () => {
    const r2 = makeEmptyFakeR2();
    const kv = new InMemoryKV();
    const result = await computeObservabilityMetrics(r2, undefined, NOW, kv as unknown as KVNamespace);
    expect(result.laPushDeliveryRatio).toEqual({ sent: 0, failed: 0, ratio: 0 });
  });

  it('computes sent/(sent+failed) from accumulated KV counters', async () => {
    const r2 = makeEmptyFakeR2();
    const kv = new InMemoryKV();
    // Pre-populate la-push-counters bucket for current hour
    const bucket = Math.floor(NOW / (60 * 60 * 1000));
    kv.store.set(`la-push-counters:${bucket}`, {
      value: JSON.stringify({ sent: 8, failed: 2 }),
    });
    const result = await computeObservabilityMetrics(r2, undefined, NOW, kv as unknown as KVNamespace);
    expect(result.laPushDeliveryRatio.sent).toBe(8);
    expect(result.laPushDeliveryRatio.failed).toBe(2);
    expect(result.laPushDeliveryRatio.ratio).toBeCloseTo(0.8);
  });

  it('all sent (failed=0) → ratio=1', async () => {
    const r2 = makeEmptyFakeR2();
    const kv = new InMemoryKV();
    const bucket = Math.floor(NOW / (60 * 60 * 1000));
    kv.store.set(`la-push-counters:${bucket}`, {
      value: JSON.stringify({ sent: 5, failed: 0 }),
    });
    const result = await computeObservabilityMetrics(r2, undefined, NOW, kv as unknown as KVNamespace);
    expect(result.laPushDeliveryRatio.ratio).toBe(1);
  });

  it('all failed (sent=0) → ratio=0', async () => {
    const r2 = makeEmptyFakeR2();
    const kv = new InMemoryKV();
    const bucket = Math.floor(NOW / (60 * 60 * 1000));
    kv.store.set(`la-push-counters:${bucket}`, {
      value: JSON.stringify({ sent: 0, failed: 3 }),
    });
    const result = await computeObservabilityMetrics(r2, undefined, NOW, kv as unknown as KVNamespace);
    expect(result.laPushDeliveryRatio.ratio).toBe(0);
    expect(result.laPushDeliveryRatio.failed).toBe(3);
  });

  it('laPushDeliveryRatio included in response shape', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect('laPushDeliveryRatio' in result).toBe(true);
  });
});
