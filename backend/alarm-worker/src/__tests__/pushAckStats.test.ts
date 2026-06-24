/**
 * pushAckStats.test.ts — #1614 Phase D (S4 #1537) admin push-ack-stats RCA endpoint helper.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import { computePushAckStats } from '../pushAckStats';

const NOW = 1_700_000_000_000;

function seedReceivedStamp(
  kv: InMemoryKV,
  pushId: string,
  receivedAt: number,
  phase: string,
  stationName: string,
  permissionMode?: 'always' | 'whileInUse' | 'denied',
): void {
  const entry: Record<string, unknown> = { pushId, receivedAt, stationName, phase };
  if (permissionMode !== undefined) entry.permissionMode = permissionMode;
  kv.store.set(`received:${pushId}`, { value: JSON.stringify(entry) });
}

function seedPending(kv: InMemoryKV, pushId: string): void {
  kv.store.set(`pending:${pushId}`, {
    value: JSON.stringify({ pushId, sentAt: NOW - 30_000 }),
  });
}

describe('computePushAckStats', () => {
  it('empty KV → zero counts', async () => {
    const kv = new InMemoryKV();
    const stats = await computePushAckStats(kv as unknown as KVNamespace, NOW);
    expect(stats.received).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.receivedByPhase).toEqual({});
    expect(stats.receivedByStation).toEqual({});
    expect(stats.receivedByPermissionMode).toEqual({ always: 0, whileInUse: 0, denied: 0, unknown: 0 });
  });

  it('counts received stamps within 1h window', async () => {
    const kv = new InMemoryKV();
    seedReceivedStamp(kv, 'p1', NOW - 30 * 60 * 1000, 'imminent', '중곡'); // 30min ago
    seedReceivedStamp(kv, 'p2', NOW - 5 * 60 * 1000, 'imminent', '용마산'); // 5min ago
    const stats = await computePushAckStats(kv as unknown as KVNamespace, NOW);
    expect(stats.received).toBe(2);
    expect(stats.windowStart).toBe(NOW - 60 * 60 * 1000);
    expect(stats.windowEnd).toBe(NOW);
  });

  it('excludes received stamps outside window', async () => {
    const kv = new InMemoryKV();
    seedReceivedStamp(kv, 'p-old', NOW - 2 * 60 * 60 * 1000, 'imminent', '중곡'); // 2h ago
    seedReceivedStamp(kv, 'p-new', NOW - 10 * 60 * 1000, 'imminent', '중곡');
    const stats = await computePushAckStats(kv as unknown as KVNamespace, NOW);
    expect(stats.received).toBe(1);
  });

  it.each([
    {
      label: 'single phase',
      stamps: [
        { id: 'p1', phase: 'imminent', station: 'A' },
        { id: 'p2', phase: 'imminent', station: 'B' },
      ],
      expectedByPhase: { imminent: 2 },
    },
    {
      label: 'multiple phases',
      stamps: [
        { id: 'p1', phase: 'imminent', station: 'A' },
        { id: 'p2', phase: 'transfer', station: 'B' },
        { id: 'p3', phase: 'imminent', station: 'C' },
      ],
      expectedByPhase: { imminent: 2, transfer: 1 },
    },
  ])('groups receivedByPhase ($label)', async ({ stamps, expectedByPhase }) => {
    const kv = new InMemoryKV();
    for (const s of stamps) {
      seedReceivedStamp(kv, s.id, NOW - 10_000, s.phase, s.station);
    }
    const stats = await computePushAckStats(kv as unknown as KVNamespace, NOW);
    expect(stats.receivedByPhase).toEqual(expectedByPhase);
  });

  it('groups receivedByStation with top-10 truncation', async () => {
    const kv = new InMemoryKV();
    // Seed 15 stations with varying counts.
    for (let i = 0; i < 15; i++) {
      for (let j = 0; j <= i; j++) {
        seedReceivedStamp(kv, `p-${i}-${j}`, NOW - 5_000, 'imminent', `Station${i}`);
      }
    }
    const stats = await computePushAckStats(kv as unknown as KVNamespace, NOW);
    // Top-10 stations only.
    expect(Object.keys(stats.receivedByStation)).toHaveLength(10);
    // Highest count (Station14, 15 stamps) is included.
    expect(stats.receivedByStation['Station14']).toBe(15);
  });

  it('counts pending entries (TTL alive in-flight pushes)', async () => {
    const kv = new InMemoryKV();
    seedPending(kv, 'p1');
    seedPending(kv, 'p2');
    seedPending(kv, 'p3');
    const stats = await computePushAckStats(kv as unknown as KVNamespace, NOW);
    expect(stats.pending).toBe(3);
  });

  it('caps at limit (KV cost protection)', async () => {
    const kv = new InMemoryKV();
    for (let i = 0; i < 50; i++) {
      seedReceivedStamp(kv, `p-${i}`, NOW - 1000, 'imminent', `S${i}`);
    }
    const stats = await computePushAckStats(kv as unknown as KVNamespace, NOW, 10);
    expect(stats.received).toBeLessThanOrEqual(10);
  });

  it('skips malformed JSON entries gracefully', async () => {
    const kv = new InMemoryKV();
    kv.store.set('received:bad', { value: '{not-json' });
    seedReceivedStamp(kv, 'good', NOW - 1000, 'imminent', '중곡');
    const stats = await computePushAckStats(kv as unknown as KVNamespace, NOW);
    expect(stats.received).toBe(1);
  });

  describe('#1768 — receivedByPermissionMode 집계', () => {
    it('permissionMode 있는 stamp → 해당 버킷 증가', async () => {
      const kv = new InMemoryKV();
      seedReceivedStamp(kv, 'p1', NOW - 1000, 'imminent', '강남', 'always');
      seedReceivedStamp(kv, 'p2', NOW - 1000, 'imminent', '강남', 'whileInUse');
      seedReceivedStamp(kv, 'p3', NOW - 1000, 'imminent', '강남', 'denied');
      const stats = await computePushAckStats(kv as unknown as KVNamespace, NOW);
      expect(stats.receivedByPermissionMode).toEqual({ always: 1, whileInUse: 1, denied: 1, unknown: 0 });
    });

    it('permissionMode 없는 legacy stamp → unknown 버킷', async () => {
      const kv = new InMemoryKV();
      seedReceivedStamp(kv, 'p-legacy', NOW - 1000, 'imminent', '강남'); // permissionMode 없음
      const stats = await computePushAckStats(kv as unknown as KVNamespace, NOW);
      expect(stats.receivedByPermissionMode).toEqual({ always: 0, whileInUse: 0, denied: 0, unknown: 1 });
    });

    it.each([
      { label: 'always 단독', modes: ['always', 'always'] as const, expected: { always: 2, whileInUse: 0, denied: 0, unknown: 0 } },
      { label: '혼합', modes: ['always', 'whileInUse', 'denied'] as const, expected: { always: 1, whileInUse: 1, denied: 1, unknown: 0 } },
    ])('$label → 버킷 정확히 집계', async ({ modes, expected }) => {
      const kv = new InMemoryKV();
      for (let i = 0; i < modes.length; i++) {
        seedReceivedStamp(kv, `p-${i}`, NOW - 1000, 'imminent', '강남', modes[i]);
      }
      const stats = await computePushAckStats(kv as unknown as KVNamespace, NOW);
      expect(stats.receivedByPermissionMode).toEqual(expected);
    });
  });
});
