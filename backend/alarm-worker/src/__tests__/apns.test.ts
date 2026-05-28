import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildApnsJwt,
  resetApnsJwtCache,
  sendAlertPush,
  sendReschedulePush,
  sendSilentPush,
  type ApnsConfig,
} from '../apns';

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

const TEST_HOST = 'api.push.apple.com';

function makeConfig(): ApnsConfig {
  return {
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
      payload: {
        nextWaypoint: '강남',
        etaSeconds: 60,
        phase: 'early',
        kind: 'destination',
        sentAt: 1_700_000_000_000,
        pushId: 'push-uuid-1',
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://${TEST_HOST}/3/device/devicetoken-hex`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('com.example.app');
    expect(headers['apns-push-type']).toBe('background');
    expect(headers['apns-priority']).toBe('5');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.aps['content-available']).toBe(1);
    expect(body.data.nextWaypoint).toBe('강남');
    expect(body.data.etaSeconds).toBe(60);
    expect(body.data.phase).toBe('early');
    expect(body.data.kind).toBe('destination');
    expect(body.data.sentAt).toBe(1_700_000_000_000);
    expect(body.data.pushId).toBe('push-uuid-1');
  });

  it('returns failure with reason', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const result = await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: 'X',
        etaSeconds: 10,
        phase: 'imminent',
        kind: 'destination',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
      },
      config: makeConfig(),
      host: TEST_HOST,
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
      payload: {
        nextWaypoint: 'X',
        etaSeconds: 10,
        phase: 'imminent',
        kind: 'destination',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('uses sandbox host when provided', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('', { status: 200 }),
    );
    await sendSilentPush({
      deviceToken: 'tok',
      payload: { nextWaypoint: 'X', etaSeconds: 10, phase: 'early', kind: 'destination', sentAt: 0, pushId: 'p' },
      config: makeConfig(),
      host: 'api.sandbox.push.apple.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.sandbox.push.apple.com/3/device/tok');
  });
});

const TEST_HOST_2 = 'api.push.apple.com';

describe('sendAlertPush (#572 P2c)', () => {
  beforeEach(() => resetApnsJwtCache());

  it('posts with alert-type headers + aps.alert + data.pushId', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = await sendAlertPush({
      deviceToken: 'devicetoken-hex',
      title: '도착 임박',
      body: '곧 강남에 도착합니다.',
      pushId: 'p-alert-1',
      config: makeConfig(),
      host: TEST_HOST_2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`https://${TEST_HOST_2}/3/device/devicetoken-hex`);
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('com.example.app');
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-priority']).toBe('10');
    const body = JSON.parse(call[1].body as string);
    expect(body.aps.alert).toEqual({ title: '도착 임박', body: '곧 강남에 도착합니다.' });
    expect(body.aps.sound).toBe('default');
    expect(body.data.pushId).toBe('p-alert-1');
  });

  it('returns failure with reason on non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const result = await sendAlertPush({
      deviceToken: 't',
      title: 'T',
      body: 'B',
      pushId: 'p',
      config: makeConfig(),
      host: TEST_HOST_2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 400, reason: 'BadDeviceToken' });
  });

  it('handles non-json error body', async () => {
    const fetchImpl = vi.fn(async () => new Response('plain text', { status: 500 }));
    const result = await sendAlertPush({
      deviceToken: 't',
      title: 'T',
      body: 'B',
      pushId: 'p',
      config: makeConfig(),
      host: TEST_HOST_2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});

describe('sendReschedulePush (#585)', () => {
  beforeEach(() => resetApnsJwtCache());

  it('posts background push with reschedule payload', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = await sendReschedulePush({
      deviceToken: 'devicetoken-hex',
      pushId: 'rsch-1',
      trainCode: '7246',
      nextStation: '중곡',
      newArrivalTimeEpoch: 1_700_000_120_000,
      sentAt: 1_700_000_000_000,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`https://${TEST_HOST}/3/device/devicetoken-hex`);
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-push-type']).toBe('background');
    expect(headers['apns-priority']).toBe('5');
    const body = JSON.parse(call[1].body as string);
    expect(body.aps['content-available']).toBe(1);
    expect(body.data).toEqual({
      pushId: 'rsch-1',
      kind: 'reschedule',
      trainCode: '7246',
      nextStation: '중곡',
      newArrivalTimeEpoch: 1_700_000_120_000,
      sentAt: 1_700_000_000_000,
    });
  });

  it('returns failure with reason on non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const result = await sendReschedulePush({
      deviceToken: 't',
      pushId: 'p',
      trainCode: '7',
      nextStation: 'x',
      newArrivalTimeEpoch: 0,
      sentAt: 0,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 400, reason: 'BadDeviceToken' });
  });
});
