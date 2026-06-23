import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig, type SilentPushPayload } from '../apns';
import {
  enqueueRetryIfTransient,
  listRetryPushes,
  removeRetryPush,
  retryPushKey,
  RETRY_PUSH_TTL_SEC,
  runRetryPushes,
  type RetryPush,
} from '../retryPushes';
import { RETRY_BACKOFF_SCHEDULE_MS } from '../apnsHost';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

let privateKeyPem = '';

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  privateKeyPem = await exportPKCS8(privateKey);
});

const APNS_HOSTS = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
} as const;

function makeApnsConfig(): ApnsConfig {
  return {
    keyId: 'KEY123',
    teamId: 'TEAM456',
    privateKeyPem,
    bundleId: 'com.example.app',
  };
}

function makePayload(overrides: Partial<SilentPushPayload> = {}): SilentPushPayload {
  return {
    nextWaypoint: '중곡',
    etaSeconds: 60,
    phase: 'imminent',
    kind: 'intermediate',
    sentAt: 1_700_000_000_000,
    pushId: 'p1',
    ...overrides,
  };
}

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    PENDING_PUSHES: kv as unknown as KVNamespace,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'swopenapi.seoul.go.kr',
    SEOUL_API_KEY: 'key',
    APNS_KEY_ID: 'KEY123',
    APNS_TEAM_ID: 'TEAM456',
    APNS_PRIVATE_KEY: privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  };
}

