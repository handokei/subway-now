import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import {
  FEEDBACK_MAX_MESSAGE_LENGTH,
  FEEDBACK_TTL_SECONDS,
  feedbackKey,
  generateFeedbackId,
  storeFeedback,
  validateFeedback,
} from '../feedback';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

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

async function post(path: string, body: unknown, env: Env): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
  function envWithKv(): { env: Env; kv: InMemoryKV } {
    const kv = new InMemoryKV();
    const env = makeEnv({ FEEDBACK: kv as unknown as KVNamespace });
    return { env, kv };
  }

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
