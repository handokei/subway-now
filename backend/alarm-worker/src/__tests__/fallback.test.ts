import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_THRESHOLD_MS, runFallbackPushes } from '../fallback';
import { pendingKey, putPending, type PendingPush } from '../pendingPushes';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

let privateKeyPem = '';
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
});

const NOW = 1_700_000_000_000;
const APNS_HOSTS = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
} as const;

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: {} as Env['TRIPS'],
    PENDING_PUSHES: kv as unknown as KVNamespace,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  };
}

function makeEntry(overrides: Partial<PendingPush> = {}): PendingPush {
  return {
    pushId: 'push-1',
    token: 'devicetoken-hex',
    alarmKey: 'imminent:강남',
    sentAt: NOW - FALLBACK_THRESHOLD_MS, // 임계 정확히 도달
    stationName: '강남',
    kind: 'destination',
    phase: 'imminent',
    etaSeconds: 30,
    apnsEnv: 'sandbox',
    ...overrides,
  };
}

const apnsConfig = () => ({
  keyId: 'K',
  teamId: 'T',
  privateKeyPem,
  bundleId: 'com.example.app',
});

describe('runFallbackPushes (#572 P2c)', () => {
  let kv: InMemoryKV;
  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('PENDING_PUSHES 미바인딩이면 scanned=0으로 종료 (graceful)', async () => {
    const env = { ...makeEnv(kv), PENDING_PUSHES: undefined };
    const fetchImpl = vi.fn();
    const stats = await runFallbackPushes(env, {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats).toEqual({ scanned: 0, pushed: 0, errors: 0, deferred: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('임계 미달 entry는 deferred 카운트만 + 발사 안 함', async () => {
    await putPending(
      kv as unknown as KVNamespace,
      makeEntry({ sentAt: NOW - (FALLBACK_THRESHOLD_MS - 1) }),
    );
    const fetchImpl = vi.fn();
    const stats = await runFallbackPushes(makeEnv(kv), {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats).toEqual({ scanned: 1, pushed: 0, errors: 0, deferred: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(kv.store.has(pendingKey('push-1'))).toBe(true);
  });

  it('임계 초과 entry는 alert 발사 + 발사 후 entry 삭제', async () => {
    await putPending(kv as unknown as KVNamespace, makeEntry({ pushId: 'p-fire' }));
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runFallbackPushes(makeEnv(kv), {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats).toEqual({ scanned: 1, pushed: 1, errors: 0, deferred: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${APNS_HOSTS.sandbox}/3/device/devicetoken-hex`);
    const body = JSON.parse(init.body as string);
    expect(body.aps.alert.title).toBe('도착 임박');
    expect(body.aps.alert.body).toContain('강남');
    expect(body.data.pushId).toBe('p-fire');
    expect(kv.store.has(pendingKey('p-fire'))).toBe(false);
  });

  it('apnsEnv=production이면 production host로 발사', async () => {
    await putPending(
      kv as unknown as KVNamespace,
      makeEntry({ pushId: 'p-prod', apnsEnv: 'production' }),
    );
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await runFallbackPushes(makeEnv(kv), {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(`https://${APNS_HOSTS.production}/3/device/devicetoken-hex`);
  });

  it('intermediate kind는 phase 무관 단일 본문', async () => {
    await putPending(
      kv as unknown as KVNamespace,
      makeEntry({ kind: 'intermediate', stationName: '중곡', phase: 'imminent' }),
    );
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await runFallbackPushes(makeEnv(kv), {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.aps.alert.title).toBe('역 통과');
    expect(body.aps.alert.body).toBe('중곡역을 지나고 있어요');
  });

  it('영구 실패(BadDeviceToken)는 entry 즉시 삭제 + errors 카운트', async () => {
    await putPending(kv as unknown as KVNamespace, makeEntry({ pushId: 'p-perm' }));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const stats = await runFallbackPushes(makeEnv(kv), {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats).toEqual({ scanned: 1, pushed: 0, errors: 1, deferred: 0 });
    expect(kv.store.has(pendingKey('p-perm'))).toBe(false);
  });

  it('영구 실패(Unregistered 410)도 entry 즉시 삭제', async () => {
    await putPending(kv as unknown as KVNamespace, makeEntry({ pushId: 'p-410' }));
    const fetchImpl = vi.fn(async () => new Response('', { status: 410 }));
    await runFallbackPushes(makeEnv(kv), {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(kv.store.has(pendingKey('p-410'))).toBe(false);
  });

  it('transient 실패(5xx)는 entry 유지 — KV TTL이 자연 정리하며 다음 cron에서 재시도 보존', async () => {
    await putPending(kv as unknown as KVNamespace, makeEntry({ pushId: 'p-transient' }));
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    const stats = await runFallbackPushes(makeEnv(kv), {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(stats.errors).toBe(1);
    expect(kv.store.has(pendingKey('p-transient'))).toBe(true);
  });

  it('구 entry(apnsEnv 누락 — #566 머지 직후 KV)는 sandbox로 발사 (마이그레이션 안전망)', async () => {
    const entryRaw = JSON.stringify({
      pushId: 'p-legacy',
      token: 'devicetoken-hex',
      alarmKey: 'imminent:강남',
      sentAt: NOW - FALLBACK_THRESHOLD_MS,
      stationName: '강남',
      kind: 'destination',
      phase: 'imminent',
      etaSeconds: 30,
      // apnsEnv 누락 — 구 entry
    });
    await kv.put(pendingKey('p-legacy'), entryRaw);
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await runFallbackPushes(makeEnv(kv), {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`https://${APNS_HOSTS.sandbox}/3/device/devicetoken-hex`);
  });

  it('성공 발사 후 재실행 시 동일 entry로 재발사 안 함 (dedup)', async () => {
    await putPending(kv as unknown as KVNamespace, makeEntry({ pushId: 'p-once' }));
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const deps = {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    };
    await runFallbackPushes(makeEnv(kv), deps);
    await runFallbackPushes(makeEnv(kv), deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('default deps (now/log 미주입)도 동작', async () => {
    const stats = await runFallbackPushes(makeEnv(kv), {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
    });
    expect(stats.scanned).toBe(0);
  });

  it('#2054 — idle cycle (scanned=0) suppresses `fallback run complete` log', async () => {
    const logMessages: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    await runFallbackPushes(makeEnv(kv), {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      log: (msg, meta) => {
        logMessages.push({ msg, meta });
      },
    });
    expect(logMessages.some((l) => l.msg === 'fallback run complete')).toBe(false);
  });

  it('#2054 — non-idle cycle still emits `fallback run complete` log', async () => {
    await putPending(
      kv as unknown as KVNamespace,
      makeEntry({ sentAt: NOW - (FALLBACK_THRESHOLD_MS - 1) }),
    );
    const logMessages: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    await runFallbackPushes(makeEnv(kv), {
      apnsConfig: apnsConfig(),
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      log: (msg, meta) => {
        logMessages.push({ msg, meta });
      },
    });
    expect(logMessages.some((l) => l.msg === 'fallback run complete')).toBe(true);
  });
});
