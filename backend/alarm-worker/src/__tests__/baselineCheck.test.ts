/**
 * baselineCheck.test.ts — #1621 Phase C computeBaselineCheck unit tests.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import { computeBaselineCheck } from '../baselineCheck';
import {
  buildAlarmLogNdjsonFixture,
  makeEmptyFakeR2,
  makeFakeR2,
} from './helpers/r2Fixtures';

const NOW = 1_700_000_000_000;
const TOKEN = 'tok-baseline';

function seedActiveTrip(kv: InMemoryKV, token: string): void {
  kv.store.set(`trip:${token}`, {
    value: JSON.stringify({
      token,
      route: { type: 'direct', line: '2', stops: 3 },
      destination: 'dst',
      waypoints: [],
      expiresAt: NOW + 60 * 60 * 1000,
      alarmAtEpochMs: NOW + 30 * 60 * 1000,
    }),
  });
}

function seedReceivedPush(kv: InMemoryKV, pushId: string): void {
  kv.store.set(`received:${pushId}`, {
    value: JSON.stringify({
      pushId,
      receivedAt: NOW - 60 * 1000,
      stationName: '용마산',
      phase: 'imminent',
    }),
  });
}

function seedPendingPush(kv: InMemoryKV, pushId: string): void {
  kv.store.set(`pending:${pushId}`, {
    value: JSON.stringify({ pushId, sentAt: NOW - 30_000 }),
  });
}

describe('computeBaselineCheck', () => {
  it('pass — silentPushFired > 0 AND v1Mismatch === 0', async () => {
    const kv = new InMemoryKV();
    seedActiveTrip(kv, TOKEN);
    seedReceivedPush(kv, 'p1');
    seedReceivedPush(kv, 'p2');
    seedPendingPush(kv, 'p3');
    const r2 = makeEmptyFakeR2();
    const result = await computeBaselineCheck(kv as unknown as KVNamespace, r2, TOKEN, NOW);
    expect(result.baseline).toBe('pass');
    expect(result.signals.tripActive).toBe(true);
    expect(result.signals.silentPushReceived).toBe(2);
    expect(result.signals.silentPushFired).toBe(3); // 2 received + 1 pending
    expect(result.signals.v1Mismatch).toBe(0);
  });

  it('fail — silentPushFired === 0 (no push at all)', async () => {
    const kv = new InMemoryKV();
    seedActiveTrip(kv, TOKEN);
    const r2 = makeEmptyFakeR2();
    const result = await computeBaselineCheck(kv as unknown as KVNamespace, r2, TOKEN, NOW);
    expect(result.baseline).toBe('fail');
    expect(result.signals.silentPushFired).toBe(0);
    expect(result.signals.tripActive).toBe(true);
  });

  it('fail — v1Mismatch > 0 even with push fired', async () => {
    const kv = new InMemoryKV();
    seedActiveTrip(kv, TOKEN);
    seedReceivedPush(kv, 'p1');
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/a.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'fg-evaluated', outcome: 'suppressed', reason: 'v1-mismatch' },
            { source: 'fg-evaluated', outcome: 'suppressed', reason: 'v1-mismatch' },
          ],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const result = await computeBaselineCheck(kv as unknown as KVNamespace, r2, TOKEN, NOW);
    expect(result.baseline).toBe('fail');
    expect(result.signals.silentPushFired).toBe(1);
    expect(result.signals.v1Mismatch).toBe(2);
  });

  it('reports tripActive=false when token not in KV', async () => {
    const kv = new InMemoryKV();
    // Seed a different token's trip — current token should still be inactive.
    seedActiveTrip(kv, 'other-token');
    seedReceivedPush(kv, 'p1');
    const r2 = makeEmptyFakeR2();
    const result = await computeBaselineCheck(kv as unknown as KVNamespace, r2, TOKEN, NOW);
    expect(result.signals.tripActive).toBe(false);
    // silentPushFired is independent of tripActive — still counts.
    expect(result.signals.silentPushFired).toBe(1);
  });

  it('counts only v1-mismatch reason from alarm log (other reasons ignored)', async () => {
    const kv = new InMemoryKV();
    seedReceivedPush(kv, 'p1');
    const r2 = makeFakeR2([
      {
        key: 'trip-evidence/2026/06/20/m.ndjson',
        tripEndedAt: NOW - 5 * 60 * 1000,
        body: buildAlarmLogNdjsonFixture(
          [
            { source: 'fg', outcome: 'suppressed', reason: 'gate-stale-location' },
            { source: 'fg', outcome: 'suppressed', reason: 'cross-trip-mirror-leak' },
            { source: 'fg-evaluated', outcome: 'suppressed', reason: 'v1-mismatch' },
          ],
          NOW - 5 * 60 * 1000,
        ),
      },
    ]);
    const result = await computeBaselineCheck(kv as unknown as KVNamespace, r2, TOKEN, NOW);
    expect(result.signals.v1Mismatch).toBe(1);
  });
});
