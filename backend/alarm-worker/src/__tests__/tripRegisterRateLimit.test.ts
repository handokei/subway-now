import { describe, expect, it } from 'vitest';
import {
  TRIP_REGISTER_MAX_PER_WINDOW,
  TRIP_REGISTER_WINDOW_MS,
  checkTripRegisterRateLimit,
  makeTokenPrefix,
  tripRegisterRateLimitKey,
  tripRegisterWindowStart,
} from '../tripRegisterRateLimit';
import { InMemoryKV } from './inMemoryKv';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const SHORT_TOKEN = 'abc';

describe('tripRegisterRateLimit (#1575 T12 V8 b)', () => {
  it('window start aligns nowMs to TRIP_REGISTER_WINDOW_MS', () => {
    const now = 5 * TRIP_REGISTER_WINDOW_MS + 1234;
    expect(tripRegisterWindowStart(now)).toBe(5 * TRIP_REGISTER_WINDOW_MS);
  });

  it('makeTokenPrefix returns first 16 chars', () => {
    expect(makeTokenPrefix(TOKEN_A)).toBe('aaaaaaaaaaaaaaaa');
  });

  it('makeTokenPrefix returns short input as-is (graceful)', () => {
    expect(makeTokenPrefix(SHORT_TOKEN)).toBe('abc');
  });

  it('key shape includes prefix + windowStart', () => {
    expect(tripRegisterRateLimitKey('prefix', 1000)).toBe(
      'trip-rate:prefix:1000',
    );
  });

  it('first MAX requests allowed, MAX+1 rejected', async () => {
    const kv = new InMemoryKV();
    const now = TRIP_REGISTER_WINDOW_MS;
    for (let i = 0; i < TRIP_REGISTER_MAX_PER_WINDOW; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await checkTripRegisterRateLimit(
        kv as unknown as KVNamespace,
        TOKEN_A,
        now,
      );
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i + 1);
    }
    const overflow = await checkTripRegisterRateLimit(
      kv as unknown as KVNamespace,
      TOKEN_A,
      now,
    );
    expect(overflow.allowed).toBe(false);
    expect(overflow.count).toBe(TRIP_REGISTER_MAX_PER_WINDOW);
    expect(overflow.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('different tokens have independent counters', async () => {
    const kv = new InMemoryKV();
    const now = TRIP_REGISTER_WINDOW_MS;
    for (let i = 0; i < TRIP_REGISTER_MAX_PER_WINDOW; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await checkTripRegisterRateLimit(kv as unknown as KVNamespace, TOKEN_A, now);
    }
    // TOKEN_A는 cap에 도달했지만 TOKEN_B는 0/10에서 시작.
    const r = await checkTripRegisterRateLimit(
      kv as unknown as KVNamespace,
      TOKEN_B,
      now,
    );
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
  });

  it('new window resets counter', async () => {
    const kv = new InMemoryKV();
    const now1 = TRIP_REGISTER_WINDOW_MS;
    for (let i = 0; i < TRIP_REGISTER_MAX_PER_WINDOW; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await checkTripRegisterRateLimit(kv as unknown as KVNamespace, TOKEN_A, now1);
    }
    const blocked = await checkTripRegisterRateLimit(
      kv as unknown as KVNamespace,
      TOKEN_A,
      now1,
    );
    expect(blocked.allowed).toBe(false);

    const now2 = now1 + TRIP_REGISTER_WINDOW_MS;
    const fresh = await checkTripRegisterRateLimit(
      kv as unknown as KVNamespace,
      TOKEN_A,
      now2,
    );
    expect(fresh.allowed).toBe(true);
    expect(fresh.count).toBe(1);
  });

  it('handles corrupt KV value (parse fail) by treating as 0', async () => {
    const kv = new InMemoryKV();
    const now = TRIP_REGISTER_WINDOW_MS;
    const key = tripRegisterRateLimitKey(
      makeTokenPrefix(TOKEN_A),
      tripRegisterWindowStart(now),
    );
    await kv.put(key, 'not-a-number');
    const r = await checkTripRegisterRateLimit(
      kv as unknown as KVNamespace,
      TOKEN_A,
      now,
    );
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
  });

  it('handles negative KV value (defensive) by treating as 0', async () => {
    const kv = new InMemoryKV();
    const now = TRIP_REGISTER_WINDOW_MS;
    const key = tripRegisterRateLimitKey(
      makeTokenPrefix(TOKEN_A),
      tripRegisterWindowStart(now),
    );
    await kv.put(key, '-5');
    const r = await checkTripRegisterRateLimit(
      kv as unknown as KVNamespace,
      TOKEN_A,
      now,
    );
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
  });

  it('retryAfterSeconds is at least 1 even near window end', async () => {
    const kv = new InMemoryKV();
    const windowStart = TRIP_REGISTER_WINDOW_MS;
    const nearEnd = windowStart + TRIP_REGISTER_WINDOW_MS - 100;
    const r = await checkTripRegisterRateLimit(
      kv as unknown as KVNamespace,
      TOKEN_A,
      nearEnd,
    );
    expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});
