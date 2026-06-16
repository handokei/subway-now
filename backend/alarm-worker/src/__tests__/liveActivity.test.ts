import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import {
  LA_DISPLAY_MODE,
  LA_STALE_DURATION_SEC,
  buildLiveActivityContentState,
  cleanupTripWithLa,
  fireLiveActivityDismissal,
  fireLiveActivityUpdate,
  type LiveActivityDeps,
  type LiveActivityStats,
} from '../liveActivity';
import type { ApnsEnv, Env, Trip, TripEndedReason, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: pem,
    bundleId: 'com.example.app',
  };
});

beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;
const APNS_HOSTS: Record<ApnsEnv, string> = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
};

function makeStats(): LiveActivityStats {
  return {
    laPushSent: 0,
    laPushFailed: 0,
    laTokenCleared: 0,
    pushConsistencyLAFallback: 0,
  };
}

function makeDeps(fetchImpl: typeof fetch): LiveActivityDeps {
  return { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'devtoken',
    route: { type: 'direct', line: '2', stops: 3 },
    destination: 'dst',
    waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
    expiresAt: NOW + 3_600_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000,
    activityPushToken: 'la-token',
    activityState: 'live',
    apnsEnv: 'sandbox',
    ...overrides,
  };
}

const WAYPOINT: Waypoint = { stationName: '강남', line: '2', kind: 'destination' };

describe('buildLiveActivityContentState (#613)', () => {
  it('emits widget-aligned schema (stationName/lineName/lineColorHex/stopsRemaining/etaMinutes)', () => {
    const cs = buildLiveActivityContentState(WAYPOINT, 90, 3);
    expect(cs).toEqual({
      stationName: '강남',
      lineName: '2호선',
      lineColorHex: '#009D3E',
      stopsRemaining: 3,
      etaMinutes: 2, // round(90/60) = 2
    });
  });

  it('rounds etaSeconds to minutes and clamps negative to 0', () => {
    expect(buildLiveActivityContentState(WAYPOINT, 29, 1).etaMinutes).toBe(0);
    expect(buildLiveActivityContentState(WAYPOINT, 30, 1).etaMinutes).toBe(1);
    expect(buildLiveActivityContentState(WAYPOINT, -5, 1).etaMinutes).toBe(0);
  });

  it('maps known line code to canonical name and color', () => {
    const wp: Waypoint = { stationName: '서울', line: '1', kind: 'transfer' };
    const cs = buildLiveActivityContentState(wp, 60, 2);
    expect(cs.lineName).toBe('1호선');
    expect(cs.lineColorHex).toBe('#0052A4');
  });

  it('falls back to raw line code and neutral color for unknown line', () => {
    const wp: Waypoint = { stationName: '미지역', line: 'unknown', kind: 'intermediate' };
    const cs = buildLiveActivityContentState(wp, 60, 2);
    expect(cs.lineName).toBe('unknown');
    expect(cs.lineColorHex).toBe('#888888');
  });

  it('does not include phase / etaSeconds / arrivalAtSec / alarmType (omitted to avoid forcing widget urgent UI)', () => {
    const cs = buildLiveActivityContentState(WAYPOINT, 90, 3);
    expect(cs).not.toHaveProperty('phase');
    expect(cs).not.toHaveProperty('etaSeconds');
    expect(cs).not.toHaveProperty('kind');
    expect(cs).not.toHaveProperty('arrivalAtSec');
    expect(cs).not.toHaveProperty('alarmType');
    expect(cs).not.toHaveProperty('alarmStationName');
  });

  // #1389 PR-4 — 정합성 fallback 표시 모드.
  describe('displayMode (#1389 PR-4)', () => {
    it('omits displayMode key when default (confirmed) — 기존 LA 인스턴스 회귀 안전', () => {
      const cs = buildLiveActivityContentState(WAYPOINT, 90, 3);
      expect(cs).not.toHaveProperty('displayMode');
    });

    it('omits displayMode key when explicit confirmed', () => {
      const cs = buildLiveActivityContentState(
        WAYPOINT,
        90,
        3,
        LA_DISPLAY_MODE.CONFIRMED,
      );
      expect(cs).not.toHaveProperty('displayMode');
    });

    it('includes displayMode=unconfirmed when explicitly set', () => {
      const cs = buildLiveActivityContentState(
        WAYPOINT,
        90,
        3,
        LA_DISPLAY_MODE.UNCONFIRMED,
      );
      expect(cs.displayMode).toBe(LA_DISPLAY_MODE.UNCONFIRMED);
    });

    it('LA_DISPLAY_MODE wire format values are stable', () => {
      // Swift mirror(`targets/subway-widget/_shared/SubwayActivityAttributes.swift`)에서
      // 동일 문자열을 case 분기 — 값이 바뀌면 widget UI 분기가 끊긴다 (회귀 가드).
      expect(LA_DISPLAY_MODE.CONFIRMED).toBe('confirmed');
      expect(LA_DISPLAY_MODE.UNCONFIRMED).toBe('unconfirmed');
    });
  });
});

