import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApnsJwt, resetApnsJwtCache, sendSilentPush, type ApnsConfig } from '../apns';

let privateKeyPem = '';

function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  // atob exists in Workers / modern Node
  return atob(padded);
}

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  privateKeyPem = await exportPKCS8(privateKey);
});

function makeConfig(): ApnsConfig {
  return {
    host: 'api.push.apple.com',
    keyId: 'KEY123',
    teamId: 'TEAM456',
    privateKeyPem,
    bundleId: 'com.example.app',
  };
}

describe('buildApnsJwt', () => {
  beforeEach(() => resetApnsJwtCache());

  it('signs JWT with ES256', async () => {
    const token = await buildApnsJwt(makeConfig());
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const header = JSON.parse(base64UrlDecode(parts[0]));
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('KEY123');
  });

  it('caches JWT across calls within TTL', async () => {
    const t1 = await buildApnsJwt(makeConfig(), 1_000_000);
    const t2 = await buildApnsJwt(makeConfig(), 1_000_000 + 60_000);
    expect(t1).toBe(t2);
  });

  it('regenerates after TTL expires', async () => {
    const t1 = await buildApnsJwt(makeConfig(), 1_000_000);
    // 51분 후 → 캐시 무효
    const t2 = await buildApnsJwt(makeConfig(), 1_000_000 + 51 * 60_000);
    expect(t1).not.toBe(t2);
  });
});

describe('sendSilentPush', () => {
  beforeEach(() => resetApnsJwtCache());

  it('posts with correct headers and body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('', { status: 200 }),
    );
    const result = await sendSilentPush({
      deviceToken: 'devicetoken-hex',
      payload: { nextWaypoint: '강남', etaSeconds: 60, phase: 'early' },
      config: makeConfig(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/3/device/devicetoken-hex');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('com.example.app');
    expect(headers['apns-push-type']).toBe('background');
    expect(headers['apns-priority']).toBe('5');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.aps['content-available']).toBe(1);
    expect(body.data.nextWaypoint).toBe('강남');
    expect(body.data.etaSeconds).toBe(60);
    expect(body.data.phase).toBe('early');
  });

  it('returns failure with reason', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const result = await sendSilentPush({
      deviceToken: 'tok',
      payload: { nextWaypoint: 'X', etaSeconds: 10, phase: 'imminent' },
      config: makeConfig(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.reason).toBe('BadDeviceToken');
  });

  it('handles non-json error body', async () => {
    const fetchImpl = vi.fn(async () => new Response('plain text', { status: 500 }));
    const result = await sendSilentPush({
      deviceToken: 'tok',
      payload: { nextWaypoint: 'X', etaSeconds: 10, phase: 'imminent' },
      config: makeConfig(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});
