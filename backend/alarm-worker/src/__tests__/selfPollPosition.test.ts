/**
 * selfPollPosition.test.ts — #1614 Phase A (S4 #1537) backend self-poll KV stamp + helper.
 */

import { describe, expect, it, vi } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import {
  pollLinesAndStamp,
  readSelfPollPosition,
  selfPollKey,
  SELF_POLL_TTL_SEC,
  writeSelfPollPosition,
} from '../selfPollPosition';
import { SeoulArrivalClient, type PositionEntry } from '../seoul';

const NOW = 1_700_000_000_000;

function makePosition(overrides: Partial<PositionEntry> = {}): PositionEntry {
  return {
    trainCode: '7246',
    stationName: '용마산',
    trainSttus: 2,
    isUp: true,
    recptnMs: NOW,
    ...overrides,
  };
}

function makeSeoulClient(positions: PositionEntry[]): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async (url: string) => {
      if (url.includes('/realtimePosition/')) {
        return new Response(
          JSON.stringify({
            realtimePositionList: positions.map((p) => ({
              trainNo: p.trainCode,
              statnNm: p.stationName,
              updnLine: p.isUp ? '상행' : '하행',
              trainSttus: p.trainSttus,
              lastRecptnDt: '',
            })),
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch,
  });
}

describe('selfPollKey', () => {
  it('builds stable key for line', () => {
    expect(selfPollKey('7')).toBe('realtime-position:7');
    expect(selfPollKey('bundang')).toBe('realtime-position:bundang');
  });
});

describe('SELF_POLL_TTL_SEC', () => {
  it('meets Cloudflare KV minimum cacheTtl floor (30s)', () => {
    // KV_MIN_CACHE_TTL_SEC=30 [[lesson_cron_cachettl_runtime_constraint]]
    expect(SELF_POLL_TTL_SEC).toBeGreaterThanOrEqual(30);
  });
});

describe('readSelfPollPosition / writeSelfPollPosition round-trip', () => {
  it('returns null when no stamp', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    expect(await readSelfPollPosition(kv, '7')).toBeNull();
  });

  it('round-trips positions + fetchedAt', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const positions = [makePosition()];
    await writeSelfPollPosition(kv, '7', positions, NOW);
    const stamp = await readSelfPollPosition(kv, '7');
    expect(stamp).not.toBeNull();
    expect(stamp?.positions).toEqual(positions);
    expect(stamp?.fetchedAt).toBe(NOW);
  });

  it('returns null when JSON is malformed', async () => {
    const kv = new InMemoryKV();
    kv.store.set(selfPollKey('7'), { value: '{not-json' });
    expect(await readSelfPollPosition(kv as unknown as KVNamespace, '7')).toBeNull();
  });

  it('writes with 30s expirationTtl', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await writeSelfPollPosition(kv, '7', [makePosition()], NOW);
    const entry = (kv as unknown as InMemoryKV).store.get(selfPollKey('7'));
    expect(entry?.expiresAt).toBeDefined();
    // TTL 30s minimum.
    expect(entry!.expiresAt! - Date.now()).toBeGreaterThan(25 * 1000);
  });
});

describe('pollLinesAndStamp', () => {
  it('returns zero counts for empty line set', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient([]);
    const stats = await pollLinesAndStamp(kv, seoul, new Set(), NOW);
    expect(stats).toEqual({ fetched: 0, cacheHit: 0, error: 0 });
  });

  it.each([
    { lines: ['7'], expectedFetched: 1 },
    { lines: ['7', '5'], expectedFetched: 2 },
    { lines: ['7', '5', '2'], expectedFetched: 3 },
  ])('fetches each line once on cache miss (lines=$lines)', async ({ lines, expectedFetched }) => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient([makePosition()]);
    const stats = await pollLinesAndStamp(kv, seoul, new Set(lines), NOW);
    expect(stats.fetched).toBe(expectedFetched);
    expect(stats.cacheHit).toBe(0);
    expect(stats.error).toBe(0);
  });

  it('skips fetch when KV stamp exists (cacheHit++)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient([makePosition()]);
    // First call — fetches.
    await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
    // Second call — KV hit (stamp still alive).
    const second = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW + 1000);
    expect(second).toEqual({ fetched: 0, cacheHit: 1, error: 0 });
  });

  it('stamps fetched positions into KV (caller can readSelfPollPosition)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const positions = [makePosition({ trainCode: '7246' }), makePosition({ trainCode: '7248' })];
    const seoul = makeSeoulClient(positions);
    await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
    const stamp = await readSelfPollPosition(kv, '7');
    expect(stamp).not.toBeNull();
    expect(stamp?.positions.map((p) => p.trainCode).sort()).toEqual(['7246', '7248']);
  });

  it('counts error when Seoul fetch throws', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () => {
        throw new Error('rate-limited');
      }) as unknown as typeof fetch,
    });
    const stats = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
    expect(stats.error).toBe(1);
    expect(stats.fetched).toBe(0);
  });

  it('Promise.allSettled — one line failure does not block others', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    // Custom Seoul fixture: line '7' returns positions, line '5' throws.
    // URL params are encoded — match on encoded canonical name ('5호선' → '5%ED%98%B8%EC%84%A0').
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async (url: string) => {
        if (url.includes(encodeURIComponent('5호선'))) throw new Error('boom');
        return new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const stats = await pollLinesAndStamp(kv, seoul, new Set(['7', '5']), NOW);
    expect(stats.fetched).toBe(1);
    expect(stats.error).toBe(1);
  });

  it('writes through canonicalLineName — unmapped line returns empty positions (counts as fetched)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient([]);
    // unmapped line — SeoulArrivalClient returns empty array (not throw).
    const stats = await pollLinesAndStamp(kv, seoul, new Set(['unmapped-line']), NOW);
    expect(stats.fetched).toBe(1);
    expect(stats.error).toBe(0);
    // KV stamp has empty positions array.
    const stamp = await readSelfPollPosition(kv, 'unmapped-line');
    expect(stamp?.positions).toEqual([]);
  });

  it('counts error when KV write fails after successful fetch', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient([makePosition()]);
    // Spy on KV.put to throw on second call (first call from cron, no second normally).
    const spy = vi.spyOn(kv, 'put').mockRejectedValueOnce(new Error('KV write failed'));
    const stats = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
    expect(stats.error).toBe(1);
    expect(stats.fetched).toBe(0);
    spy.mockRestore();
  });
});
