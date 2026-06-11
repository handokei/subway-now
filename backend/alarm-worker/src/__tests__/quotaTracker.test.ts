/**
 * quotaTracker.ts 테스트 (#1022).
 *
 * KV를 InMemoryKV로 대체해 외부 의존 없이 결정적으로 검증.
 * - isoDateUtc / quotaKey 순수 함수
 * - readDailyCount: 키 없음 / 숫자 / 손상값
 * - incrementDailyRequestCount: 단순 증가 / 80% 임계 crossing / webhook 발사 / 연속 crossing 방지
 * - getQuotaStatus: 비율 계산 / warning 플래그
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DAILY_REQUEST_LIMIT,
  QUOTA_WARN_THRESHOLD,
  getQuotaStatus,
  incrementDailyRequestCount,
  isoDateUtc,
  quotaKey,
  readDailyCount,
} from '../quotaTracker';
import { InMemoryKV } from './inMemoryKv';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeKv(): KVNamespace {
  return new InMemoryKV() as unknown as KVNamespace;
}

/** 임계 직전 카운트로 KV를 초기화한다 */
async function seedCount(kv: KVNamespace, dateStr: string, count: number): Promise<void> {
  const kv_ = kv as unknown as InMemoryKV;
  kv_.store.set(quotaKey(dateStr), { value: String(count) });
}

// ─── isoDateUtc ────────────────────────────────────────────────────────────

describe('isoDateUtc', () => {
  it('returns YYYY-MM-DD for a known UTC epoch', () => {
    // 2024-01-15T00:00:00Z = 1705276800000
    expect(isoDateUtc(1_705_276_800_000)).toBe('2024-01-15');
  });

  it('returns current UTC date shape', () => {
    const result = isoDateUtc(Date.now());
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── quotaKey ────────────────────────────────────────────────────────────────

describe('quotaKey', () => {
  it('formats as quota:<date>', () => {
    expect(quotaKey('2024-01-15')).toBe('quota:2024-01-15');
  });
});

// ─── readDailyCount ──────────────────────────────────────────────────────────

describe('readDailyCount', () => {
  it('returns 0 when key is absent', async () => {
    const kv = makeKv();
    expect(await readDailyCount(kv, '2024-01-15')).toBe(0);
  });

  it('returns stored number', async () => {
    const kv = makeKv();
    await seedCount(kv, '2024-01-15', 42);
    expect(await readDailyCount(kv, '2024-01-15')).toBe(42);
  });

  it('returns 0 for corrupt (NaN) value', async () => {
    const kv = makeKv();
    const kv_ = kv as unknown as InMemoryKV;
    kv_.store.set(quotaKey('2024-01-15'), { value: 'not-a-number' });
    expect(await readDailyCount(kv, '2024-01-15')).toBe(0);
  });
});

// ─── incrementDailyRequestCount ──────────────────────────────────────────────

describe('incrementDailyRequestCount', () => {
  const DATE_STR = '2024-01-15';
  // epoch that maps to 2024-01-15 UTC
  const NOW = 1_705_276_800_000;

  it('increments from 0 to 1', async () => {
    const kv = makeKv();
    const result = await incrementDailyRequestCount(kv, NOW);
    expect(result).toBe(1);
    expect(await readDailyCount(kv, DATE_STR)).toBe(1);
  });

  it('increments existing count', async () => {
    const kv = makeKv();
    await seedCount(kv, DATE_STR, 10);
    const result = await incrementDailyRequestCount(kv, NOW);
    expect(result).toBe(11);
  });

  it('does not fire warning below threshold', async () => {
    const kv = makeKv();
    const warnAt = Math.floor(DAILY_REQUEST_LIMIT * QUOTA_WARN_THRESHOLD) - 1;
    await seedCount(kv, DATE_STR, warnAt - 1);
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await incrementDailyRequestCount(kv, NOW);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('fires console.warn exactly when crossing 80% threshold', async () => {
    const kv = makeKv();
    const warnAt = Math.floor(DAILY_REQUEST_LIMIT * QUOTA_WARN_THRESHOLD);
    await seedCount(kv, DATE_STR, warnAt - 1);
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await incrementDailyRequestCount(kv, NOW);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0][0]).toContain('80%');
    consoleSpy.mockRestore();
  });

  it('fires webhook when crossing threshold and webhookUrl is given', async () => {
    const kv = makeKv();
    const warnAt = Math.floor(DAILY_REQUEST_LIMIT * QUOTA_WARN_THRESHOLD);
    await seedCount(kv, DATE_STR, warnAt - 1);
    const fetched: { url: string; body: string }[] = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      fetched.push({ url: url.toString(), body: (init?.body as string) ?? '' });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await incrementDailyRequestCount(kv, NOW, 'https://hooks.test/webhook', fakeFetch);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe('https://hooks.test/webhook');
    const payload = JSON.parse(fetched[0].body) as { text: string };
    expect(payload.text).toContain('80%');
    vi.restoreAllMocks();
  });

  it('does not fire webhook on subsequent requests above threshold (already crossed)', async () => {
    const kv = makeKv();
    const warnAt = Math.floor(DAILY_REQUEST_LIMIT * QUOTA_WARN_THRESHOLD);
    // Already above 80%
    await seedCount(kv, DATE_STR, warnAt + 5);
    const fakeFetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await incrementDailyRequestCount(kv, NOW, 'https://hooks.test/webhook', fakeFetch);
    expect(fakeFetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('swallows webhook fetch errors without throwing', async () => {
    const kv = makeKv();
    const warnAt = Math.floor(DAILY_REQUEST_LIMIT * QUOTA_WARN_THRESHOLD);
    await seedCount(kv, DATE_STR, warnAt - 1);
    const fakeFetch = vi.fn(async () => { throw new Error('network error'); }) as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      incrementDailyRequestCount(kv, NOW, 'https://hooks.test/webhook', fakeFetch),
    ).resolves.not.toThrow();
    vi.restoreAllMocks();
  });
});

// ─── getQuotaStatus ──────────────────────────────────────────────────────────

describe('getQuotaStatus', () => {
  const DATE_STR = '2024-01-15';
  const NOW = 1_705_276_800_000;

  it('returns zero count when no requests yet', async () => {
    const kv = makeKv();
    const status = await getQuotaStatus(kv, NOW);
    expect(status.date).toBe(DATE_STR);
    expect(status.count).toBe(0);
    expect(status.limit).toBe(DAILY_REQUEST_LIMIT);
    expect(status.ratio).toBe(0);
    expect(status.warning).toBe(false);
  });

  it('computes ratio correctly', async () => {
    const kv = makeKv();
    await seedCount(kv, DATE_STR, 25_000);
    const status = await getQuotaStatus(kv, NOW);
    expect(status.count).toBe(25_000);
    expect(status.ratio).toBeCloseTo(0.25, 5);
    expect(status.warning).toBe(false);
  });

  it('sets warning=true at exactly 80%', async () => {
    const kv = makeKv();
    const warnAt = Math.floor(DAILY_REQUEST_LIMIT * QUOTA_WARN_THRESHOLD);
    await seedCount(kv, DATE_STR, warnAt);
    const status = await getQuotaStatus(kv, NOW);
    expect(status.warning).toBe(true);
  });

  it('sets warning=true above 80%', async () => {
    const kv = makeKv();
    await seedCount(kv, DATE_STR, DAILY_REQUEST_LIMIT);
    const status = await getQuotaStatus(kv, NOW);
    expect(status.ratio).toBeCloseTo(1, 5);
    expect(status.warning).toBe(true);
  });
});