describe('fireLiveActivityUpdate', () => {
  it('no-ops when activityPushToken is missing', async () => {
    const fetchImpl = vi.fn();
    const stats = makeStats();
    const trip = makeTrip({ activityPushToken: undefined });
    const r = await fireLiveActivityUpdate(
      trip,
      { etaSeconds: 1 },
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stats.laPushSent).toBe(0);
  });

  it('no-ops when activityState is not live (ended)', async () => {
    const fetchImpl = vi.fn();
    const stats = makeStats();
    const trip = makeTrip({ activityState: 'ended' });
    const r = await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to LA endpoint with staleDate = now/1000 + 90 and increments laPushSent on success', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityUpdate(
      trip,
      { etaSeconds: 30 },
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${APNS_HOSTS.sandbox}/3/device/la-token`);
    const body = JSON.parse(init.body as string);
    expect(body.aps.event).toBe('update');
    expect(body.aps['stale-date']).toBe(Math.floor(NOW / 1000) + LA_STALE_DURATION_SEC);
    expect(stats.laPushSent).toBe(1);
    expect(stats.laPushFailed).toBe(0);
  });

  it('uses production host when apnsEnv=production', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const trip = makeTrip({ apnsEnv: 'production' });
    await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${APNS_HOSTS.production}/3/device/la-token`);
  });

  it('clears token + sets ended on 410 (dirty=true)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 410 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    const r = await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(true);
    expect(trip.activityPushToken).toBeUndefined();
    expect(trip.activityState).toBe('ended');
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(1);
  });

  it('does not clear on non-410 failure (dirty=false)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'InternalServerError' }), { status: 500 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    const r = await fireLiveActivityUpdate(
      trip,
      {},
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(r.dirty).toBe(false);
    expect(trip.activityPushToken).toBe('la-token');
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(0);
  });
});

describe('fireLiveActivityDismissal', () => {
  it('no-ops when no token', async () => {
    const fetchImpl = vi.fn();
    const trip = makeTrip({ activityPushToken: undefined });
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops when state is already ended', async () => {
    const fetchImpl = vi.fn();
    const trip = makeTrip({ activityState: 'ended' });
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends end event with dismissalDate=now/1000 and transitions trip to ended on success', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.aps.event).toBe('end');
    expect(body.aps['dismissal-date']).toBe(Math.floor(NOW / 1000));
    expect(trip.activityPushToken).toBeUndefined();
    expect(trip.activityState).toBe('ended');
    expect(stats.laPushSent).toBe(1);
  });

  it('still transitions to ended even when push fails (best-effort)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 410 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(trip.activityPushToken).toBeUndefined();
    expect(trip.activityState).toBe('ended');
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(1);
  });

  it('increments laPushFailed but not laTokenCleared on non-410 failure', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'ServerUnavailable' }), { status: 503 }),
    );
    const stats = makeStats();
    const trip = makeTrip();
    await fireLiveActivityDismissal(
      trip,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(stats.laPushFailed).toBe(1);
    expect(stats.laTokenCleared).toBe(0);
  });
});

