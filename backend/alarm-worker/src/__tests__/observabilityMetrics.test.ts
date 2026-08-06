/**
 * observabilityMetrics.test.ts — #1752 observabilityMetrics unit tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import {
  buildAlarmLogNdjsonFixture,
  makeEmptyFakeR2,
  makeFakeR2,
} from './helpers/r2Fixtures';
import {
  computeObservabilityMetrics,
  hourBucketKey,
  readLastSuccessfulMetrics,
  readObservabilityMetrics,
  storeObservabilityMetrics,
  tryStoreObservabilityMetrics,
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
      silentPushReachRatio: { sent: 0, received: 0, joined: 0, ratio: 0 },
      algorithmAccuracyRatio: { value: 7, total: 9, ratio: 7 / 9, answeredTotal: 12 },
      locklessTripMissRatio: { miss: 0, fired: 0, paradigmIntent: 0, ratio: 0 },
      boardingPromptCounters: {
        evaluated: 4,
        fired: 2,
        blocked: 1,
        skippedNoContext: 0,
        skippedStale: 0,
        skippedTooFar: 0,
        skippedTrainDuplicate: 1,
        window: '24h-rolling-ttl' as const,
        sampledAt: NOW,
      },
      pushFailures: { total24h: 0, topReasons: [] },
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
      silentPushReachRatio: { sent: 0, received: 0, joined: 0, ratio: 0 },
      algorithmAccuracyRatio: { value: 0, total: 0, ratio: 0, answeredTotal: 0 },
      locklessTripMissRatio: { miss: 0, fired: 0, paradigmIntent: 0, ratio: 0 },
      boardingPromptCounters: {
        evaluated: 0,
        fired: 0,
        blocked: 0,
        skippedNoContext: 0,
        skippedStale: 0,
        skippedTooFar: 0,
        skippedTrainDuplicate: 0,
        window: '24h-rolling-ttl' as const,
        sampledAt: NOW,
      },
      pushFailures: { total24h: 0, topReasons: [] },
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
// computeObservabilityMetrics — silentPushReachRatio (#1958)
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — silentPushReachRatio (#1958)', () => {
  it('undefined pendingPushesKv → graceful placeholder (0/0/0)', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.silentPushReachRatio).toEqual({ sent: 0, received: 0, joined: 0, ratio: 0 });
  });

  it('5min 윈도우 안 sent 3건 / received 2건 → joined=2 ratio=2/3', async () => {
    const kv = new InMemoryKV();
    // 5min 윈도우 안 sent stamps (corrId = pushId)
    kv.store.set('sent:p1', {
      value: JSON.stringify({ pushId: 'p1', sentAt: NOW - 60_000 }),
    });
    kv.store.set('sent:p2', {
      value: JSON.stringify({ pushId: 'p2', sentAt: NOW - 90_000 }),
    });
    kv.store.set('sent:p3', {
      value: JSON.stringify({ pushId: 'p3', sentAt: NOW - 120_000 }),
    });
    // received stamps — p1, p2 만 ack 도착
    kv.store.set('received:p1', {
      value: JSON.stringify({
        pushId: 'p1',
        receivedAt: NOW - 50_000,
        stationName: 'A',
        phase: 'imminent',
      }),
    });
    kv.store.set('received:p2', {
      value: JSON.stringify({
        pushId: 'p2',
        receivedAt: NOW - 80_000,
        stationName: 'B',
        phase: 'imminent',
      }),
    });
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, kv as unknown as KVNamespace, NOW);
    expect(result.silentPushReachRatio.sent).toBe(3);
    expect(result.silentPushReachRatio.received).toBe(2);
    expect(result.silentPushReachRatio.joined).toBe(2);
    expect(result.silentPushReachRatio.ratio).toBeCloseTo(2 / 3);
  });

  it('5min 윈도우 밖 sent → 분모에서 제외', async () => {
    const kv = new InMemoryKV();
    // 10min 전 sent — 윈도우 밖
    kv.store.set('sent:old', {
      value: JSON.stringify({ pushId: 'old', sentAt: NOW - 10 * 60_000 }),
    });
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, kv as unknown as KVNamespace, NOW);
    expect(result.silentPushReachRatio.sent).toBe(0);
    expect(result.silentPushReachRatio.ratio).toBe(0);
  });

  it('sent 없이 received만 있는 case (legacy / 누락) → 분자 제외 ratio=0', async () => {
    const kv = new InMemoryKV();
    kv.store.set('received:orphan', {
      value: JSON.stringify({
        pushId: 'orphan',
        receivedAt: NOW - 30_000,
        stationName: 'C',
        phase: 'imminent',
      }),
    });
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, kv as unknown as KVNamespace, NOW);
    expect(result.silentPushReachRatio.sent).toBe(0);
    expect(result.silentPushReachRatio.received).toBe(0);
    expect(result.silentPushReachRatio.joined).toBe(0);
    expect(result.silentPushReachRatio.ratio).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — boardableMissRatio (#1503 M3 Sub C wire)
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — boardableMissRatio (#1503)', () => {
  it('empty R2 → 0/0 ratio=0 (transfer 없는 trip + 빈 archive)', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.boardableMissRatio).toEqual({ value: 0, total: 0, ratio: 0 });
  });

  it('boardable-lookup outcome="received"(ok) + "suppressed"(miss) 집계 → miss / (ok + miss)', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/24/boardable-x.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'boardable-lookup', outcome: 'received', stationName: '왕십리' },
            { source: 'boardable-lookup', outcome: 'received', stationName: '종로3가' },
            { source: 'boardable-lookup', outcome: 'received', stationName: '충무로' },
            { source: 'boardable-lookup', outcome: 'suppressed', stationName: '사당' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    // 3 ok + 1 miss = 4 total, ratio = 1/4 = 0.25
    expect(result.boardableMissRatio.value).toBe(1);
    expect(result.boardableMissRatio.total).toBe(4);
    expect(result.boardableMissRatio.ratio).toBeCloseTo(0.25, 5);
  });

  it('boardable-lookup outcome 외 source는 ratio에 영향 X', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/24/mixed-y.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'fg-arvlcd', outcome: 'fired', stationName: '강남' },
            { source: 'silent-push-fired', outcome: 'fired', stationName: '서초' },
            // boardable 1 ok 1 miss
            { source: 'boardable-lookup', outcome: 'received', stationName: '종로3가' },
            { source: 'boardable-lookup', outcome: 'suppressed', stationName: '왕십리' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.boardableMissRatio.value).toBe(1);
    expect(result.boardableMissRatio.total).toBe(2);
    expect(result.boardableMissRatio.ratio).toBe(0.5);
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

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — algorithmAccuracyRatio (#1957, #1503 잔여 1/3)
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — algorithmAccuracyRatio (#1957)', () => {
  it('empty R2 → 0/0 ratio=0, answeredTotal=0', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.algorithmAccuracyRatio).toEqual({
      value: 0,
      total: 0,
      ratio: 0,
      answeredTotal: 0,
    });
  });

  it('ground-truth-response outcome="fired"(yes) + "suppressed"(no) → ratio = yes / (yes + no)', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/gt-x.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'ground-truth-response', outcome: 'fired', stationName: 'gt-yes' },
            { source: 'ground-truth-response', outcome: 'fired', stationName: 'gt-yes' },
            { source: 'ground-truth-response', outcome: 'fired', stationName: 'gt-yes' },
            { source: 'ground-truth-response', outcome: 'suppressed', stationName: 'gt-no' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    // 3 yes + 1 no = 4 total, ratio = 3/4 = 0.75. pending 0 → answeredTotal = 4.
    expect(result.algorithmAccuracyRatio.value).toBe(3);
    expect(result.algorithmAccuracyRatio.total).toBe(4);
    expect(result.algorithmAccuracyRatio.ratio).toBeCloseTo(0.75, 5);
    expect(result.algorithmAccuracyRatio.answeredTotal).toBe(4);
  });

  it('pending(received)은 분모 제외, answeredTotal에는 포함', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/gt-y.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'ground-truth-response', outcome: 'fired', stationName: 'gt-yes' },
            { source: 'ground-truth-response', outcome: 'suppressed', stationName: 'gt-no' },
            { source: 'ground-truth-response', outcome: 'received', stationName: 'gt-pending' },
            { source: 'ground-truth-response', outcome: 'received', stationName: 'gt-pending' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    // yes=1, no=1, pending=2. ratio = 1 / (1+1) = 0.5. answeredTotal = 4.
    expect(result.algorithmAccuracyRatio.value).toBe(1);
    expect(result.algorithmAccuracyRatio.total).toBe(2);
    expect(result.algorithmAccuracyRatio.ratio).toBe(0.5);
    expect(result.algorithmAccuracyRatio.answeredTotal).toBe(4);
  });

  it('전부 yes → ratio=1', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/gt-allyes.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'ground-truth-response', outcome: 'fired', stationName: 'gt-yes' },
            { source: 'ground-truth-response', outcome: 'fired', stationName: 'gt-yes' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.algorithmAccuracyRatio.ratio).toBe(1);
    expect(result.algorithmAccuracyRatio.value).toBe(2);
  });

  it('전부 pending이면 분모 0 → ratio=0, answeredTotal>0', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/gt-allpending.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'ground-truth-response', outcome: 'received', stationName: 'gt-pending' },
            { source: 'ground-truth-response', outcome: 'received', stationName: 'gt-pending' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    // division-by-zero 방어: yes+no=0 → ratio=0. answeredTotal=2 (pending만 있어도 응답률 시그널은 잡힌다).
    expect(result.algorithmAccuracyRatio.total).toBe(0);
    expect(result.algorithmAccuracyRatio.ratio).toBe(0);
    expect(result.algorithmAccuracyRatio.answeredTotal).toBe(2);
  });

  it('다른 source는 algorithmAccuracyRatio에 영향 X', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/gt-mixed.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'fg-arvlcd', outcome: 'fired', stationName: '강남' },
            { source: 'silent-push-fired', outcome: 'fired', stationName: '서초' },
            { source: 'boardable-lookup', outcome: 'received', stationName: '왕십리' },
            { source: 'ground-truth-response', outcome: 'fired', stationName: 'gt-yes' },
            { source: 'ground-truth-response', outcome: 'suppressed', stationName: 'gt-no' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.algorithmAccuracyRatio.value).toBe(1);
    expect(result.algorithmAccuracyRatio.total).toBe(2);
    expect(result.algorithmAccuracyRatio.ratio).toBe(0.5);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — locklessTripMissRatio (#1972, #1503 잔여 3/3)
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — locklessTripMissRatio (#1972)', () => {
  it('empty R2 → 0/0 ratio=0, paradigmIntent=0', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.locklessTripMissRatio).toEqual({
      miss: 0,
      fired: 0,
      paradigmIntent: 0,
      ratio: 0,
    });
  });

  it('userIntent ON + lockless + fire ≥ 1 → fired 카운터 증가', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/llte-fired.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'lockless-trip-end', outcome: 'fired', stationName: '5:intent' },
            { source: 'lockless-trip-end', outcome: 'fired', stationName: '2:intent' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.locklessTripMissRatio.fired).toBe(2);
    expect(result.locklessTripMissRatio.miss).toBe(0);
    expect(result.locklessTripMissRatio.ratio).toBe(0);
  });

  it('userIntent ON + lockless + fire 0건 → miss 카운터 (진짜 miss)', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/llte-miss.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'lockless-trip-end', outcome: 'suppressed', stationName: '0:intent' },
            { source: 'lockless-trip-end', outcome: 'fired', stationName: '3:intent' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    // miss=1, fired=1 → ratio = 1 / (1+1) = 0.5
    expect(result.locklessTripMissRatio.miss).toBe(1);
    expect(result.locklessTripMissRatio.fired).toBe(1);
    expect(result.locklessTripMissRatio.ratio).toBe(0.5);
  });

  it('userIntent OFF + lockless + fire 0건 → paradigmIntent 카운터 (분모/분자 제외)', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/llte-paradigm.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'lockless-trip-end', outcome: 'received', stationName: '0:paradigm' },
            { source: 'lockless-trip-end', outcome: 'received', stationName: '0:paradigm' },
            { source: 'lockless-trip-end', outcome: 'received', stationName: '0:paradigm' },
            // fired 1건 추가 — paradigmIntent가 ratio에 영향 X 검증
            { source: 'lockless-trip-end', outcome: 'fired', stationName: '4:intent' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.locklessTripMissRatio.paradigmIntent).toBe(3);
    expect(result.locklessTripMissRatio.fired).toBe(1);
    expect(result.locklessTripMissRatio.miss).toBe(0);
    // miss=0, fired=1 → ratio=0. paradigmIntent는 분모/분자 모두 제외.
    expect(result.locklessTripMissRatio.ratio).toBe(0);
  });

  it('전부 paradigmIntent → ratio=0 (division-by-zero 방어, dashboard "no data" 차단)', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/llte-allparadigm.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'lockless-trip-end', outcome: 'received', stationName: '0:paradigm' },
            { source: 'lockless-trip-end', outcome: 'received', stationName: '0:paradigm' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.locklessTripMissRatio.miss).toBe(0);
    expect(result.locklessTripMissRatio.fired).toBe(0);
    expect(result.locklessTripMissRatio.paradigmIntent).toBe(2);
    expect(result.locklessTripMissRatio.ratio).toBe(0);
  });

  it('전부 miss → ratio=1', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/llte-allmiss.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'lockless-trip-end', outcome: 'suppressed', stationName: '0:intent' },
            { source: 'lockless-trip-end', outcome: 'suppressed', stationName: '0:intent' },
            { source: 'lockless-trip-end', outcome: 'suppressed', stationName: '0:intent' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.locklessTripMissRatio.miss).toBe(3);
    expect(result.locklessTripMissRatio.fired).toBe(0);
    expect(result.locklessTripMissRatio.ratio).toBe(1);
  });

  it('다른 source는 locklessTripMissRatio에 영향 X', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/llte-mixed.ndjson',
        tripEndedAt: NOW - 60_000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'fg-arvlcd', outcome: 'fired', stationName: '강남' },
            { source: 'silent-push-fired', outcome: 'fired', stationName: '서초' },
            { source: 'ground-truth-response', outcome: 'fired', stationName: 'gt-yes' },
            { source: 'lockless-trip-end', outcome: 'fired', stationName: '7:intent' },
            { source: 'lockless-trip-end', outcome: 'suppressed', stationName: '0:intent' },
          ],
          NOW - 60_000,
        ),
      },
    ]);
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    // fg-arvlcd / silent-push-fired / ground-truth-response는 lockless 분기 제외.
    expect(result.locklessTripMissRatio.fired).toBe(1);
    expect(result.locklessTripMissRatio.miss).toBe(1);
    expect(result.locklessTripMissRatio.ratio).toBe(0.5);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeObservabilityMetrics — boardingPromptCounters (#2151)
// ──────────────────────────────────────────────────────────────────────────────

describe('computeObservabilityMetrics — boardingPromptCounters (#2151 → #2160)', () => {
  it('boardingPromptCounters 미제공 → zero 기본값', async () => {
    const r2 = makeEmptyFakeR2();
    const result = await computeObservabilityMetrics(r2, undefined, NOW);
    expect(result.boardingPromptCounters).toEqual({
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

  it('boardingPromptCounters 제공 시 응답에 그대로 노출', async () => {
    const r2 = makeEmptyFakeR2();
    const counters = {
      evaluated: 12,
      fired: 5,
      blocked: 6,
      skippedNoContext: 3,
      skippedStale: 1,
      skippedTooFar: 2,
      skippedTrainDuplicate: 1,
      window: '24h-rolling-ttl' as const,
      sampledAt: NOW,
    };
    const result = await computeObservabilityMetrics(r2, undefined, NOW, undefined, counters);
    expect(result.boardingPromptCounters).toEqual(counters);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// tryStoreObservabilityMetrics + readLastSuccessfulMetrics (#1889 RC-19)
// ──────────────────────────────────────────────────────────────────────────────

/** 테스트용 ObservabilityMetricsResponse fixture (모든 필드 기본값 채움). */
const SAMPLE_METRICS = {
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
  silentPushReachRatio: { sent: 0, received: 0, joined: 0, ratio: 0 },
  algorithmAccuracyRatio: { value: 0, total: 0, ratio: 0, answeredTotal: 0 },
  locklessTripMissRatio: { miss: 0, fired: 0, paradigmIntent: 0, ratio: 0 },
  boardingPromptCounters: {
    evaluated: 0,
    fired: 0,
    blocked: 0,
    skippedNoContext: 0,
    skippedStale: 0,
    skippedTooFar: 0,
    skippedTrainDuplicate: 0,
    window: '24h-rolling-ttl' as const,
    sampledAt: NOW,
  },
  pushFailures: { total24h: 0, topReasons: [] },
  window: '24h' as const,
  timestamp: NOW,
};

