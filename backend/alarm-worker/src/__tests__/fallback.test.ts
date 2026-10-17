import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_ALERT_COLLAPSE_ID_PREFIX, fallbackAlertCollapseId } from '../collapseId';
import { stampDeviceContact } from '../deviceContact';
import { FALLBACK_THRESHOLD_MS, IMPLICIT_ACK_RECENCY_MS, runFallbackPushes } from '../fallback';
import { pendingKey, putPending, type PendingPush } from '../pendingPushes';
import { hashTripToken } from '../sentry';
import { putTrip } from '../trips';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeTripFixture } from './helpers/testFixtures';

function makeMockDb(): D1Database & { bind: ReturnType<typeof vi.fn> } {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare, bind } as unknown as D1Database & { bind: typeof bind };
}

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

function makeEnv(kv: InMemoryKV, tripsKv: InMemoryKV = new InMemoryKV()): Env {
  return {
    TRIPS: tripsKv as unknown as Env['TRIPS'],
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
    tripToken: 'tok-auto',
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
    expect(stats).toEqual({ scanned: 0, pushed: 0, errors: 0, deferred: 0, skippedLocked: 0, implicitAcked: 0 });
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
    expect(stats).toEqual({ scanned: 1, pushed: 0, errors: 0, deferred: 1, skippedLocked: 0, implicitAcked: 0 });
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
    expect(stats).toEqual({ scanned: 1, pushed: 1, errors: 0, deferred: 0, skippedLocked: 0, implicitAcked: 0 });
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
    const tripsKv = new InMemoryKV();
    await putTrip(tripsKv as unknown as KVNamespace, makeTripFixture({ token: 'tok-auto' }));
    await putPending(
      kv as unknown as KVNamespace,
      makeEntry({ kind: 'intermediate', stationName: '중곡', phase: 'imminent' }),
    );
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await runFallbackPushes(makeEnv(kv, tripsKv), {
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
    expect(stats).toEqual({ scanned: 1, pushed: 0, errors: 1, deferred: 0, skippedLocked: 0, implicitAcked: 0 });
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

  describe('#2522 — 락 활성 시 stale intermediate "통과" 발사 차단', () => {
    it('intermediate pending + trip lock 활성 → 발사하지 않고 entry만 삭제', async () => {
      const tripsKv = new InMemoryKV();
      await putTrip(
        tripsKv as unknown as KVNamespace,
        makeTripFixture({
          token: 'tok-locked',
          boardingLock: {
            trainCode: 'T',
            line: '2',
            subwayId: '1002',
            selectedDepartureTime: NOW,
            segmentStations: ['중곡', '군자'],
            expiresAt: NOW + 60 * 60_000,
          },
        }),
      );
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-locked', kind: 'intermediate', tripToken: 'tok-locked', stationName: '중곡' }),
      );
      const fetchImpl = vi.fn();
      const stats = await runFallbackPushes(makeEnv(kv, tripsKv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(kv.store.has(pendingKey('p-locked'))).toBe(false);
      expect(stats.pushed).toBe(0);
    });

    it('intermediate pending + trip lockless(락 없음) → 기존대로 발사', async () => {
      const tripsKv = new InMemoryKV();
      await putTrip(tripsKv as unknown as KVNamespace, makeTripFixture({ token: 'tok-lockless' }));
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-lockless', kind: 'intermediate', tripToken: 'tok-lockless', stationName: '중곡' }),
      );
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runFallbackPushes(makeEnv(kv, tripsKv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(stats.pushed).toBe(1);
      expect(kv.store.has(pendingKey('p-lockless'))).toBe(false);
    });

    it('intermediate pending + trip 이미 소멸(없음) → 발사하지 않고 entry만 삭제', async () => {
      const tripsKv = new InMemoryKV();
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-gone', kind: 'intermediate', tripToken: 'tok-gone', stationName: '중곡' }),
      );
      const fetchImpl = vi.fn();
      const stats = await runFallbackPushes(makeEnv(kv, tripsKv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(kv.store.has(pendingKey('p-gone'))).toBe(false);
      expect(stats.pushed).toBe(0);
    });

    it('intermediate pending + tripToken 누락(구 entry) → 검증 불가로 보수적 skip', async () => {
      const entryRaw = JSON.stringify({
        pushId: 'p-no-triptoken',
        token: 'devicetoken-hex',
        alarmKey: 'imminent:중곡',
        sentAt: NOW - FALLBACK_THRESHOLD_MS,
        stationName: '중곡',
        kind: 'intermediate',
        phase: 'imminent',
        etaSeconds: 30,
        apnsEnv: 'sandbox',
        // tripToken 누락 — #2522 이전 entry
      });
      await kv.put(pendingKey('p-no-triptoken'), entryRaw);
      const fetchImpl = vi.fn();
      const stats = await runFallbackPushes(makeEnv(kv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(kv.store.has(pendingKey('p-no-triptoken'))).toBe(false);
      expect(stats.pushed).toBe(0);
    });

    it('destination/transfer kind는 lock 활성 trip이어도 기존대로 발사(영향 없음)', async () => {
      const tripsKv = new InMemoryKV();
      await putTrip(
        tripsKv as unknown as KVNamespace,
        makeTripFixture({
          token: 'tok-locked-2',
          boardingLock: {
            trainCode: 'T',
            line: '2',
            subwayId: '1002',
            selectedDepartureTime: NOW,
            segmentStations: ['강남', '역삼'],
            expiresAt: NOW + 60 * 60_000,
          },
        }),
      );
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-dest-locked', kind: 'destination', tripToken: 'tok-locked-2' }),
      );
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runFallbackPushes(makeEnv(kv, tripsKv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(stats.pushed).toBe(1);
    });
  });

  describe('#2617 — fallback implicit ACK (device 접촉 stamp)', () => {
    it('fg fresh contact(entry.sentAt 이후 + 90s 이내) → fallback 미발사 + entry 삭제 + D1 fallback-implicit-ack 기록', async () => {
      const tripsKv = new InMemoryKV();
      await putTrip(tripsKv as unknown as KVNamespace, makeTripFixture({ token: 'tok-implicit' }));
      // sentAt 이후 + now 기준 recency 창(90s) 이내 시각으로 접촉 stamp (FG /position 채널 시뮬레이션).
      await stampDeviceContact(
        tripsKv as unknown as KVNamespace,
        hashTripToken('tok-implicit'),
        NOW - 1_000,
      );
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({
          pushId: 'p-implicit',
          tripToken: 'tok-implicit',
          stationName: '뚝섬',
          kind: 'transfer', // destination은 exclusion 대상 — 별도 테스트에서 검증
        }),
      );
      const db = makeMockDb();
      const fetchImpl = vi.fn();
      const stats = await runFallbackPushes(
        { ...makeEnv(kv, tripsKv), DB: db },
        {
          apnsConfig: apnsConfig(),
          apnsHosts: APNS_HOSTS,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          now: () => NOW,
        },
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(kv.store.has(pendingKey('p-implicit'))).toBe(false);
      expect(stats.implicitAcked).toBe(1);
      expect(stats.pushed).toBe(0);
      expect(db.bind).toHaveBeenCalledWith(
        expect.any(String),
        NOW,
        'fallback-implicit-ack',
        '뚝섬',
        null,
        JSON.stringify({ pushId: 'p-implicit', ageMs: FALLBACK_THRESHOLD_MS }),
      );
    });

    it('device 접촉이 entry.sentAt 이전(오래된 접촉)이면 implicit ACK로 인정하지 않고 기존대로 발사', async () => {
      const tripsKv = new InMemoryKV();
      await stampDeviceContact(
        tripsKv as unknown as KVNamespace,
        hashTripToken('tok-stale-contact'),
        NOW - FALLBACK_THRESHOLD_MS - 5_000, // entry.sentAt보다 이전 접촉
      );
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-stale-contact', tripToken: 'tok-stale-contact', kind: 'transfer' }),
      );
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runFallbackPushes(makeEnv(kv, tripsKv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(stats.implicitAcked).toBe(0);
      expect(stats.pushed).toBe(1);
    });

    it('fg stale contact(entry.sentAt 이후지만 now 기준 90s 초과) → implicit ACK 인정하지 않고 발사', async () => {
      const tripsKv = new InMemoryKV();
      // entry.sentAt(NOW - 60_000) 이후이지만, now(NOW) 기준으로는 90s를 초과한 접촉.
      await stampDeviceContact(
        tripsKv as unknown as KVNamespace,
        hashTripToken('tok-recency-stale'),
        NOW - FALLBACK_THRESHOLD_MS + 1_000, // sentAt보다는 이후
      );
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-recency-stale', tripToken: 'tok-recency-stale', kind: 'transfer' }),
      );
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runFallbackPushes(makeEnv(kv, tripsKv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        // now를 recency 창(90s) 밖으로 미뤄 접촉이 "오래전 단발"이 되게 한다.
        now: () => NOW - FALLBACK_THRESHOLD_MS + 1_000 + IMPLICIT_ACK_RECENCY_MS,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(stats.implicitAcked).toBe(0);
      expect(stats.pushed).toBe(1);
    });

    it('kind===destination은 fresh contact가 있어도 항상 발사 (#1995 must-refire)', async () => {
      const tripsKv = new InMemoryKV();
      await stampDeviceContact(
        tripsKv as unknown as KVNamespace,
        hashTripToken('tok-destination'),
        NOW - 1_000,
      );
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-destination', tripToken: 'tok-destination', kind: 'destination' }),
      );
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runFallbackPushes(makeEnv(kv, tripsKv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(stats.implicitAcked).toBe(0);
      expect(stats.pushed).toBe(1);
    });

    it('tripToken 부재(구 entry) → device token 해시로 대체 조회하지 않고 기존 동작(발사) 유지 — 토큰 공간 혼합 금지', async () => {
      const tripsKv = new InMemoryKV();
      // 구 entry의 device token(makeEntry 기본값 'devicetoken-hex') 해시로 fresh contact를 심어도
      // tripToken이 없으면 그 키를 조회조차 하지 않아야 한다.
      await stampDeviceContact(
        tripsKv as unknown as KVNamespace,
        hashTripToken('devicetoken-hex'),
        NOW - 1_000,
      );
      const entryRaw = JSON.stringify({
        pushId: 'p-legacy-notoken',
        token: 'devicetoken-hex',
        alarmKey: 'imminent:강남',
        sentAt: NOW - FALLBACK_THRESHOLD_MS,
        stationName: '강남',
        kind: 'transfer',
        phase: 'imminent',
        etaSeconds: 30,
        apnsEnv: 'sandbox',
        // tripToken 누락 — #2522 이전 entry
      });
      await kv.put(pendingKey('p-legacy-notoken'), entryRaw);
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runFallbackPushes(makeEnv(kv, tripsKv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(stats.implicitAcked).toBe(0);
      expect(stats.pushed).toBe(1);
    });

    it('device 접촉 기록 없음(BG trip — /position이 appState!=="fg"라 stamp 자체가 없음) → 기존 fallback 동작 불변(안전망 보존, 핵심 회귀 테스트)', async () => {
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-no-contact', tripToken: 'tok-no-contact', kind: 'transfer' }),
      );
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runFallbackPushes(makeEnv(kv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(stats.implicitAcked).toBe(0);
      expect(stats.pushed).toBe(1);
      expect(kv.store.has(pendingKey('p-no-contact'))).toBe(false);
    });

    it('#2522 lock 게이트가 implicit ACK 판정보다 먼저 평가된다 — skippedLocked 관측 계약 보존', async () => {
      const tripsKv = new InMemoryKV();
      await putTrip(
        tripsKv as unknown as KVNamespace,
        makeTripFixture({
          token: 'tok-lock-vs-implicit',
          boardingLock: {
            trainCode: 'T',
            line: '2',
            subwayId: '1002',
            selectedDepartureTime: NOW,
            segmentStations: ['중곡', '군자'],
            expiresAt: NOW + 60 * 60_000,
          },
        }),
      );
      // fresh device contact도 함께 심어 implicit ACK 조건 자체는 만족시킨다 — 그래도 lock
      // 게이트가 먼저 평가돼 skippedLocked로 잡혀야 하고 implicitAcked는 증가하면 안 된다.
      await stampDeviceContact(
        tripsKv as unknown as KVNamespace,
        hashTripToken('tok-lock-vs-implicit'),
        NOW - 1_000,
      );
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({
          pushId: 'p-lock-vs-implicit',
          kind: 'intermediate',
          tripToken: 'tok-lock-vs-implicit',
          stationName: '중곡',
        }),
      );
      const fetchImpl = vi.fn();
      const stats = await runFallbackPushes(makeEnv(kv, tripsKv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(stats.skippedLocked).toBe(1);
      expect(stats.implicitAcked).toBe(0);
    });
  });

  describe('#2610 — RCA-A: collapseId 전달 + D1 계측', () => {
    it('fallbackAlertCollapseId는 trip+station 단위 결정적 id를 만든다', () => {
      expect(fallbackAlertCollapseId('tok-collapse-1234567890', '강남')).toBe(
        `${FALLBACK_ALERT_COLLAPSE_ID_PREFIX}tok-collapse-123-강남`,
      );
    });

    it('tripToken 누락(구 entry)이면 device token으로 대체', () => {
      const entry = makeEntry({ stationName: '강남' });
      const { tripToken, ...withoutTripToken } = entry;
      expect(tripToken).toBeDefined();
      expect(fallbackAlertCollapseId(withoutTripToken.token, withoutTripToken.stationName)).toBe(
        `${FALLBACK_ALERT_COLLAPSE_ID_PREFIX}devicetoken-hex-강남`,
      );
    });

    it('64B를 초과하는 긴 한글 역명은 문자 경계를 보존하며 바이트 단위로 절단된다 (코드리뷰 P1)', () => {
      // '남한산성입구(성남법원.검찰청)' — 코드리뷰 실측 최악 케이스. UTF-8 기준
      // prefix(15) + tripToken 16자 + '-'(1) + 역명(각 글자 3바이트, 괄호/마침표는 3바이트 한글
      // 인접 문자와 혼재)을 합치면 64바이트를 넘는다.
      const tripToken = 'tok-1234567890123456';
      const longStationName = '남한산성입구(성남법원.검찰청)';
      const collapseId = fallbackAlertCollapseId(tripToken, longStationName);
      const base = `${FALLBACK_ALERT_COLLAPSE_ID_PREFIX}${tripToken.slice(0, 16)}-`;
      expect(new TextEncoder().encode(collapseId).length).toBeLessThanOrEqual(64);
      expect(collapseId.startsWith(base)).toBe(true);
      const truncatedStation = collapseId.slice(base.length);
      // 절단이 실제로 station suffix에서 발생했는지 — 원본보다 짧다.
      expect(truncatedStation.length).toBeLessThan(longStationName.length);
      // 문자 경계 보존 확인 — 절단된 접미사가 원본 역명의 코드 포인트 단위 앞부분과
      // 정확히 일치해야 한다(멀티바이트 문자 중간에서 잘렸다면 마지막 문자가 원본과 달라진다).
      const truncatedChars = [...truncatedStation];
      const originalChars = [...longStationName];
      expect(truncatedChars).toEqual(originalChars.slice(0, truncatedChars.length));
    });

    it('짧은 역명은 절단 없이 그대로 유지된다 (회귀 방지)', () => {
      const collapseId = fallbackAlertCollapseId('tok-collapse', '강남');
      expect(collapseId).toBe(`${FALLBACK_ALERT_COLLAPSE_ID_PREFIX}tok-collapse-강남`);
      expect(new TextEncoder().encode(collapseId).length).toBeLessThanOrEqual(64);
    });

    it('alert 발사 시 apns-collapse-id 헤더를 전달한다', async () => {
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-collapse', tripToken: 'tok-collapse', stationName: '강남' }),
      );
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await runFallbackPushes(makeEnv(kv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['apns-collapse-id']).toBe(`${FALLBACK_ALERT_COLLAPSE_ID_PREFIX}tok-collapse-강남`);
    });

    it('fallback 발사 성공 시에만 D1 trip_events에 fallback-alert-fired kind를 기록한다', async () => {
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-d1', tripToken: 'tok-d1', stationName: '강남' }),
      );
      const db = makeMockDb();
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await runFallbackPushes(
        { ...makeEnv(kv), DB: db },
        {
          apnsConfig: apnsConfig(),
          apnsHosts: APNS_HOSTS,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          now: () => NOW,
        },
      );
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO trip_events'));
      expect(db.bind).toHaveBeenCalledWith(
        expect.any(String),
        NOW,
        'fallback-alert-fired',
        '강남',
        null,
        JSON.stringify({ pushId: 'p-d1', ageMs: FALLBACK_THRESHOLD_MS }),
      );
    });

    it('transient 실패(재시도 대상)는 D1에 기록하지 않는다 — 재시도 시 중복 row/거짓 fired 방지 (코드리뷰 P1-2)', async () => {
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-retry', tripToken: 'tok-retry', stationName: '강남' }),
      );
      const db = makeMockDb();
      // 1회차: 503(transient) — entry는 KV에 유지되고 D1엔 기록되지 않아야 한다.
      const fetchImpl1 = vi.fn(async () => new Response('', { status: 503 }));
      const stats1 = await runFallbackPushes(
        { ...makeEnv(kv), DB: db },
        {
          apnsConfig: apnsConfig(),
          apnsHosts: APNS_HOSTS,
          fetchImpl: fetchImpl1 as unknown as typeof fetch,
          now: () => NOW,
        },
      );
      expect(stats1.errors).toBe(1);
      expect(db.prepare).not.toHaveBeenCalled();
      expect(kv.store.has(pendingKey('p-retry'))).toBe(true);

      // 2회차(다음 cron 재시도): 다시 503 — 여전히 D1 0건.
      const fetchImpl2 = vi.fn(async () => new Response('', { status: 503 }));
      await runFallbackPushes(
        { ...makeEnv(kv), DB: db },
        {
          apnsConfig: apnsConfig(),
          apnsHosts: APNS_HOSTS,
          fetchImpl: fetchImpl2 as unknown as typeof fetch,
          now: () => NOW,
        },
      );
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('DB 미바인딩이면 D1 계측 없이 정상 발사(graceful no-op)', async () => {
      await putPending(kv as unknown as KVNamespace, makeEntry({ pushId: 'p-no-db' }));
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const stats = await runFallbackPushes(makeEnv(kv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(stats.pushed).toBe(1);
    });

    it('400/BadCollapseId는 영구 실패로 분류 — entry 삭제 + logPushFailure 기록 (코드리뷰 P1-3 방어 계층)', async () => {
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p-badcollapse', tripToken: 'tok-badcollapse' }),
      );
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ reason: 'BadCollapseId' }), { status: 400 }),
      );
      const stats = await runFallbackPushes(makeEnv(kv), {
        apnsConfig: apnsConfig(),
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => NOW,
      });
      expect(stats.errors).toBe(1);
      expect(kv.store.has(pendingKey('p-badcollapse'))).toBe(false);
    });
  });
});
