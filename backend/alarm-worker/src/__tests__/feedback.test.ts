import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import {
  checkRateLimit,
  FEEDBACK_MAX_MESSAGE_LENGTH,
  FEEDBACK_RATE_LIMIT_MAX,
  FEEDBACK_RATE_LIMIT_WINDOW_MS,
  FEEDBACK_TTL_SECONDS,
  feedbackKey,
  generateFeedbackId,
  rateLimitKey,
  rateLimitWindowStart,
  storeFeedback,
  validateFeedback,
} from '../feedback';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

// 테스트용 임의의 IP 리터럴. 의미 있는 값이 아니라 "서로 다른 IP" 표식.
const TEST_IP_A = '1.1.1.1';
const TEST_IP_B = '2.2.2.2';
const TEST_IP_C = '9.9.9.9';
const TEST_IP_D = '8.8.8.8';
const TEST_IP_E = '7.7.7.7';
const TEST_IP_SAMPLE = '1.2.3.4';

function envWithKv(): { env: Env; kv: InMemoryKV } {
  const kv = new InMemoryKV();
  const env = makeEnv({ FEEDBACK: kv as unknown as KVNamespace });
  return { env, kv };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TRIPS: {} as Env['TRIPS'],
    APNS_HOST: 'h',
    APNS_HOST_SANDBOX: 'hs',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
    ...overrides,
  };
}

async function post(
  path: string,
  body: unknown,
  env: Env,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );
}

describe('validateFeedback', () => {
  it('accepts message-only payload', () => {
    expect(validateFeedback({ message: 'hi' })).toEqual({ message: 'hi' });
  });

  it('trims message whitespace', () => {
    expect(validateFeedback({ message: '  hello  ' })).toEqual({ message: 'hello' });
  });

  it('accepts full context', () => {
    const result = validateFeedback({
      message: 'bug!',
      context: {
        appVersion: '1.2.3',
        platform: 'ios',
        locale: 'ko-KR',
        deviceModel: 'iPhone15,2',
      },
    });
    expect(result).toEqual({
      message: 'bug!',
      context: {
        appVersion: '1.2.3',
        platform: 'ios',
        locale: 'ko-KR',
        deviceModel: 'iPhone15,2',
      },
    });
  });

  it('drops unknown context fields and rejects bad platform', () => {
    const result = validateFeedback({
      message: 'bug',
      context: { platform: 'web', appVersion: '1.0.0', junk: 'x' },
    });
    expect(result).toEqual({
      message: 'bug',
      context: { appVersion: '1.0.0' },
    });
  });

  it('truncates oversized context strings', () => {
    const long = 'x'.repeat(200);
    const result = validateFeedback({
      message: 'm',
      context: { appVersion: long, deviceModel: long, locale: long },
    });
    expect(result?.context?.appVersion?.length).toBe(64);
    expect(result?.context?.deviceModel?.length).toBe(64);
    expect(result?.context?.locale?.length).toBe(16);
  });

  it('returns context undefined when no known fields present', () => {
    const result = validateFeedback({ message: 'm', context: { junk: 1 } });
    expect(result).toEqual({ message: 'm' });
  });

  it('returns context undefined when context is not object', () => {
    expect(validateFeedback({ message: 'm', context: 'nope' })).toEqual({ message: 'm' });
  });

  it('rejects non-object input', () => {
    expect(validateFeedback(null)).toBeNull();
    expect(validateFeedback('string')).toBeNull();
    expect(validateFeedback(42)).toBeNull();
  });

  it('rejects missing or non-string message', () => {
    expect(validateFeedback({})).toBeNull();
    expect(validateFeedback({ message: 123 })).toBeNull();
  });

  it('rejects empty / whitespace-only message', () => {
    expect(validateFeedback({ message: '' })).toBeNull();
    expect(validateFeedback({ message: '   ' })).toBeNull();
  });

  it('rejects oversized message', () => {
    const tooLong = 'a'.repeat(FEEDBACK_MAX_MESSAGE_LENGTH + 1);
    expect(validateFeedback({ message: tooLong })).toBeNull();
  });

  it('accepts exactly max-length message', () => {
    const exact = 'a'.repeat(FEEDBACK_MAX_MESSAGE_LENGTH);
    expect(validateFeedback({ message: exact })?.message.length).toBe(FEEDBACK_MAX_MESSAGE_LENGTH);
  });
});