describe('retryPushes (#1721)', () => {
  let kv: InMemoryKV;
  beforeEach(() => {
    kv = new InMemoryKV();
    resetApnsJwtCache();
  });

  describe('retryPushKey', () => {
    it('retry-push: 접두어를 붙인다', () => {
      expect(retryPushKey('abc-123')).toBe('retry-push:abc-123');
    });
  });

  describe('RETRY_PUSH_TTL_SEC', () => {
    it('총 backoff 합 + buffer 60s', () => {
      // RETRY_BACKOFF_SCHEDULE_MS = [60000,120000,240000] → 420s + 60s = 480s
      const sumSec = RETRY_BACKOFF_SCHEDULE_MS.reduce((a, b) => a + b, 0) / 1000;
      expect(RETRY_PUSH_TTL_SEC).toBe(sumSec + 60);
    });
  });

  describe('enqueueRetryIfTransient', () => {
    const NOW = 1_700_000_000_000;

    it('429 status → entry 적재 + nextAttemptAt = now + 60s', async () => {
      const queued = await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p1',
        token: 'tok',
        payload: makePayload(),
        apnsEnv: 'sandbox',
        status: 429,
        reason: 'TooManyRequests',
        now: NOW,
      });
      expect(queued).toBe(true);
      const raw = await kv.get('retry-push:p1');
      expect(raw).not.toBeNull();
      const entry = JSON.parse(raw as string) as RetryPush;
      expect(entry.pushId).toBe('p1');
      expect(entry.attemptCount).toBe(0);
      expect(entry.nextAttemptAt).toBe(NOW + 60_000);
      expect(entry.lastErrorStatus).toBe(429);
      expect(entry.lastErrorReason).toBe('TooManyRequests');
    });

    it('500/503 status → 적재', async () => {
      const queued500 = await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-500',
        token: 'tok',
        payload: makePayload({ pushId: 'p-500' }),
        apnsEnv: 'sandbox',
        status: 500,
        now: NOW,
      });
      const queued503 = await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-503',
        token: 'tok',
        payload: makePayload({ pushId: 'p-503' }),
        apnsEnv: 'sandbox',
        status: 503,
        now: NOW,
      });
      expect(queued500).toBe(true);
      expect(queued503).toBe(true);
    });

    it('410 (BadDeviceToken Unregistered) → 적재 X', async () => {
      const queued = await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p1',
        token: 'tok',
        payload: makePayload(),
        apnsEnv: 'sandbox',
        status: 410,
        reason: 'Unregistered',
        now: NOW,
      });
      expect(queued).toBe(false);
      expect(await kv.get('retry-push:p1')).toBeNull();
    });

    it('400 BadDeviceToken → 적재 X (envHeal 책임)', async () => {
      const queued = await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p1',
        token: 'tok',
        payload: makePayload(),
        apnsEnv: 'sandbox',
        status: 400,
        reason: 'BadDeviceToken',
        now: NOW,
      });
      expect(queued).toBe(false);
    });

    it('attemptCount 명시 → 해당 backoff 적용', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p2',
        token: 'tok',
        payload: makePayload({ pushId: 'p2' }),
        apnsEnv: 'sandbox',
        status: 500,
        now: NOW,
        attemptCount: 1,
      });
      const entry = JSON.parse((await kv.get('retry-push:p2')) as string) as RetryPush;
      expect(entry.attemptCount).toBe(1);
      expect(entry.nextAttemptAt).toBe(NOW + 120_000);
    });

    it('attemptCount >= backoff schedule 길이 → 적재 X (영구 폐기 신호)', async () => {
      const queued = await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-exhaust',
        token: 'tok',
        payload: makePayload(),
        apnsEnv: 'sandbox',
        status: 503,
        now: NOW,
        attemptCount: RETRY_BACKOFF_SCHEDULE_MS.length,
      });
      expect(queued).toBe(false);
    });

    it('originalSentAt 미지정 시 now 로 stamp', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p3',
        token: 'tok',
        payload: makePayload({ pushId: 'p3' }),
        apnsEnv: 'sandbox',
        status: 429,
        now: NOW,
      });
      const entry = JSON.parse((await kv.get('retry-push:p3')) as string) as RetryPush;
      expect(entry.originalSentAt).toBe(NOW);
    });

    it('kv === undefined → no-op', async () => {
      const queued = await enqueueRetryIfTransient(undefined, {
        pushId: 'p1',
        token: 'tok',
        payload: makePayload(),
        apnsEnv: 'sandbox',
        status: 429,
        now: NOW,
      });
      expect(queued).toBe(false);
    });

    it('reason 미지정 → lastErrorReason 필드 omit', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-no-reason',
        token: 'tok',
        payload: makePayload({ pushId: 'p-no-reason' }),
        apnsEnv: 'sandbox',
        status: 500,
        now: NOW,
      });
      const entry = JSON.parse((await kv.get('retry-push:p-no-reason')) as string) as RetryPush;
      expect('lastErrorReason' in entry).toBe(false);
    });
  });

  describe('removeRetryPush', () => {
    it('해당 키 삭제', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p1',
        token: 'tok',
        payload: makePayload(),
        apnsEnv: 'sandbox',
        status: 429,
        now: 0,
      });
      await removeRetryPush(kv as unknown as KVNamespace, 'p1');
      expect(await kv.get('retry-push:p1')).toBeNull();
    });

    it('kv === undefined → no-op', async () => {
      await expect(removeRetryPush(undefined, 'p1')).resolves.toBeUndefined();
    });
  });

  describe('listRetryPushes', () => {
    it('prefix scan 으로 retry-push:* 만 yield', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'a',
        token: 'tok',
        payload: makePayload({ pushId: 'a' }),
        apnsEnv: 'sandbox',
        status: 429,
        now: 0,
      });
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'b',
        token: 'tok',
        payload: makePayload({ pushId: 'b' }),
        apnsEnv: 'sandbox',
        status: 500,
        now: 0,
      });
      // 무관 entry (다른 prefix) 는 yield 되지 않아야.
      await kv.put('pending:c', 'unrelated');
      await kv.put('trip:d', 'unrelated');
      const collected: string[] = [];
      for await (const entry of listRetryPushes(kv as unknown as KVNamespace)) {
        collected.push(entry.pushId);
      }
      expect(collected.sort((x, y) => x.localeCompare(y))).toEqual(['a', 'b']);
    });

    it('kv === undefined → 빈 generator', async () => {
      const collected: string[] = [];
      for await (const e of listRetryPushes(undefined)) collected.push(e.pushId);
      expect(collected).toEqual([]);
    });

    it('손상된 JSON entry 는 skip', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'good',
        token: 'tok',
        payload: makePayload({ pushId: 'good' }),
        apnsEnv: 'sandbox',
        status: 429,
        now: 0,
      });
      await kv.put('retry-push:bad', 'not-json{');
      const collected: string[] = [];
      for await (const e of listRetryPushes(kv as unknown as KVNamespace)) {
        collected.push(e.pushId);
      }
      expect(collected).toEqual(['good']);
    });
  });

  describe('runRetryPushes', () => {
    const NOW = 1_700_000_000_000;

    it('nextAttemptAt 미도달 entry 는 deferred + skip', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-defer',
        token: 'tok',
        payload: makePayload({ pushId: 'p-defer' }),
        apnsEnv: 'sandbox',
        status: 429,
        now: NOW,
      });
      const apnsFetch = vi.fn();
      const stats = await runRetryPushes(makeEnv(kv), {
        apnsConfig: makeApnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW + 30_000, // backoff 60s 미달
      });
      expect(stats).toEqual({ scanned: 1, deferred: 1, resent: 0, rescheduled: 0, exhausted: 0 });
      expect(apnsFetch).not.toHaveBeenCalled();
      // entry 보존
      expect(await kv.get('retry-push:p-defer')).not.toBeNull();
    });

    it('backoff 만기 → 재발사 성공 → entry 삭제 + resent', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-ok',
        token: 'tok',
        payload: makePayload({ pushId: 'p-ok', nextWaypoint: '강남' }),
        apnsEnv: 'sandbox',
        status: 503,
        now: NOW,
      });
      const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runRetryPushes(makeEnv(kv), {
        apnsConfig: makeApnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW + 60_000 + 1,
      });
      expect(stats.resent).toBe(1);
      expect(stats.deferred).toBe(0);
      expect(apnsFetch).toHaveBeenCalledTimes(1);
      expect(await kv.get('retry-push:p-ok')).toBeNull();
    });

    it('retryable 실패 다시 떨어지면 attemptCount + 1 로 재 enqueue (rescheduled)', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-reschedule',
        token: 'tok',
        payload: makePayload({ pushId: 'p-reschedule' }),
        apnsEnv: 'sandbox',
        status: 503,
        now: NOW,
      });
      const apnsFetch = vi.fn(async () =>
        new Response(JSON.stringify({ reason: 'InternalServerError' }), { status: 500 }),
      );
      const T2 = NOW + 60_000 + 1;
      const stats = await runRetryPushes(makeEnv(kv), {
        apnsConfig: makeApnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => T2,
      });
      expect(stats.rescheduled).toBe(1);
      expect(stats.resent).toBe(0);
      const stored = JSON.parse((await kv.get('retry-push:p-reschedule')) as string) as RetryPush;
      expect(stored.attemptCount).toBe(1);
      // 2번째 backoff = 120s
      expect(stored.nextAttemptAt).toBe(T2 + 120_000);
      expect(stored.lastErrorStatus).toBe(500);
    });

    it('unrecoverable 응답 (410 Unregistered) → 폐기 (exhausted)', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-410',
        token: 'tok',
        payload: makePayload({ pushId: 'p-410' }),
        apnsEnv: 'sandbox',
        status: 503,
        now: NOW,
      });
      const apnsFetch = vi.fn(async () =>
        new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 }),
      );
      const stats = await runRetryPushes(makeEnv(kv), {
        apnsConfig: makeApnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW + 60_000 + 1,
      });
      expect(stats.exhausted).toBe(1);
      expect(stats.rescheduled).toBe(0);
      expect(await kv.get('retry-push:p-410')).toBeNull();
    });

    it('attempt 한계 도달 + 실패 → 폐기 (exhausted)', async () => {
      // 마지막 attempt 까지 도달 — 다음 재시도 시 backoff schedule 끝.
      await kv.put(
        'retry-push:p-max',
        JSON.stringify({
          pushId: 'p-max',
          token: 'tok',
          payload: makePayload({ pushId: 'p-max' }),
          apnsEnv: 'sandbox',
          attemptCount: RETRY_BACKOFF_SCHEDULE_MS.length - 1,
          nextAttemptAt: NOW,
          originalSentAt: NOW,
          lastErrorStatus: 503,
        }),
      );
      const apnsFetch = vi.fn(async () => new Response('', { status: 503 }));
      const stats = await runRetryPushes(makeEnv(kv), {
        apnsConfig: makeApnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW + 1,
      });
      expect(stats.exhausted).toBe(1);
      expect(await kv.get('retry-push:p-max')).toBeNull();
    });

    it('재 enqueue 시 entry.apnsEnv 가 그대로 보존 (env mismatch 미발생 시)', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-env',
        token: 'tok',
        payload: makePayload({ pushId: 'p-env' }),
        apnsEnv: 'sandbox',
        status: 503,
        now: NOW,
      });
      const apnsFetch = vi.fn(async () =>
        new Response(JSON.stringify({ reason: 'InternalServerError' }), { status: 500 }),
      );
      await runRetryPushes(makeEnv(kv), {
        apnsConfig: makeApnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW + 60_000 + 1,
      });
      const stored = JSON.parse((await kv.get('retry-push:p-env')) as string) as RetryPush;
      // mismatch 미발생 → entry.apnsEnv 보존 (sandbox).
      expect(stored.apnsEnv).toBe('sandbox');
    });

    it('kv binding 없으면 graceful — scanned 0', async () => {
      const envNoKv = {
        ...makeEnv(kv),
        PENDING_PUSHES: undefined,
      } as Env;
      const stats = await runRetryPushes(envNoKv, {
        apnsConfig: makeApnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: vi.fn() as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(stats).toEqual({ scanned: 0, deferred: 0, resent: 0, rescheduled: 0, exhausted: 0 });
    });

    it('payload.sentAt 은 retry 시점으로 갱신 (관측용)', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-sentat',
        token: 'tok',
        payload: makePayload({ pushId: 'p-sentat' }),
        apnsEnv: 'sandbox',
        status: 503,
        now: NOW,
      });
      const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
      const T2 = NOW + 60_000 + 1;
      await runRetryPushes(makeEnv(kv), {
        apnsConfig: makeApnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => T2,
      });
      const call = apnsFetch.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.data.sentAt).toBe(T2);
    });

    it('log 미지정 → 동작 정상 (default no-op logger)', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-nolog',
        token: 'tok',
        payload: makePayload({ pushId: 'p-nolog' }),
        apnsEnv: 'sandbox',
        status: 503,
        now: NOW,
      });
      const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runRetryPushes(makeEnv(kv), {
        apnsConfig: makeApnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
        now: () => NOW + 60_000 + 1,
      });
      expect(stats.resent).toBe(1);
    });

    it('now() 미지정 → Date.now() 기본 사용', async () => {
      await enqueueRetryIfTransient(kv as unknown as KVNamespace, {
        pushId: 'p-no-now',
        token: 'tok',
        payload: makePayload({ pushId: 'p-no-now' }),
        apnsEnv: 'sandbox',
        status: 503,
        now: Date.now() - 60_000 - 1,
        // nextAttemptAt = (Date.now() - 60_001) + 60_000 = Date.now() - 1 → 만기.
      });
      const apnsFetch = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runRetryPushes(makeEnv(kv), {
        apnsConfig: makeApnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch as unknown as typeof fetch,
      });
      expect(stats.resent).toBe(1);
    });
  });
});
