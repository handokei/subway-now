/**
 * selfPollPosition.test.ts — #1614 Phase A (S4 #1537) backend self-poll KV stamp + helper.
 * #1828 Phase 5 — station-level arrivals polling.
 */

import { describe, expect, it, vi } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import {
  N_STATION_LOOKAHEAD,
  pollLinesAndStamp,
  pollStationsAndStamp,
  readFreshSelfPollPosition,
  readSelfPollPosition,
  readSelfPollStationArrivals,
  selfPollKey,
  selfPollStationKey,
  SELF_POLL_POSITION_MAX_AGE_SEC,
  SELF_POLL_TTL_SEC,
  writeSelfPollPosition,
  writeSelfPollStationArrivals,
} from '../selfPollPosition';
import { SeoulArrivalClient, type ArrivalEntry, type PositionEntry } from '../seoul';

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

function makeArrival(overrides: Partial<ArrivalEntry> = {}): ArrivalEntry {
  return {
    destination: '성수행',
    arrivalSeconds: 90,
    trainCode: '7246',
    isUp: true,
    subwayNm: '지하철2호선',
    arvlCd: 2,
    ...overrides,
  };
}

function makeSeoulClient(options: {
  positions?: PositionEntry[];
  arrivals?: ArrivalEntry[];
} = {}): SeoulArrivalClient {
  const positions = options.positions ?? [];
  const arrivals = options.arrivals ?? [];
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
      if (url.includes('/realtimeStationArrival/')) {
        return new Response(
          JSON.stringify({
            realtimeArrivalList: arrivals.map((a) => ({
              barvlDt: String(a.arrivalSeconds),
              recptnDt: '',
              updnLine: a.isUp ? '상행' : '하행',
              trainLineNm: a.destination,
              btrainNo: a.trainCode,
              subwayNm: a.subwayNm,
              arvlCd: a.arvlCd,
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

describe('selfPollStationKey (#1828)', () => {
  it('builds stable key for station name', () => {
    expect(selfPollStationKey('신도림')).toBe('selfPoll:station:신도림');
    expect(selfPollStationKey('강남')).toBe('selfPoll:station:강남');
  });
});

describe('N_STATION_LOOKAHEAD (#1828)', () => {
  it('is a positive integer between 3 and 10', () => {
    expect(N_STATION_LOOKAHEAD).toBeGreaterThanOrEqual(3);
    expect(N_STATION_LOOKAHEAD).toBeLessThanOrEqual(10);
    expect(Number.isInteger(N_STATION_LOOKAHEAD)).toBe(true);
  });
});

describe('SELF_POLL_TTL_SEC', () => {
  it('meets Cloudflare KV minimum cacheTtl floor (30s)', () => {
    // KV_MIN_CACHE_TTL_SEC=30 [[lesson_cron_cachettl_runtime_constraint]]
    expect(SELF_POLL_TTL_SEC).toBeGreaterThanOrEqual(30);
  });

  it('#2073 (Issue TTL) — exceeds cron nominal interval (60s) so a stamp survives into the next tick', () => {
    // 30s < 60s cron 주기라 매 tick 강제 재fetch/재write 를 유발하던 회귀(#2073) 방지.
    const CRON_NOMINAL_INTERVAL_SEC = 60;
    expect(SELF_POLL_TTL_SEC).toBeGreaterThan(CRON_NOMINAL_INTERVAL_SEC);
    expect(SELF_POLL_TTL_SEC).toBe(90);
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

  it('writes with SELF_POLL_TTL_SEC (90s) expirationTtl', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await writeSelfPollPosition(kv, '7', [makePosition()], NOW);
    const entry = (kv as unknown as InMemoryKV).store.get(selfPollKey('7'));
    expect(entry?.expiresAt).toBeDefined();
    expect(entry!.expiresAt! - Date.now()).toBeGreaterThan(85 * 1000);
  });
});

describe('readFreshSelfPollPosition (#2079 P2 — staleness 게이트)', () => {
  it('meets floor of 60s', () => {
    expect(SELF_POLL_POSITION_MAX_AGE_SEC).toBe(60);
  });

  it('returns null when no stamp', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    expect(await readFreshSelfPollPosition(kv, '7', NOW)).toBeNull();
  });

  it('fetchedAt 59s 전 — positions 반환 (TTL 90s 안쪽이고 staleness 게이트도 통과)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const positions = [makePosition()];
    await writeSelfPollPosition(kv, '7', positions, NOW);
    const stamp = await readFreshSelfPollPosition(kv, '7', NOW + 59_000);
    expect(stamp).not.toBeNull();
    expect(stamp?.positions).toEqual(positions);
  });

  it('fetchedAt 61s 전 — undefined 취급 (KV TTL 90s 안쪽이라도 stale로 게이트)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await writeSelfPollPosition(kv, '7', [makePosition()], NOW);
    const stamp = await readFreshSelfPollPosition(kv, '7', NOW + 61_000);
    expect(stamp).toBeNull();
  });

  it('pollLinesAndStamp의 내부 cache-hit 체크(raw readSelfPollPosition)는 60s 게이트 영향 없음 — write 감축 유지', async () => {
    // #2079 P2 doc — readFreshSelfPollPosition의 staleness 게이트를 pollLinesAndStamp의 내부
    // existing 체크에 적용하면 cron 60s tick과 60s 임계값이 겹쳐 #2073 회귀(매 tick 재fetch)가
    // 재발한다. raw readSelfPollPosition은 게이트 없이 TTL(90s)만 본다.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const kv = new InMemoryKV() as unknown as KVNamespace;
      const seoul = makeSeoulClient({ positions: [makePosition()] });
      await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
      // 61s 후 — readFreshSelfPollPosition consumer 관점에선 stale이지만, raw reader는 여전히
      // TTL(90s) 안쪽이라 cache-hit → 재fetch/재write 없음.
      vi.setSystemTime(NOW + 61_000);
      const putSpy = vi.spyOn(kv, 'put');
      const stats = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW + 61_000);
      expect(putSpy).not.toHaveBeenCalled();
      expect(stats).toEqual({ fetched: 0, cacheHit: 1, error: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('readSelfPollStationArrivals / writeSelfPollStationArrivals round-trip (#1828)', () => {
  it('returns null when no stamp', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    expect(await readSelfPollStationArrivals(kv, '신도림')).toBeNull();
  });

  it('round-trips arrivals + fetchedAt', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const arrivals = [makeArrival()];
    await writeSelfPollStationArrivals(kv, '신도림', arrivals, NOW);
    const stamp = await readSelfPollStationArrivals(kv, '신도림');
    expect(stamp).not.toBeNull();
    expect(stamp?.arrivals).toEqual(arrivals);
    expect(stamp?.fetchedAt).toBe(NOW);
  });

  it('returns null when JSON is malformed', async () => {
    const kv = new InMemoryKV();
    kv.store.set(selfPollStationKey('신도림'), { value: '{broken-json' });
    expect(await readSelfPollStationArrivals(kv as unknown as KVNamespace, '신도림')).toBeNull();
  });

  it('writes with SELF_POLL_TTL_SEC (90s) expirationTtl', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await writeSelfPollStationArrivals(kv, '신도림', [makeArrival()], NOW);
    const entry = (kv as unknown as InMemoryKV).store.get(selfPollStationKey('신도림'));
    expect(entry?.expiresAt).toBeDefined();
    expect(entry!.expiresAt! - Date.now()).toBeGreaterThan(85 * 1000);
  });

  it('stamps empty arrivals gracefully (fallback path)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await writeSelfPollStationArrivals(kv, '강남', [], NOW);
    const stamp = await readSelfPollStationArrivals(kv, '강남');
    expect(stamp?.arrivals).toEqual([]);
  });
});

describe('pollLinesAndStamp', () => {
  it('returns zero counts for empty line set', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient();
    const stats = await pollLinesAndStamp(kv, seoul, new Set(), NOW);
    expect(stats).toEqual({ fetched: 0, cacheHit: 0, error: 0 });
  });

  it.each([
    { lines: ['7'], expectedFetched: 1 },
    { lines: ['7', '5'], expectedFetched: 2 },
    { lines: ['7', '5', '2'], expectedFetched: 3 },
  ])('fetches each line once on cache miss (lines=$lines)', async ({ lines, expectedFetched }) => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient({ positions: [makePosition()] });
    const stats = await pollLinesAndStamp(kv, seoul, new Set(lines), NOW);
    expect(stats.fetched).toBe(expectedFetched);
    expect(stats.cacheHit).toBe(0);
    expect(stats.error).toBe(0);
  });

  it('skips fetch when KV stamp exists (cacheHit++)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient({ positions: [makePosition()] });
    // First call — fetches.
    await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
    // Second call — KV hit (stamp still alive).
    const second = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW + 1000);
    expect(second).toEqual({ fetched: 0, cacheHit: 1, error: 0 });
  });

  it('stamps fetched positions into KV (caller can readSelfPollPosition)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const positions = [makePosition({ trainCode: '7246' }), makePosition({ trainCode: '7248' })];
    const seoul = makeSeoulClient({ positions });
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
    const seoul = makeSeoulClient();
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
    const seoul = makeSeoulClient({ positions: [makePosition()] });
    // Spy on KV.put to throw on second call (first call from cron, no second normally).
    const spy = vi.spyOn(kv, 'put').mockRejectedValueOnce(new Error('KV write failed'));
    const stats = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
    expect(stats.error).toBe(1);
    expect(stats.fetched).toBe(0);
    spy.mockRestore();
  });

  it('#2073 (Issue TTL) — re-received (within TTL) tick performs 0 KV puts', async () => {
    // InMemoryKV expiry is wall-clock based — fake timers required to simulate tick spacing.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const kv = new InMemoryKV() as unknown as KVNamespace;
      const seoul = makeSeoulClient({ positions: [makePosition()] });
      await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
      // Next cron tick (60s later) — well within SELF_POLL_TTL_SEC(90s), so entry is still alive:
      // existing !== null → cache-hit → fetch and put both skipped (0 writes this tick).
      vi.setSystemTime(NOW + 60_000);
      const putSpy = vi.spyOn(kv, 'put');
      const stats = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW + 60_000);
      expect(putSpy).not.toHaveBeenCalled();
      expect(stats).toEqual({ fetched: 0, cacheHit: 1, error: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('#2073 (Issue TTL) — tick after TTL expiry re-fetches and puts exactly once', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const kv = new InMemoryKV() as unknown as KVNamespace;
      const seoul = makeSeoulClient({ positions: [makePosition()] });
      await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
      // 91s later — past SELF_POLL_TTL_SEC(90s), entry naturally expired → cache-miss → 1 put.
      vi.setSystemTime(NOW + 91_000);
      const putSpy = vi.spyOn(kv, 'put');
      const stats = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW + 91_000);
      expect(putSpy).toHaveBeenCalledTimes(1);
      expect(stats.fetched).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pollStationsAndStamp (#1828 Phase 5)', () => {
  it('returns zero counts for empty station set', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient();
    const stats = await pollStationsAndStamp(kv, seoul, new Set(), NOW);
    expect(stats).toEqual({ fetched: 0, cacheHit: 0, error: 0 });
  });

  it.each([
    { stations: ['신도림'], expectedFetched: 1 },
    { stations: ['신도림', '강남'], expectedFetched: 2 },
    { stations: ['신도림', '강남', '홍대입구'], expectedFetched: 3 },
  ])('fetches each station once on cache miss (stations=$stations)', async ({ stations, expectedFetched }) => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient({ arrivals: [makeArrival()] });
    const stats = await pollStationsAndStamp(kv, seoul, new Set(stations), NOW);
    expect(stats.fetched).toBe(expectedFetched);
    expect(stats.cacheHit).toBe(0);
    expect(stats.error).toBe(0);
  });

  it('skips fetch when KV stamp exists (cacheHit++)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient({ arrivals: [makeArrival()] });
    // First call — fetches.
    await pollStationsAndStamp(kv, seoul, new Set(['신도림']), NOW);
    // Second call — KV hit.
    const second = await pollStationsAndStamp(kv, seoul, new Set(['신도림']), NOW + 1000);
    expect(second).toEqual({ fetched: 0, cacheHit: 1, error: 0 });
  });

  it('stamps fetched arrivals into KV (caller can readSelfPollStationArrivals)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const arrivals = [makeArrival({ trainCode: 'A' }), makeArrival({ trainCode: 'B' })];
    const seoul = makeSeoulClient({ arrivals });
    await pollStationsAndStamp(kv, seoul, new Set(['신도림']), NOW);
    const stamp = await readSelfPollStationArrivals(kv, '신도림');
    expect(stamp).not.toBeNull();
    expect(stamp?.arrivals.map((a) => a.trainCode).sort()).toEqual(['A', 'B']);
  });

  it('stamps empty arrivals on Seoul empty response (graceful fallback)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient({ arrivals: [] });
    const stats = await pollStationsAndStamp(kv, seoul, new Set(['신도림']), NOW);
    expect(stats.fetched).toBe(1);
    expect(stats.error).toBe(0);
    const stamp = await readSelfPollStationArrivals(kv, '신도림');
    expect(stamp?.arrivals).toEqual([]);
  });

  it('counts error when Seoul fetchArrivals throws', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () => {
        throw new Error('network-error');
      }) as unknown as typeof fetch,
    });
    const stats = await pollStationsAndStamp(kv, seoul, new Set(['신도림']), NOW);
    expect(stats.error).toBe(1);
    expect(stats.fetched).toBe(0);
  });

  it('Promise.allSettled — one station failure does not block others', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async (url: string) => {
        if (url.includes(encodeURIComponent('강남'))) throw new Error('boom');
        return new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const stats = await pollStationsAndStamp(kv, seoul, new Set(['신도림', '강남']), NOW);
    expect(stats.fetched).toBe(1);
    expect(stats.error).toBe(1);
  });

  it('counts error when KV write fails after successful fetch', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient({ arrivals: [makeArrival()] });
    const spy = vi.spyOn(kv, 'put').mockRejectedValueOnce(new Error('KV write failed'));
    const stats = await pollStationsAndStamp(kv, seoul, new Set(['신도림']), NOW);
    expect(stats.error).toBe(1);
    expect(stats.fetched).toBe(0);
    spy.mockRestore();
  });

  it('dedup across multiple stations in same set — each station fetched once', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 }),
    );
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const stats = await pollStationsAndStamp(
      kv,
      seoul,
      new Set(['신도림', '강남', '홍대입구']),
      NOW,
    );
    expect(stats.fetched).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