/**
 * KV.put을 throw하도록 만든 stub. InMemoryKV는 put failure를 시뮬레이션하지 못해 별도 stub 사용.
 * `failKeys`에 매칭되는 키만 throw, 나머지는 inner KV에 위임 — 부분 실패 시나리오 테스트용.
 */
class FailingPutKV {
  inner = new InMemoryKV();
  failKeys: (string | RegExp)[];
  putErrors: { key: string; err: unknown }[] = [];
  getThrows = false;

  constructor(failKeys: (string | RegExp)[] = []) {
    this.failKeys = failKeys;
  }

  async get(key: string): Promise<string | null> {
    if (this.getThrows) throw new Error('KV GET failed');
    return this.inner.get(key);
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const shouldFail = this.failKeys.some((p) =>
      typeof p === 'string' ? p === key : p.test(key),
    );
    if (shouldFail) {
      const err = new Error(`KV PUT failed: 429 daily write limit exceeded (key=${key})`);
      this.putErrors.push({ key, err });
      throw err;
    }
    return this.inner.put(key, value, options);
  }

  async delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
}

describe('tryStoreObservabilityMetrics (#1889 RC-19)', () => {
  it('happy path — writes both hourly bucket and last-success key, returns stored=true', async () => {
    const kv = new InMemoryKV();
    const result = await tryStoreObservabilityMetrics(
      kv as unknown as KVNamespace,
      SAMPLE_METRICS,
      NOW,
    );
    expect(result.stored).toBe(true);
    expect(result.error).toBeUndefined();
    // 1h bucket cache 존재
    const bucketRaw = kv.store.get(hourBucketKey(NOW));
    expect(bucketRaw).toBeDefined();
    expect(JSON.parse(bucketRaw!.value)).toEqual(SAMPLE_METRICS);
    // last-success fallback 존재
    const lastSuccessRaw = kv.store.get('obs-metrics:last-success');
    expect(lastSuccessRaw).toBeDefined();
    expect(JSON.parse(lastSuccessRaw!.value)).toEqual(SAMPLE_METRICS);
  });

  it('last-success key uses 24h TTL (≫ 1h bucket TTL)', async () => {
    const kv = new InMemoryKV();
    const beforePut = Date.now();
    await tryStoreObservabilityMetrics(kv as unknown as KVNamespace, SAMPLE_METRICS, NOW);
    const lastSuccessEntry = kv.store.get('obs-metrics:last-success');
    expect(lastSuccessEntry?.expiresAt).toBeGreaterThan(beforePut + 23 * 60 * 60 * 1000);
    expect(lastSuccessEntry?.expiresAt).toBeLessThanOrEqual(beforePut + 25 * 60 * 60 * 1000);
  });

  it('hourly bucket write fails → stored=false + onError invoked + last-success still attempted', async () => {
    const kv = new FailingPutKV([hourBucketKey(NOW)]);
    const onError = vi.fn();
    const result = await tryStoreObservabilityMetrics(
      kv as unknown as KVNamespace,
      SAMPLE_METRICS,
      NOW,
      { onError },
    );
    expect(result.stored).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), hourBucketKey(NOW));
    // last-success key는 별도 시도 → 성공
    const lastSuccess = kv.inner.store.get('obs-metrics:last-success');
    expect(lastSuccess).toBeDefined();
  });

  it('last-success write fails → stored=false + onError invoked with last-success key', async () => {
    const kv = new FailingPutKV(['obs-metrics:last-success']);
    const onError = vi.fn();
    const result = await tryStoreObservabilityMetrics(
      kv as unknown as KVNamespace,
      SAMPLE_METRICS,
      NOW,
      { onError },
    );
    expect(result.stored).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'obs-metrics:last-success');
    // hourly bucket은 성공
    expect(kv.inner.store.get(hourBucketKey(NOW))).toBeDefined();
  });

  it('both writes fail → stored=false + onError invoked twice + first error returned', async () => {
    const kv = new FailingPutKV([/.*/]);
    const onError = vi.fn();
    const result = await tryStoreObservabilityMetrics(
      kv as unknown as KVNamespace,
      SAMPLE_METRICS,
      NOW,
      { onError },
    );
    expect(result.stored).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledTimes(2);
    // 첫 onError 호출 키는 hourly bucket, 두 번째는 last-success
    expect(onError.mock.calls[0]?.[1]).toBe(hourBucketKey(NOW));
    expect(onError.mock.calls[1]?.[1]).toBe('obs-metrics:last-success');
  });

  it('onError 미제공 시에도 throw 없이 stored=false 반환', async () => {
    const kv = new FailingPutKV([/.*/]);
    const result = await tryStoreObservabilityMetrics(
      kv as unknown as KVNamespace,
      SAMPLE_METRICS,
      NOW,
    );
    expect(result.stored).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });
});

