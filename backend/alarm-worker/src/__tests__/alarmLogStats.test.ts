/**
 * alarmLogStats.test.ts — #1621 Phase A computeAlarmLogStats unit tests.
 */

import { describe, expect, it } from 'vitest';
import { computeAlarmLogStats } from '../alarmLogStats';
import {
  buildAlarmLogNdjsonFixture,
  makeFakeR2,
  type FakeR2Archive,
} from './helpers/r2Fixtures';

const NOW = 1_700_000_000_000;

describe('computeAlarmLogStats', () => {
  it('returns empty distribution when bucket has no archives', async () => {
    const r2 = makeFakeR2([]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.totalEvents).toBe(0);
    expect(stats.fired).toBe(0);
    expect(stats.suppressed).toBe(0);
    expect(stats.received).toBe(0);
    expect(stats.reasons).toEqual({});
    expect(stats.sources).toEqual({});
    expect(stats.tripsScanned).toBe(0);
    expect(stats.windowStart).toBe(NOW - 60 * 60 * 1000);
    expect(stats.windowEnd).toBe(NOW);
  });

  it('aggregates outcome/reason/source from a single archive', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/aabbccdd-1000.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'silent-push-fired', outcome: 'fired' },
            { source: 'silent-push-skipped', outcome: 'suppressed', reason: 'gate-stale-location' },
            { source: 'silent-push-received', outcome: 'received' },
          ],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.totalEvents).toBe(3);
    expect(stats.fired).toBe(1);
    expect(stats.suppressed).toBe(1);
    expect(stats.received).toBe(1);
    expect(stats.reasons['gate-stale-location']).toBe(1);
    expect(stats.sources['silent-push-fired']).toBe(1);
    expect(stats.sources['silent-push-received']).toBe(1);
    expect(stats.tripsScanned).toBe(1);
  });

  it('aggregates across multiple archives', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/a-1000.ndjson',
        tripEndedAt: NOW - 10 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'fg-arvlcd', outcome: 'fired' },
            { source: 'fg', outcome: 'suppressed', reason: 'cross-trip-mirror-leak' },
          ],
          NOW - 10 * 60 * 1000,
        ),
      },
      {
        key: 'trip-evidence/2026/06/20/b-2000.ndjson',
        tripEndedAt: NOW - 20 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'fg-arvlcd', outcome: 'fired' },
            { source: 'fg-arvlcd', outcome: 'suppressed', reason: 'lockless-forward-only-block' },
          ],
          NOW - 20 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.totalEvents).toBe(4);
    expect(stats.fired).toBe(2);
    expect(stats.suppressed).toBe(2);
    expect(stats.sources['fg-arvlcd']).toBe(3);
    expect(stats.reasons['cross-trip-mirror-leak']).toBe(1);
    expect(stats.reasons['lockless-forward-only-block']).toBe(1);
    expect(stats.tripsScanned).toBe(2);
  });

  it('#1706 — fusionTierLog kind는 sources/reasons 카운터에서 자동 제외', async () => {
    // ndjson에 alarmLog 1 entry + fusionTierLog 5 entry. stats는 alarmLog kind만 카운트해야 함.
    const tripEndedAt = NOW - 5 * 60 * 1000;
    const body = [
      JSON.stringify({ kind: 'header', tripEndedAt }),
      JSON.stringify({
        kind: 'alarmLog',
        entries: [{ source: 'silent-push-received', outcome: 'received' }],
      }),
      JSON.stringify({
        kind: 'fusionTierLog',
        entries: [
          { ts: 1, tier: 'gpsFallback' },
          { ts: 2, tier: 'gpsFallback' },
          { ts: 3, tier: 'gpsFallback' },
          { ts: 4, tier: 'backendSsotAccepts' },
          { ts: 5, tier: 'backendSsotAccepts' },
        ],
      }),
    ].join('\n');
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/aabbccdd-1000.ndjson',
        tripEndedAt,
        body,
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    // alarmLog 1건만 반영. fusionTierLog 5건은 카운터에 추가되지 않는다.
    expect(stats.totalEvents).toBe(1);
    expect(stats.received).toBe(1);
    expect(stats.sources['silent-push-received']).toBe(1);
    expect(stats.sources['fusion-picker-tier']).toBeUndefined();
    expect(stats.reasons['tier-gpsFallback']).toBeUndefined();
    expect(stats.reasons['tier-backendSsotAccepts']).toBeUndefined();
  });

  it('excludes archives outside windowHours window', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/old.ndjson',
        tripEndedAt: NOW - 2 * 60 * 60 * 1000, // 2h ago — outside default 1h
        body: buildAlarmLogNdjsonFixture(
          [{ source: 'fg-arvlcd', outcome: 'fired' }],
          NOW - 2 * 60 * 60 * 1000,
        ),
      },
      {
        key: 'trip-evidence/2026/06/20/recent.ndjson',
        tripEndedAt: NOW - 10 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [{ source: 'fg-arvlcd', outcome: 'fired' }],
          NOW - 10 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.totalEvents).toBe(1);
    expect(stats.tripsScanned).toBe(1);
  });

  it.each([
    {
      label: 'windowHours=6 includes 3h-ago archive',
      windowHours: 6,
      expectTotalEvents: 1,
      expectWindowStart: NOW - 6 * 60 * 60 * 1000,
    },
    {
      label: 'windowHours=99 clamped to 24h max — still includes',
      windowHours: 99,
      expectTotalEvents: 1,
      expectWindowStart: NOW - 24 * 60 * 60 * 1000,
    },
    {
      label: 'windowHours=0 clamped to 1h min — excludes 3h-ago archive',
      windowHours: 0,
      expectTotalEvents: 0,
      expectWindowStart: NOW - 60 * 60 * 1000,
    },
  ])('respects custom windowHours ($label)', async ({ windowHours, expectTotalEvents, expectWindowStart }) => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/k.ndjson',
        tripEndedAt: NOW - 3 * 60 * 60 * 1000, // 3h ago
        body: buildAlarmLogNdjsonFixture(
          [{ source: 'fg-arvlcd', outcome: 'fired' }],
          NOW - 3 * 60 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW, windowHours);
    expect(stats.totalEvents).toBe(expectTotalEvents);
    expect(stats.windowStart).toBe(expectWindowStart);
  });

  it('skips archives without tripEndedAt metadata', async () => {
    const r2 = {
      async list() {
        return {
          objects: [{ key: 'k1', customMetadata: undefined }],
          truncated: false,
          cursor: undefined,
        };
      },
      async get() { throw new Error('should not be called'); },
    } as unknown as R2Bucket;
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.totalEvents).toBe(0);
    expect(stats.tripsScanned).toBe(0);
  });

  it('handles malformed ndjson lines and non-alarmLog kinds gracefully', async () => {
    const malformedBody = [
      '{not-json',
      JSON.stringify({ kind: 'header' }),
      JSON.stringify({ kind: 'alarmLog', entries: [{ source: 'fg', outcome: 'fired' }] }),
      JSON.stringify({ kind: 'alarmLog', entries: 'not-array' }),
      JSON.stringify({ kind: 'fusionLog', entries: [{ source: 'should-be-ignored' }] }),
      '',
    ].join('\n');
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/mixed.ndjson',
        tripEndedAt: NOW - 1000,
        body: malformedBody,
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.totalEvents).toBe(1);
    expect(stats.fired).toBe(1);
    expect(stats.sources['fg']).toBe(1);
  });

  it('caps tripsScanned at limit (R2 cost protection)', async () => {
    const archives: FakeR2Archive[] = [];
    for (let i = 0; i < 20; i++) {
      archives.push({
        key: `trip-evidence/2026/06/20/t-${i}.ndjson`,
        tripEndedAt: NOW - 1000,
        body: buildAlarmLogNdjsonFixture(
          [{ source: 'fg', outcome: 'fired' }],
          NOW - 1000,
        ),
      });
    }
    const r2 = makeFakeR2(archives);
    const stats = await computeAlarmLogStats(r2, NOW, 1, 5);
    expect(stats.tripsScanned).toBeLessThanOrEqual(5);
    expect(stats.totalEvents).toBeLessThanOrEqual(5);
  });

  it('paginates R2 list with cursor across multiple pages', async () => {
    const archives: FakeR2Archive[] = [];
    for (let i = 0; i < 6; i++) {
      archives.push({
        key: `trip-evidence/2026/06/20/p-${i}.ndjson`,
        tripEndedAt: NOW - 1000,
        body: buildAlarmLogNdjsonFixture(
          [{ source: 'fg', outcome: 'fired' }],
          NOW - 1000,
        ),
      });
    }
    // pageSize=2로 강제해 cursor traversal 검증.
    const r2 = makeFakeR2(archives, 2);
    const stats = await computeAlarmLogStats(r2, NOW, 1, 6);
    expect(stats.tripsScanned).toBe(6);
  });

  it('truncates reasons/sources to top-20 per response size guard', async () => {
    const entries: Array<{ source: string; outcome: string; reason: string }> = [];
    for (let i = 0; i < 25; i++) {
      entries.push({
        source: `src-${i}`,
        outcome: 'suppressed',
        reason: `reason-${i}`,
      });
    }
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/many.ndjson',
        tripEndedAt: NOW - 1000,
        body: buildAlarmLogNdjsonFixture(entries, NOW - 1000),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(Object.keys(stats.reasons).length).toBe(20);
    expect(Object.keys(stats.sources).length).toBe(20);
  });

  it('ignores archives with empty alarmLog entries (no tripsScanned bump)', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/empty.ndjson',
        tripEndedAt: NOW - 1000,
        body: buildAlarmLogNdjsonFixture([], NOW - 1000),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.totalEvents).toBe(0);
    expect(stats.tripsScanned).toBe(0);
  });

  it('handles R2 get returning null (object deleted mid-scan)', async () => {
    const r2 = {
      async list() {
        return {
          objects: [
            {
              key: 'trip-evidence/2026/06/20/missing.ndjson',
              customMetadata: { tripEndedAt: String(NOW - 1000) },
            },
          ],
          truncated: false,
          cursor: undefined,
        };
      },
      async get() { return null; },
    } as unknown as R2Bucket;
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.totalEvents).toBe(0);
    expect(stats.tripsScanned).toBe(0);
  });

  it('skips entries with non-string source/outcome/reason fields', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/typed.ndjson',
        tripEndedAt: NOW - 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: '', outcome: 'fired' }, // empty source dropped from sources
            { source: 'fg', outcome: '' }, // empty outcome dropped from outcomes
            { source: 'fg', outcome: 'fired', reason: '' }, // empty reason dropped
          ] as Array<{ source?: string; outcome?: string; reason?: string }>,
          NOW - 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    // 3 entries total; outcomes recognised: fired=2 (first + third)
    expect(stats.totalEvents).toBe(3);
    expect(stats.fired).toBe(2);
    expect(stats.sources['fg']).toBe(2);
    expect(stats.sources['']).toBeUndefined();
    expect(stats.reasons['']).toBeUndefined();
  });

  // ── #1769 accelPatternCounts ─────────────────────────────────────────────────

  it('#1769 — accel-pattern-observed entries → accelPatternCounts 집계', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/24/accel-1000.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'automotive' },
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'automotive' },
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'walking' },
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'stationary' },
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'unknown' },
            { source: 'fg', outcome: 'fired' }, // 다른 source → accelPattern 집계 제외
          ],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.accelPatternCounts.automotive).toBe(2);
    expect(stats.accelPatternCounts.walking).toBe(1);
    expect(stats.accelPatternCounts.stationary).toBe(1);
    expect(stats.accelPatternCounts.unknown).toBe(1);
  });

  it('#1769 — accel-pattern-observed entries 없으면 accelPatternCounts 모두 0', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/24/no-accel-1000.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [{ source: 'fg', outcome: 'fired' }],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.accelPatternCounts).toEqual({ automotive: 0, walking: 0, stationary: 0, unknown: 0 });
  });

  it('#1769 — 알 수 없는 stationName은 accelPatternCounts에 포함 안 됨', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/24/invalid-accel-1000.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'invalid-pattern' },
            { source: 'accel-pattern-observed', outcome: 'received', stationName: 'automotive' },
          ],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.accelPatternCounts.automotive).toBe(1);
    // 'invalid-pattern'은 포함되지 않아야 하므로 나머지 합계는 1
    const total = stats.accelPatternCounts.automotive + stats.accelPatternCounts.walking +
      stats.accelPatternCounts.stationary + stats.accelPatternCounts.unknown;
    expect(total).toBe(1);
  });

  // ── #1503 boardableLookupCounts ──────────────────────────────────────────────

  it('#1503 — boardable-lookup outcome="received" → boardableLookupCounts.ok, "suppressed" → miss', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/24/boardable-1000.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'boardable-lookup', outcome: 'received', stationName: '왕십리' },
            { source: 'boardable-lookup', outcome: 'received', stationName: '종로3가' },
            { source: 'boardable-lookup', outcome: 'suppressed', stationName: '사당' },
            // 다른 source → boardable 집계 제외
            { source: 'fg', outcome: 'fired' },
          ],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.boardableLookupCounts.ok).toBe(2);
    expect(stats.boardableLookupCounts.miss).toBe(1);
  });

  it('#1503 — boardable-lookup entries 없으면 boardableLookupCounts 모두 0', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/24/no-boardable-1000.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [{ source: 'fg', outcome: 'fired' }],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.boardableLookupCounts).toEqual({ ok: 0, miss: 0 });
  });

  it('#1503 — boardable-lookup outcome="fired" 등 예상 외 값은 집계 제외', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/24/invalid-boardable-1000.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'boardable-lookup', outcome: 'fired', stationName: '종로3가' },
            { source: 'boardable-lookup', outcome: 'received', stationName: '왕십리' },
          ],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    // 'fired'는 ok/miss 어느 슬롯에도 들어가지 않음
    expect(stats.boardableLookupCounts.ok).toBe(1);
    expect(stats.boardableLookupCounts.miss).toBe(0);
  });

  // ── #1957 groundTruthCounts ──────────────────────────────────────────────────

  it('#1957 — ground-truth-response outcome="fired"=yes, "suppressed"=no, "received"=pending', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/gt-1000.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'ground-truth-response', outcome: 'fired', stationName: 'gt-yes' },
            { source: 'ground-truth-response', outcome: 'fired', stationName: 'gt-yes' },
            { source: 'ground-truth-response', outcome: 'suppressed', stationName: 'gt-no' },
            { source: 'ground-truth-response', outcome: 'received', stationName: 'gt-pending' },
            // 다른 source → groundTruth 집계 제외
            { source: 'fg', outcome: 'fired' },
          ],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.groundTruthCounts.yes).toBe(2);
    expect(stats.groundTruthCounts.no).toBe(1);
    expect(stats.groundTruthCounts.pending).toBe(1);
  });

  it('#1957 — ground-truth-response entries 없으면 groundTruthCounts 모두 0', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/no-gt-1000.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [{ source: 'fg', outcome: 'fired' }],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.groundTruthCounts).toEqual({ yes: 0, no: 0, pending: 0 });
  });

  it('#1957 — ground-truth-response outcome 예상 외 값은 어느 슬롯에도 들어가지 않음', async () => {
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/28/invalid-gt-1000.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            // 'aborted'는 yes/no/pending 어느 슬롯에도 들어가지 않음
            { source: 'ground-truth-response', outcome: 'aborted', stationName: 'gt-x' },
            { source: 'ground-truth-response', outcome: 'fired', stationName: 'gt-yes' },
          ],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const stats = await computeAlarmLogStats(r2, NOW);
    expect(stats.groundTruthCounts.yes).toBe(1);
    expect(stats.groundTruthCounts.no).toBe(0);
    expect(stats.groundTruthCounts.pending).toBe(0);
  });
});