describe('generateFeedbackId', () => {
  it('returns 8-char hex string', () => {
    const id = generateFeedbackId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces distinct ids across calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateFeedbackId()));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe('feedbackKey', () => {
  it('joins timestamp and id', () => {
    expect(feedbackKey(123, 'abc')).toBe('feedback:123:abc');
  });
});

describe('storeFeedback', () => {
  let kv: InMemoryKV;
  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('writes record with TTL and returns key', async () => {
    const putSpy = vi.spyOn(kv, 'put');
    const key = await storeFeedback(
      kv as unknown as KVNamespace,
      { message: 'm', context: { platform: 'ios' } },
      1000,
      'idid',
    );
    expect(key).toBe('feedback:1000:idid');
    expect(putSpy).toHaveBeenCalledWith(
      'feedback:1000:idid',
      JSON.stringify({ message: 'm', receivedAt: 1000, context: { platform: 'ios' } }),
      { expirationTtl: FEEDBACK_TTL_SECONDS },
    );
  });

  it('omits context when none provided', async () => {
    await storeFeedback(kv as unknown as KVNamespace, { message: 'm' }, 5, 'aa');
    const stored = await kv.get('feedback:5:aa');
    expect(stored).toBe(JSON.stringify({ message: 'm', receivedAt: 5 }));
  });
});

describe('POST /feedback', () => {
  it('returns 503 when FEEDBACK binding is missing', async () => {
    const res = await post('/feedback', { message: 'hi' }, makeEnv());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feedback_unavailable' });
  });

  it('returns 400 on malformed JSON', async () => {
    const { env } = envWithKv();
    const res = await post('/feedback', '{not json', env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 when message is missing', async () => {
    const { env } = envWithKv();
    const res = await post('/feedback', { context: { platform: 'ios' } }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });

  it('returns 400 when message exceeds limit', async () => {
    const { env } = envWithKv();
    const res = await post(
      '/feedback',
      { message: 'x'.repeat(FEEDBACK_MAX_MESSAGE_LENGTH + 1) },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('persists message with 201 on happy path', async () => {
    const { env, kv } = envWithKv();
    const res = await post(
      '/feedback',
      {
        message: 'something is broken',
        context: { platform: 'android', appVersion: '1.0.0' },
      },
      env,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ok: boolean; key: string };
    expect(json.ok).toBe(true);
    expect(json.key).toMatch(/^feedback:\d+:[0-9a-f]{8}$/);
    const stored = await kv.get(json.key);
    expect(stored).not.toBeNull();
    const record = JSON.parse(stored as string);
    expect(record.message).toBe('something is broken');
    expect(record.context).toEqual({ platform: 'android', appVersion: '1.0.0' });
    expect(typeof record.receivedAt).toBe('number');
  });
});

describe('rateLimitWindowStart / rateLimitKey', () => {
  it('aligns windowStart to FEEDBACK_RATE_LIMIT_WINDOW_MS boundary', () => {
    expect(rateLimitWindowStart(0)).toBe(0);
    expect(rateLimitWindowStart(FEEDBACK_RATE_LIMIT_WINDOW_MS - 1)).toBe(0);
    expect(rateLimitWindowStart(FEEDBACK_RATE_LIMIT_WINDOW_MS)).toBe(
      FEEDBACK_RATE_LIMIT_WINDOW_MS,
    );
    expect(rateLimitWindowStart(FEEDBACK_RATE_LIMIT_WINDOW_MS + 123)).toBe(
      FEEDBACK_RATE_LIMIT_WINDOW_MS,
    );
  });

  it('formats key with ip + windowStart', () => {
    expect(rateLimitKey(TEST_IP_SAMPLE, 60000)).toBe(`rl:feedback:${TEST_IP_SAMPLE}:60000`);
  });
});

describe('checkRateLimit', () => {
  let kv: InMemoryKV;
  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('allows first MAX requests then denies', async () => {
    const now = 1_000_000;
    for (let i = 0; i < FEEDBACK_RATE_LIMIT_MAX; i += 1) {
      const r = await checkRateLimit(kv as unknown as KVNamespace, TEST_IP_A, now);
      expect(r.allowed).toBe(true);
    }
    const denied = await checkRateLimit(kv as unknown as KVNamespace, TEST_IP_A, now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('isolates buckets per IP', async () => {
    const now = 1_000_000;
    for (let i = 0; i < FEEDBACK_RATE_LIMIT_MAX; i += 1) {
      await checkRateLimit(kv as unknown as KVNamespace, TEST_IP_A, now);
    }
    // 다른 IP는 별개 버킷
    const otherIp = await checkRateLimit(kv as unknown as KVNamespace, TEST_IP_B, now);
    expect(otherIp.allowed).toBe(true);
  });

  it('resets in next window', async () => {
    const now = FEEDBACK_RATE_LIMIT_WINDOW_MS * 10;
    for (let i = 0; i < FEEDBACK_RATE_LIMIT_MAX; i += 1) {
      await checkRateLimit(kv as unknown as KVNamespace, TEST_IP_A, now);
    }
    const denied = await checkRateLimit(kv as unknown as KVNamespace, TEST_IP_A, now);
    expect(denied.allowed).toBe(false);

    const next = now + FEEDBACK_RATE_LIMIT_WINDOW_MS;
    const allowed = await checkRateLimit(kv as unknown as KVNamespace, TEST_IP_A, next);
    expect(allowed.allowed).toBe(true);
  });

  it('writes counter with TTL matching the window', async () => {
    const putSpy = vi.spyOn(kv, 'put');
    await checkRateLimit(kv as unknown as KVNamespace, TEST_IP_A, 0);
    expect(putSpy).toHaveBeenCalledWith(`rl:feedback:${TEST_IP_A}:0`, '1', {
      expirationTtl: Math.ceil(FEEDBACK_RATE_LIMIT_WINDOW_MS / 1000),
    });
  });

  it('treats corrupt counter values as zero', async () => {
    // 외부 시스템이 garbage를 박아도 정상 동작 (방어적).
    await kv.put(`rl:feedback:${TEST_IP_A}:0`, 'not-a-number');
    const r = await checkRateLimit(kv as unknown as KVNamespace, TEST_IP_A, 0);
    expect(r.allowed).toBe(true);
  });

  it('reports at least 1s retryAfter even at window boundary', async () => {
    // 윈도우 끝에 가까운 시각이라도 Retry-After는 1초 이상.
    const nearEnd = FEEDBACK_RATE_LIMIT_WINDOW_MS - 100;
    for (let i = 0; i < FEEDBACK_RATE_LIMIT_MAX; i += 1) {
      await checkRateLimit(kv as unknown as KVNamespace, TEST_IP_A, nearEnd);
    }
    const denied = await checkRateLimit(kv as unknown as KVNamespace, TEST_IP_A, nearEnd);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /feedback rate limiting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 429 with Retry-After once MAX is exceeded for same IP', async () => {
    const { env } = envWithKv();
    const headers = { 'CF-Connecting-IP': TEST_IP_C };
    for (let i = 0; i < FEEDBACK_RATE_LIMIT_MAX; i += 1) {
      const ok = await post('/feedback', { message: `m${i}` }, env, headers);
      expect(ok.status).toBe(201);
    }
    const denied = await post('/feedback', { message: 'over' }, env, headers);
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({ error: 'rate_limited' });
    expect(denied.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  it('does not affect a different IP bucket', async () => {
    const { env } = envWithKv();
    for (let i = 0; i < FEEDBACK_RATE_LIMIT_MAX; i += 1) {
      await post('/feedback', { message: 'm' }, env, { 'CF-Connecting-IP': TEST_IP_C });
    }
    const other = await post('/feedback', { message: 'hi' }, env, {
      'CF-Connecting-IP': TEST_IP_D,
    });
    expect(other.status).toBe(201);
  });

  it('buckets requests without CF-Connecting-IP under unknown', async () => {
    const { env } = envWithKv();
    for (let i = 0; i < FEEDBACK_RATE_LIMIT_MAX; i += 1) {
      const ok = await post('/feedback', { message: 'm' }, env);
      expect(ok.status).toBe(201);
    }
    const denied = await post('/feedback', { message: 'm' }, env);
    expect(denied.status).toBe(429);
  });

  it('allows again after window elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FEEDBACK_RATE_LIMIT_WINDOW_MS * 100));
    const { env } = envWithKv();
    const headers = { 'CF-Connecting-IP': TEST_IP_E };
    for (let i = 0; i < FEEDBACK_RATE_LIMIT_MAX; i += 1) {
      await post('/feedback', { message: 'm' }, env, headers);
    }
    const denied = await post('/feedback', { message: 'm' }, env, headers);
    expect(denied.status).toBe(429);

    // Advance past window — Date.now() moves to a new bucket. InMemoryKV TTL은 Date.now 기준.
    vi.setSystemTime(new Date(FEEDBACK_RATE_LIMIT_WINDOW_MS * 101 + 1));
    const ok = await post('/feedback', { message: 'after' }, env, headers);
    expect(ok.status).toBe(201);
  });
});
