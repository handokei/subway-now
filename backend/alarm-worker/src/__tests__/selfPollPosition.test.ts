/**
 * selfPollPosition.test.ts — #1614 Phase A (S4 #1537) backend self-poll KV stamp + helper.
 * #1828 Phase 5 — station-level arrivals polling.
 */

import { describe, expect, it, vi } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import {
  pollLinesAndStamp,
  readFreshSelfPollPosition,
  readSelfPollPosition,
  selfPollKey,
  SELF_POLL_POSITION_MAX_AGE_SEC,
  SELF_POLL_REFRESH_MS,
  SELF_POLL_TTL_SEC,
  writeSelfPollPosition,
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
              // #2746 — realtimePosition updnLine은 숫자 코드('0'=상행/내선, '1'=하행/외선).
              updnLine: p.isUp ? '0' : '1',
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

  it('pollLinesAndStamp의 내부 cache-hit 체크는 readFreshSelfPollPosition 60s 게이트가 아니라 SELF_POLL_REFRESH_MS(45s)를 쓴다 (#3118)', async () => {
    // #2079 P2 doc — 60s 게이트를 쓰면 cron 60s tick과 겹쳐 지터로 불안정. 45s 임계값은 :45~:46
    // 지터를 흡수하면서 매 tick 재fetch를 보장한다. 30s 전 항목은 여전히 hit.
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const seoul = makeSeoulClient({ positions: [makePosition()] });
    await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
    const putSpy = vi.spyOn(kv, 'put');
    const stats = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW + 30_000);
    expect(putSpy).not.toHaveBeenCalled();
    expect(stats).toEqual({ fetched: 0, cacheHit: 1, error: 0 });
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

  it('#2073/#3118 — 다음 tick(60s 후, TTL 90s 내)도 위치를 재fetch + put 1회 (구: 0 puts, 2-tick 갱신)', async () => {
    // InMemoryKV expiry is wall-clock based — fake timers required to simulate tick spacing.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const kv = new InMemoryKV() as unknown as KVNamespace;
      const seoul = makeSeoulClient({ positions: [makePosition()] });
      await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
      // Next cron tick (60s later) — well within SELF_POLL_TTL_SEC(90s), so entry is still alive:
      // entry는 살아있지만 fetchedAt 60s 경과 ≥ SELF_POLL_REFRESH_MS(45s) → 재fetch + put 1회 (#3118).
      vi.setSystemTime(NOW + 60_000);
      const putSpy = vi.spyOn(kv, 'put');
      const stats = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW + 60_000);
      expect(putSpy).toHaveBeenCalledTimes(1);
      expect(stats).toEqual({ fetched: 1, cacheHit: 0, error: 0 });
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

describe('pollLinesAndStamp 위치 갱신 주기 (#3118, #2073 스펙: 매 tick fetch)', () => {
  function countingSeoul() {
    const seoul = makeSeoulClient({ positions: [makePosition()] });
    const spy = vi.spyOn(seoul, 'fetchPositions');
    return { seoul, spy };
  }

  it('fetchedAt 60s 전 항목 → 재fetch 1회 + put 1회 (cron 1 tick 경과)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await writeSelfPollPosition(kv, '7', [makePosition()], NOW);
    const { seoul, spy } = countingSeoul();
    const putSpy = vi.spyOn(kv, 'put');
    const stats = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW + 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(stats).toEqual({ fetched: 1, cacheHit: 0, error: 0 });
  });

  it('fetchedAt 30s 전 항목 → fetch 0회 (이중 호출 흡수)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await writeSelfPollPosition(kv, '7', [makePosition()], NOW);
    const { seoul, spy } = countingSeoul();
    const stats = await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW + 30_000);
    expect(spy).not.toHaveBeenCalled();
    expect(stats).toEqual({ fetched: 0, cacheHit: 1, error: 0 });
  });

  it('항목 없음 → fetch 1회', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const { seoul, spy } = countingSeoul();
    await pollLinesAndStamp(kv, seoul, new Set(['7']), NOW);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('SELF_POLL_REFRESH_MS는 45s (cron :45~:46 지터 흡수)', () => {
    expect(SELF_POLL_REFRESH_MS).toBe(45_000);
  });

  it('연속 3 tick(60s 간격, 지터 ±1s) 모두 위치 재fetch — 짝수/홀수 tick 무관', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const { seoul, spy } = countingSeoul();
    const ticks = [NOW, NOW + 60_900, NOW + 120_100];
    const results = [];
    for (const t of ticks) {
      results.push(await pollLinesAndStamp(kv, seoul, new Set(['7']), t));
    }
    expect(spy).toHaveBeenCalledTimes(ticks.length);
    expect(results.map((r) => r.fetched)).toEqual([1, 1, 1]);
    expect((await readSelfPollPosition(kv, '7'))?.fetchedAt).toBe(ticks[2]);
  });
});

describe('pollLinesAndStamp 앵커역 출발 기록 (#3155)', () => {
  const TRACKED = new Map([['7', new Set(['용마산'])]]) as ReadonlyMap<string, ReadonlySet<string>>;

  it('같은 stamp(추가 KV write 0)에 stationLogs를 싣는다 — 이전 stamp와 비교해 용마산 출발을 기록', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const putSpy = vi.spyOn(kv, 'put');
    await pollLinesAndStamp(
      kv,
      makeSeoulClient({ positions: [makePosition({ trainCode: '7246', stationName: '용마산', trainSttus: 1 })] }),
      new Set(['7']),
      NOW,
      TRACKED,
    );
    await pollLinesAndStamp(
      kv,
      makeSeoulClient({ positions: [makePosition({ trainCode: '7246', stationName: '중곡', trainSttus: 1 })] }),
      new Set(['7']),
      NOW + 60_000,
      TRACKED,
    );
    // tick당 put 1회 — stationLogs 때문에 별도 write가 늘지 않는다.
    expect(putSpy).toHaveBeenCalledTimes(2);
    const entry = await readSelfPollPosition(kv, '7');
    expect(entry?.stationLogs?.['용마산'].departed).toEqual([
      { trainCode: '7246', isUp: true, departedAt: NOW + 30_000 },
    ]);
  });

  it('추적 역 인자를 안 주면 stationLogs 필드가 없다 (기존 stamp 형태 불변)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await pollLinesAndStamp(kv, makeSeoulClient({ positions: [makePosition()] }), new Set(['7']), NOW);
    const entry = await readSelfPollPosition(kv, '7');
    expect(entry).not.toHaveProperty('stationLogs');
  });
});
