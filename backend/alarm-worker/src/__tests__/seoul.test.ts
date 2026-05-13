import { describe, expect, it, vi } from 'vitest';
import { SeoulArrivalClient, parseRecptnDt } from '../seoul';

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? status : 500,
    headers: { 'content-type': 'application/json' },
  });
}

const FIXED_NOW = Date.parse('2025-01-15T10:30:00+09:00');

function makeItem(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    barvlDt: '120',
    recptnDt: '2025-01-15 10:30:00',
    updnLine: '상행',
    trainLineNm: '서울행',
    btrainNo: 'T-001',
    subwayNm: '지하철1호선',
    ...overrides,
  };
}

describe('parseRecptnDt', () => {
  it('parses valid KST timestamp', () => {
    expect(parseRecptnDt('2025-01-15 10:30:00')).toBe(FIXED_NOW);
  });
  it('returns 0 for empty / invalid', () => {
    expect(parseRecptnDt('')).toBe(0);
    expect(parseRecptnDt(null)).toBe(0);
    expect(parseRecptnDt('not-a-date')).toBe(0);
  });
});

describe('SeoulArrivalClient', () => {
  it('fetches and parses arrivals', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({ realtimeArrivalList: [makeItem(), makeItem({ updnLine: '하행' })] }),
    );
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const arrivals = await client.fetchArrivals('서울역');
    expect(arrivals).toHaveLength(2);
    expect(arrivals[0].isUp).toBe(true);
    expect(arrivals[1].isUp).toBe(false);
    expect(arrivals[0].arrivalSeconds).toBe(120);
  });

  it('caches within TTL', async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ realtimeArrivalList: [makeItem()] }));
    let now = FIXED_NOW;
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.fetchArrivals('서울역');
    await client.fetchArrivals('서울역');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 16s 후엔 캐시 만료
    now += 16_000;
    await client.fetchArrivals('서울역');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns empty array on http error and short-caches', async () => {
    const fetchImpl = vi.fn(async () => makeResponse({}, false, 500));
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const arrivals = await client.fetchArrivals('서울역');
    expect(arrivals).toEqual([]);
    // 두 번째 호출은 캐시 hit
    await client.fetchArrivals('서울역');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('handles malformed item gracefully', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({ realtimeArrivalList: [null, 'not-an-object', makeItem()] }),
    );
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const arrivals = await client.fetchArrivals('서울역');
    expect(arrivals).toHaveLength(1);
  });

  it('applies recptnDt drift correction and demotes stale data', async () => {
    const staleItem = makeItem({
      barvlDt: '120',
      // 200초 전 데이터 → drift > 120s → stale 처리, drift 보정 없음
      recptnDt: '2025-01-15 10:26:40',
    });
    const fetchImpl = vi.fn(async () => makeResponse({ realtimeArrivalList: [staleItem] }));
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const arrivals = await client.fetchArrivals('서울역');
    expect(arrivals[0].arrivalSeconds).toBe(120);
  });

  it('tracks call count', async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ realtimeArrivalList: [] }));
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.fetchArrivals('A');
    await client.fetchArrivals('B');
    expect(client.stats.callCount).toBe(2);
    expect(client.stats.cacheSize).toBe(2);
  });
});