describe('cleanupTripWithLa', () => {
  it('fires dismissal then deletes trip from KV', async () => {
    const kv = new InMemoryKV();
    await kv.put('trip:devtoken', JSON.stringify(makeTrip()));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = makeStats();
    await cleanupTripWithLa(
      makeTrip(),
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      stats,
      NOW,
      () => undefined,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stats.laPushSent).toBe(1);
    expect(await kv.get('trip:devtoken')).toBeNull();
  });

  it('still deletes trip when no LA token (no push fired)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({ activityPushToken: undefined });
    await kv.put('trip:devtoken', JSON.stringify(trip));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    const fetchImpl = vi.fn();
    await cleanupTripWithLa(
      trip,
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await kv.get('trip:devtoken')).toBeNull();
  });

  // #1283 — trip-ended push도 다른 push 경로와 동일하게 env-heal 적용.
  it('trip-ended push self-heals on BadDeviceToken (opposite-host retry)', async () => {
    const kv = new InMemoryKV();
    // activityPushToken 없음 → dismissal skip, trip-ended push만 발사돼 호출을 격리.
    const trip = makeTrip({ activityPushToken: undefined, apnsEnv: 'sandbox' });
    await kv.put('trip:devtoken', JSON.stringify(trip));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      // 1차 sandbox host → BadDeviceToken, 2차 production host → 성공.
      if (url.includes(APNS_HOSTS.sandbox)) {
        return new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 });
      }
      return new Response('', { status: 200 });
    });
    await cleanupTripWithLa(
      trip,
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      () => undefined,
      'eta-missing',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[0]).toContain(APNS_HOSTS.sandbox);
    expect(calls[1]).toContain(APNS_HOSTS.production);
    expect(await kv.get('trip:devtoken')).toBeNull();
  });

  it('trip-ended push logs failure when both hosts reject (env mismatch exhausted)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({ activityPushToken: undefined, apnsEnv: 'sandbox' });
    await kv.put('trip:devtoken', JSON.stringify(trip));
    const env = { TRIPS: kv as unknown as KVNamespace } as Env;
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const logs: string[] = [];
    await cleanupTripWithLa(
      trip,
      env,
      makeDeps(fetchImpl as unknown as typeof fetch),
      makeStats(),
      NOW,
      (msg) => logs.push(msg),
      'eta-missing',
    );
    // 1차 + retry 모두 호출, 둘 다 실패 → 'trip-ended push failed' 로그.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(logs).toContain('trip-ended push failed');
    expect(await kv.get('trip:devtoken')).toBeNull();
  });

  // #1337 — KV `tripEndedAlert:{tripToken}:{createdAt}` set-if-absent gate. 같은 trip의 cleanup이 race로
  // 두 번 호출돼도 alert가 1회만 발사된다. 실패 push는 stamp X → 다음 cycle 재시도 허용.
  describe('trip-ended alert KV dedup gate (#1337)', () => {
    type FetchFn = ReturnType<typeof vi.fn>;
    const arrange = async (fetchImpl: FetchFn, tripOverrides: Partial<Trip> = {}) => {
      const kv = new InMemoryKV();
      const trip = makeTrip({ activityPushToken: undefined, ...tripOverrides });
      await kv.put('trip:devtoken', JSON.stringify(trip));
      const env = { TRIPS: kv as unknown as KVNamespace } as Env;
      return { kv, trip, env, fetchImpl };
    };
    const runCleanup = (
      ctx: { trip: Trip; env: Env; fetchImpl: FetchFn },
      reason: TripEndedReason,
      log: (message: string, meta?: Record<string, unknown>) => void = () => undefined,
      atNow: number = NOW,
    ) =>
      cleanupTripWithLa(
        ctx.trip,
        ctx.env,
        makeDeps(ctx.fetchImpl as unknown as typeof fetch),
        makeStats(),
        atNow,
        log,
        reason,
      );

    it('success 시 dedup stamp 저장 → 동일 trip 재 cleanup 호출 시 alert push skip', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const ctx = await arrange(fetchImpl);
      await runCleanup(ctx, 'eta-missing');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await ctx.kv.get(`tripEndedAlert:devtoken:${NOW}`)).toBe('1');

      // 2차 cleanup (동일 cron 사이클 내 race) — dedup으로 push skip
      const trip2 = makeTrip({ activityPushToken: undefined });
      await ctx.kv.put('trip:devtoken', JSON.stringify(trip2));
      const logs: string[] = [];
      await runCleanup({ ...ctx, trip: trip2 }, 'destination-arrived', (m) => logs.push(m));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(logs).toContain('trip-ended alert: dedup skip');
    });

    it('실패 push (양쪽 host 모두 reject) 시 dedup stamp 저장 X → 다음 사이클 재시도 허용', async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
      );
      const ctx = await arrange(fetchImpl);
      await runCleanup(ctx, 'eta-missing');
      // env-heal 1차+retry 둘 다 호출되지만 둘 다 실패.
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(await ctx.kv.get(`tripEndedAlert:devtoken:${NOW}`)).toBeNull();
    });

    it('throw 발생 시 dedup stamp 저장 X', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('network down');
      });
      const ctx = await arrange(fetchImpl);
      await runCleanup(ctx, 'expired');
      expect(await ctx.kv.get(`tripEndedAlert:devtoken:${NOW}`)).toBeNull();
      // throw 흡수 후 cleanup 흐름 계속 → trip 삭제됨
      expect(await ctx.kv.get('trip:devtoken')).toBeNull();
    });

    // 회귀 가드: trip.token = device APNs token 이라 같은 디바이스의 후속 trip이 동일 token을
    // 재사용한다. dedup key가 token만으로 구성되면 trip A 종료 후 곧이어 시작한 trip B의 종료
    // alert가 stale stamp에 막혀 사라진다(#1337 acceptance 회귀). (token, createdAt) 페어로
    // trip-instance 단위 격리하는지 검증.
    it('동일 device(token)의 다른 trip-instance(createdAt) 는 dedup 안 됨 (각자 alert 발사)', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      // Trip A: createdAt=NOW
      const ctxA = await arrange(fetchImpl, { createdAt: NOW });
      await runCleanup(ctxA, 'destination-arrived');
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Trip B: same token, 다른 createdAt (예: 1분 뒤 새 trip 등록)
      const tripB = makeTrip({ activityPushToken: undefined, createdAt: NOW + 60_000 });
      await ctxA.kv.put('trip:devtoken', JSON.stringify(tripB));
      await runCleanup({ ...ctxA, trip: tripB }, 'eta-missing', undefined, NOW + 60_000);
      // Trip B의 alert도 발사돼야 함 (총 2회)
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(await ctxA.kv.get(`tripEndedAlert:devtoken:${NOW}`)).toBe('1');
      expect(await ctxA.kv.get(`tripEndedAlert:devtoken:${NOW + 60_000}`)).toBe('1');
    });
  });

  // #1339 — launch reconciliation 백스톱. cleanupTripWithLa가 reason과 함께 호출되면
  // 모든 trip-ended 경로(scheduled.ts의 4 발사 지점)가 자동으로 status marker를 KV에 적재한다.
  describe('writes trip-ended status marker for launch reconciliation (#1339)', () => {
    const reasonMatrix = [
      { reason: 'expired' as const, expected: 'expired' },
      { reason: 'eta-missing' as const, expected: 'eta-missing' },
      { reason: 'destination-arrived' as const, expected: 'destination' },
      { reason: 'push-unrecoverable' as const, expected: 'push-unrecoverable' },
    ];

    for (const { reason, expected } of reasonMatrix) {
      it(`writes status=${expected} when cleanup called with reason ${reason}`, async () => {
        const kv = new InMemoryKV();
        const trip = makeTrip({ activityPushToken: undefined });
        await kv.put('trip:devtoken', JSON.stringify(trip));
        const env = { TRIPS: kv as unknown as KVNamespace } as Env;
        const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
        await cleanupTripWithLa(
          trip,
          env,
          makeDeps(fetchImpl as unknown as typeof fetch),
          makeStats(),
          NOW,
          () => undefined,
          reason,
        );
        const raw = kv.store.get('tripStatus:devtoken');
        expect(raw).toBeDefined();
        expect(JSON.parse(raw!.value)).toEqual({ endedAt: NOW, endReason: expected });
        // trip 자체는 여전히 삭제됨.
        expect(await kv.get('trip:devtoken')).toBeNull();
      });
    }

    it('does not write a marker when reason is omitted (HTTP DELETE path)', async () => {
      const kv = new InMemoryKV();
      const trip = makeTrip({ activityPushToken: undefined });
      await kv.put('trip:devtoken', JSON.stringify(trip));
      const env = { TRIPS: kv as unknown as KVNamespace } as Env;
      await cleanupTripWithLa(
        trip,
        env,
        makeDeps(vi.fn() as unknown as typeof fetch),
        makeStats(),
        NOW,
        () => undefined,
      );
      expect(kv.store.has('tripStatus:devtoken')).toBe(false);
    });

    it('logs but does not throw when status write fails (cleanup continues)', async () => {
      // KV.put이 throw하는 broken 환경. cleanup 흐름은 끝까지 진행돼야 한다.
      const kv = new InMemoryKV();
      const trip = makeTrip({ activityPushToken: undefined });
      await kv.put('trip:devtoken', JSON.stringify(trip));
      const brokenKv = {
        get: kv.get.bind(kv),
        put: vi.fn(async (key: string) => {
          if (key.startsWith('tripStatus:')) throw new Error('kv down');
          return undefined;
        }),
        delete: kv.delete.bind(kv),
        list: kv.list.bind(kv),
      };
      const env = { TRIPS: brokenKv as unknown as KVNamespace } as Env;
      const logs: string[] = [];
      await cleanupTripWithLa(
        trip,
        env,
        makeDeps(vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch),
        makeStats(),
        NOW,
        (msg) => logs.push(msg),
        'expired',
      );
      expect(logs).toContain('trip-status write failed');
    });
  });
});