describe('readLastSuccessfulMetrics (#1889 RC-19)', () => {
  it('key 부재 → null 반환', async () => {
    const kv = new InMemoryKV();
    const result = await readLastSuccessfulMetrics(kv as unknown as KVNamespace);
    expect(result).toBeNull();
  });

  it('tryStore 후 즉시 read 가능 (round-trip)', async () => {
    const kv = new InMemoryKV();
    await tryStoreObservabilityMetrics(kv as unknown as KVNamespace, SAMPLE_METRICS, NOW);
    const result = await readLastSuccessfulMetrics(kv as unknown as KVNamespace);
    expect(result).toEqual(SAMPLE_METRICS);
  });

  it('malformed JSON → null 반환 (caller가 503 응답)', async () => {
    const kv = new InMemoryKV();
    kv.store.set('obs-metrics:last-success', { value: '{not-json' });
    const result = await readLastSuccessfulMetrics(kv as unknown as KVNamespace);
    expect(result).toBeNull();
  });

  it('KV.get throw → null 반환 (caller가 503 응답)', async () => {
    const kv = new FailingPutKV();
    kv.getThrows = true;
    const result = await readLastSuccessfulMetrics(kv as unknown as KVNamespace);
    expect(result).toBeNull();
  });

  it('1h bucket이 만료돼도 last-success는 24h TTL 동안 살아남음', async () => {
    const kv = new InMemoryKV();
    await tryStoreObservabilityMetrics(kv as unknown as KVNamespace, SAMPLE_METRICS, NOW);
    // 1h bucket 만료 시뮬레이션
    const bucketKey = hourBucketKey(NOW);
    const bucketEntry = kv.store.get(bucketKey);
    if (bucketEntry) bucketEntry.expiresAt = Date.now() - 1000;
    // read는 cache miss
    const cached = await readObservabilityMetrics(kv as unknown as KVNamespace, NOW);
    expect(cached).toBeNull();
    // 그러나 last-success는 여전히 유효
    const fallback = await readLastSuccessfulMetrics(kv as unknown as KVNamespace);
    expect(fallback).toEqual(SAMPLE_METRICS);
  });
});
