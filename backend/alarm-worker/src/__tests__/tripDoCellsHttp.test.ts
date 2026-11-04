/**
 * #3300 옵션 D PR-3a — HTTP 쪽을 DO lock 셀 / LA 셀에 연결한 효과 (plan §4 PR-3a, §9, §10).
 *
 * 재현 입력(불변 실측):
 *  - 11/03 lock 소실: tasks/evidence-2026-11-03-lock-loss-d1.json — 성수|뚝섬 2호선 트립(토큰 해시 b00dd879).
 *      id 2042 18:46:46 sync-received -> id 2046 18:46:59 lock-attached(path:confirm, trainCode 3334)
 *      -> id 2049 18:47:01 sync-received. 18:47:45 `leg-boarding-prompt silenced`(id 2050)가 보여주듯 이후 lock이 없다.
 *  - 11/04 LA 토큰 소실: tasks/evidence-2026-11-04-ride-d1.json —
 *      id 2168 17:24:56 la-token-register(hadToken:false) -> id 2172 17:25:13 trip-register(existedAtRequestStart:true)
 *      -> id 2173 17:25:37 la-token-register(hadToken:false).
 * KV 엣지 캐시 지연은 CacheLagKV(`trip:` 읽기 cacheTtl 기본 60s = 지연)로 모델링한다. flag off는 현행 동작(red 재현:
 * lock·토큰 소실), `lock@1`은 셀이 권위라 유지된다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { getTrip, putTrip } from '../trips';
import { resetCellStageCache, runLockOp } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import type { Env, Trip } from '../types';
import { CacheLagKV } from './helpers/cacheLagKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';

const TOKEN = 'cells-3300-tok';
const kstMs = (iso: string): number => Date.parse(`${iso}+09:00`);
const HOUR_MS = 60 * 60_000;

interface Ctx {
  env: Env;
  kv: CacheLagKV;
  doNs: ReturnType<typeof makeFakeTripDoNamespace>;
}

async function makeCtx(flag?: string): Promise<Ctx> {
  const kv = new CacheLagKV(0, { byCacheTtl: { defaultTtlSec: 60, laggedPrefixes: ['trip:'] } });
  const doNs = makeFakeTripDoNamespace();
  const env = {
    TRIPS: kv as unknown as KVNamespace,
    TRIP_DO: doNs.ns,
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  } as Env;
  if (flag) await setTripDoFlag(env.TRIPS, flag);
  resetCellStageCache(kv);
  return { env, kv, doNs };
}

function seedTrip(createdAt: number, overrides: Partial<Trip> = {}): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 2 } as unknown as Trip['route'],
    destination: '건대입구',
    waypoints: [
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '건대입구', line: '2', kind: 'destination' },
    ],
    expiresAt: createdAt + 3 * HOUR_MS,
    createdAt,
    alarmAtEpochMs: createdAt,
    infoModeEnabled: true,
    promptDisplay: { originStation: '뚝섬', line: '2' },
    ...overrides,
  };
}

async function post(path: string, body: unknown, env: Env): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

/** KV의 최신 값(캐시 지연 무시). */
const latestKv = async (kv: CacheLagKV): Promise<Trip | undefined> => {
  const raw = await (kv as unknown as { store: Map<string, { value: string }> }).store.get(`trip:${TOKEN}`)?.value;
  return raw === undefined ? undefined : (JSON.parse(raw) as Trip);
};

/** 지정한 lock op가 DO로 들어가기 **직전**에 한 번 콜백을 실행하는 namespace 래퍼(읽기-쓰기 사이 끼어들기 재현). */
function hookBeforeOp(ns: DurableObjectNamespace, opType: string, before: () => Promise<void>): DurableObjectNamespace {
  let fired = false;
  return {
    idFromName: (name: string) => ns.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = ns.get(id);
      return {
        fetch: async (request: Request): Promise<Response> => {
          if (!fired && request.method === 'POST' && new URL(request.url).pathname === '/lock/op') {
            const { op } = (await request.clone().json()) as { op: { type: string } };
            if (op.type === opType) {
              fired = true;
              await before();
            }
          }
          return stub.fetch(request);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

const confirmBoarded = (env: Env) =>
  post(`/trips/${TOKEN}/boarding-confirm`, { action: 'boarded', station: '뚝섬', line: '2', trainCode: '3334' }, env);
const syncAtOrigin = (env: Env, now: number) =>
  post('/boarding-lock/sync', { token: TOKEN, observedStationName: '뚝섬', observedAtMs: now, accuracy: 20 }, env);

describe('#3300 PR-3a — 11/03 재현: confirm lock 3334 -> 낡은 시야의 sync commit', () => {
  const CREATED = kstMs('2026-11-03T18:45:00');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** 18:44:00 등록 -> 18:46:59 confirm(evidence id 2046) -> 18:47:01 sync(id 2049, 60s 캐시 = 18:46:01 스냅샷). */
  async function replay(flag?: string) {
    const ctx = await makeCtx(flag);
    vi.setSystemTime(kstMs('2026-11-03T18:44:00'));
    await ctx.kv.put(`trip:${TOKEN}`, JSON.stringify(seedTrip(CREATED)));
    vi.setSystemTime(kstMs('2026-11-03T18:46:59'));
    const confirm = await confirmBoarded(ctx.env);
    vi.setSystemTime(kstMs('2026-11-03T18:47:01'));
    const sync = await syncAtOrigin(ctx.env, Date.now());
    // 18:47:45 cron tick 시점의 시야 — KV는 60s 캐시 지연 모델.
    vi.setSystemTime(kstMs('2026-11-03T18:47:45'));
    return { ...ctx, confirm, sync };
  }

  it('flag off (현행): lock 3334가 낡은 sync commit에 덮여 소실된다 (red 재현)', async () => {
    const { env, confirm, sync, kv } = await replay();
    expect(confirm.status).toBe(200);
    expect(await confirm.json()).toMatchObject({ lockState: 'leg1', resolvedTrainCode: '3334' });
    expect(sync.status).toBe(200);
    // cron 시야(KV 단독): 18:47:01 sync가 lock 없는 trip을 통째로 썼다.
    expect((await getTrip(env.TRIPS, TOKEN))?.boardingLock).toBeUndefined();
    expect((await latestKv(kv))?.boardingLock).toBeUndefined();
  });

  it('lock@1: 셀이 권위라 lock 3334가 유지된다 (cron 시야 = overlay)', async () => {
    const { env, confirm, sync } = await replay('lock@1');
    expect(confirm.status).toBe(200);
    expect(sync.status).toBe(200);
    const seen = await getTrip(env, TOKEN);
    expect(seen?.boardingLock?.trainCode).toBe('3334');
    expect(seen?.lockEverAttached).toBe(true);
  });

  it('lock@1: 셀을 우회한 낡은 통째 KV 쓰기(lock 없음)도 overlay가 덮어 lock을 유지한다', async () => {
    const { env, kv } = await replay('lock@1');
    const stale = seedTrip(CREATED, { infoModeEnabled: false });
    await kv.put(`trip:${TOKEN}`, JSON.stringify(stale));
    vi.setSystemTime(kstMs('2026-11-03T18:49:00'));
    expect((await getTrip(env.TRIPS, TOKEN))?.boardingLock).toBeUndefined();
    expect((await getTrip(env, TOKEN))?.boardingLock?.trainCode).toBe('3334');
  });

  it('flag off: DO 호출 0 — TRIP_DO.get이 한 번도 불리지 않는다', async () => {
    const ctx = await makeCtx();
    const getSpy = vi.spyOn(ctx.doNs.ns, 'get');
    vi.setSystemTime(kstMs('2026-11-03T18:44:00'));
    await ctx.kv.put(`trip:${TOKEN}`, JSON.stringify(seedTrip(CREATED)));
    vi.setSystemTime(kstMs('2026-11-03T18:46:59'));
    expect((await confirmBoarded(ctx.env)).status).toBe(200);
    vi.setSystemTime(kstMs('2026-11-03T18:47:01'));
    expect((await syncAtOrigin(ctx.env, Date.now())).status).toBe(200);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('lock@1: DO가 죽으면 lock 변경 대신 503(fail-closed) — 낡은 시야로 쓰지 않는다', async () => {
    const ctx = await makeCtx('lock@1');
    vi.setSystemTime(kstMs('2026-11-03T18:44:00'));
    await ctx.kv.put(`trip:${TOKEN}`, JSON.stringify(seedTrip(CREATED)));
    vi.spyOn(ctx.doNs.ns, 'get').mockImplementation(() => {
      throw new Error('do down');
    });
    vi.setSystemTime(kstMs('2026-11-03T18:46:59'));
    const res = await confirmBoarded(ctx.env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'lock_cell_unavailable' });
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect((await latestKv(ctx.kv))?.boardingLock).toBeUndefined();
  });
});

describe('#3300 PR-3a — 11/04 재현(LA): 토큰 등록 -> 낡은 캐시 재등록', () => {
  const CREATED = kstMs('2026-11-04T17:22:00');
  const registerBody = (): Record<string, unknown> => ({
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 2 },
    destination: '건대입구',
    waypoints: [
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '건대입구', line: '2', kind: 'destination' },
    ],
    expiresAt: CREATED + 3 * HOUR_MS,
    alarmAtEpochMs: CREATED + 30 * 60_000,
    createdAt: CREATED,
    infoModeEnabled: false,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** 17:23:30 등록(첫 register) -> 17:24:56 LA 토큰(id 2168) -> 17:25:13 재등록(id 2172, KV는 17:24:13 스냅샷). */
  async function replay(flag?: string) {
    const ctx = await makeCtx(flag);
    vi.setSystemTime(kstMs('2026-11-04T17:23:30'));
    expect((await post('/trips', registerBody(), ctx.env)).status).toBe(200);
    vi.setSystemTime(kstMs('2026-11-04T17:24:56'));
    const la = await post('/live-activity/register', { tripToken: TOKEN, activityPushToken: 'la-token-A' }, ctx.env);
    vi.setSystemTime(kstMs('2026-11-04T17:25:13'));
    const reregister = await post('/trips', registerBody(), ctx.env);
    vi.setSystemTime(kstMs('2026-11-04T17:26:30'));
    return { ...ctx, la, reregister };
  }

  it('flag off (현행): 재등록이 LA 토큰을 지운다 (red 재현)', async () => {
    const { kv, la, reregister } = await replay();
    expect(la.status).toBe(200);
    expect(reregister.status).toBe(200);
    const stored = await latestKv(kv);
    expect(stored?.activityPushToken).toBeUndefined();
  });

  it('lock@1: 셀이 권위라 토큰이 유지된다 (KV blob·overlay 둘 다)', async () => {
    const { env, kv, la, reregister } = await replay('lock@1');
    expect(la.status).toBe(200);
    expect(reregister.status).toBe(200);
    expect((await latestKv(kv))?.activityPushToken).toBe('la-token-A');
    const seen = await getTrip(env, TOKEN);
    expect(seen?.activityPushToken).toBe('la-token-A');
    expect(seen?.activityState).toBe('live');
  });

  it('lock@1: DELETE /live-activity는 셀 토큰을 비우고 state=ended를 남긴다', async () => {
    const { env } = await replay('lock@1');
    const res = await app.fetch(new Request(`http://example.com/live-activity/${TOKEN}`, { method: 'DELETE' }), env);
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    const seen = await getTrip(env, TOKEN);
    expect(seen?.activityPushToken).toBeUndefined();
    expect(seen?.activityState).toBe('ended');
  });
});

describe('#3300 PR-3a — register carry 결합 필드는 셀 값이 권위 (§9)', () => {
  const CREATED = kstMs('2026-11-03T18:00:00');
  const registerBody = (): Record<string, unknown> => ({
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 2 },
    destination: '건대입구',
    waypoints: [
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '건대입구', line: '2', kind: 'destination' },
    ],
    expiresAt: CREATED + 3 * HOUR_MS,
    alarmAtEpochMs: CREATED + 30 * 60_000,
    createdAt: CREATED,
    infoModeEnabled: false,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(kstMs('2026-11-03T18:10:00'));
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function run(flag?: string) {
    const ctx = await makeCtx(flag);
    // 낡은 KV blob: consecutiveEtaMissing=2. 셀에는 그 뒤 값 5가 있다(cron이 올린 것으로 가정).
    await ctx.kv.put(`trip:${TOKEN}`, JSON.stringify(seedTrip(CREATED, { consecutiveEtaMissing: 2 })));
    vi.setSystemTime(kstMs('2026-11-03T18:12:00'));
    if (flag) {
      const seeded = await getTrip(ctx.env, TOKEN);
      await runLockOp(
        ctx.env,
        TOKEN,
        { type: 'setEtaMissing', source: 'test', expectedRev: seeded?.__lockRev ?? -1, value: 5 },
        Date.now(),
      );
    }
    const res = await post('/trips', registerBody(), ctx.env);
    return { ...ctx, res };
  }

  it('flag off (현행): 낡은 existing의 consecutiveEtaMissing(2)이 그대로 carry된다', async () => {
    const { kv, res } = await run();
    expect(res.status).toBe(200);
    expect((await latestKv(kv))?.consecutiveEtaMissing).toBe(2);
  });

  it('lock@1: 셀 값(5)이 이긴다', async () => {
    const { kv, res } = await run('lock@1');
    expect(res.status).toBe(200);
    expect((await latestKv(kv))?.consecutiveEtaMissing).toBe(5);
  });

  /**
   * register가 existing을 읽은 **뒤** registerSession op 직전에 셀이 바뀐다(cron이 카운터를 올리고 사용자가 lock을 부착).
   * 읽기 시점의 existing carry(consecutiveEtaMissing=2, lock 없음)가 아니라 op 시점의 셀 값이 이겨야 한다.
   */
  it('lock@1: existing 읽기 이후 셀이 바뀌어도 op 시점의 셀 값(카운터 5 · lock 3334)이 carry된다', async () => {
    const ctx = await makeCtx('lock@1');
    await ctx.kv.put(`trip:${TOKEN}`, JSON.stringify(seedTrip(CREATED, { consecutiveEtaMissing: 2 })));
    vi.setSystemTime(kstMs('2026-11-03T18:12:00'));
    const hooked = hookBeforeOp(ctx.doNs.ns, 'registerSession', async () => {
      const cell = await getTrip(ctx.env, TOKEN);
      const rev = cell?.__lockRev ?? -1;
      await runLockOp(ctx.env, TOKEN, { type: 'setEtaMissing', source: 'test', expectedRev: rev, value: 5 }, Date.now());
      await runLockOp(
        ctx.env,
        TOKEN,
        {
          type: 'userBoarded',
          source: 'test',
          expectedRev: rev,
          releaseFirst: false,
          lock: {
            trainCode: '3334',
            line: '2',
            subwayId: '1002',
            selectedDepartureTime: CREATED,
            segmentStations: ['뚝섬', '성수', '건대입구'],
            expiresAt: CREATED + HOUR_MS,
          },
        },
        Date.now(),
      );
    });
    const res = await post('/trips', registerBody(), { ...ctx.env, TRIP_DO: hooked });
    expect(res.status).toBe(200);
    const stored = await latestKv(ctx.kv);
    expect(stored?.boardingLock?.trainCode).toBe('3334');
    // lock 부착(userBoarded)이 결합 필드를 새 lock 기준으로 초기화한다 — 낡은 카운터 2도, 중간 값도 아닌 셀 값.
    expect(stored?.consecutiveEtaMissing).toBe(0);
  });
});

describe('#3300 PR-3a — __lockRev는 직렬화 사본에서만 제거 (§9)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('putTrip 후 같은 객체로 다음 op가 성공한다 (KV blob에는 __lockRev가 없다)', async () => {
    const CREATED = kstMs('2026-11-03T18:00:00');
    vi.setSystemTime(kstMs('2026-11-03T18:10:00'));
    const ctx = await makeCtx('lock@1');
    const lock = {
      trainCode: '3334',
      line: '2',
      subwayId: '1002',
      selectedDepartureTime: CREATED,
      segmentStations: ['뚝섬', '성수', '건대입구'],
      expiresAt: CREATED + HOUR_MS,
    };
    await ctx.kv.put(`trip:${TOKEN}`, JSON.stringify(seedTrip(CREATED, { boardingLock: lock })));
    vi.setSystemTime(kstMs('2026-11-03T18:12:00'));

    const trip = await getTrip(ctx.env, TOKEN);
    expect(trip?.__lockRev).toBeDefined();
    if (!trip) throw new Error('trip missing');

    await putTrip(ctx.env.TRIPS, trip);
    expect(trip.__lockRev).toBeDefined();
    expect(JSON.stringify(await latestKv(ctx.kv))).not.toContain('__lockRev');

    const released = await runLockOp(
      ctx.env,
      TOKEN,
      { type: 'releaseAuto', source: 'test', expectedRev: trip.__lockRev as number, reason: 'test' },
      Date.now(),
    );
    expect(released.outcome).toBe('applied');
  });
});

describe('#3300 PR-3a — confirm 하차 / sync TTL·승격·환승 해제 op', () => {
  const CREATED = kstMs('2026-11-03T18:00:00');
  const lock = (trainCode = '3334') => ({
    trainCode,
    line: '2',
    subwayId: '1002',
    selectedDepartureTime: CREATED,
    segmentStations: ['뚝섬', '성수', '건대입구'],
    expiresAt: CREATED + HOUR_MS,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(kstMs('2026-11-03T18:10:00'));
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function withLock(trip: Trip) {
    const ctx = await makeCtx('lock@1');
    await ctx.kv.put(`trip:${TOKEN}`, JSON.stringify(trip));
    vi.setSystemTime(kstMs('2026-11-03T18:12:00'));
    return ctx;
  }

  it('confirm 하차: 셀 lock을 해제하고(applied) 응답은 released', async () => {
    const { env } = await withLock(seedTrip(CREATED, { boardingLock: lock(), consecutiveEtaMissing: 3 }));
    const res = await post(`/trips/${TOKEN}/boarding-confirm`, { action: 'disembarked', station: '성수', line: '2' }, env);
    expect(await res.json()).toEqual({ ok: true, lockState: 'released' });
    const seen = await getTrip(env, TOKEN);
    expect(seen?.boardingLock).toBeUndefined();
    expect(seen?.consecutiveEtaMissing).toBe(0);
  });

  it('confirm 하차: 셀 lock이 다른 leg로 바뀌어 있으면(conflict) 해제하지 않고 응답도 셀 기준', async () => {
    const ctx = await withLock(seedTrip(CREATED, { boardingLock: lock() }));
    const hooked = hookBeforeOp(ctx.doNs.ns, 'userDisembarked', async () => {
      const seen = await getTrip(ctx.env, TOKEN);
      await runLockOp(ctx.env, TOKEN, { type: 'releaseAuto', source: 'test', expectedRev: seen?.__lockRev ?? -1, reason: 'swap-leg' }, Date.now());
      await runLockOp(
        ctx.env,
        TOKEN,
        {
          type: 'attachIfNone',
          source: 'test',
          authority: 'user',
          expectedRev: 0,
          lock: { ...lock('9999'), segmentStations: ['건대입구', '어린이대공원'], line: '7' },
        },
        Date.now(),
      );
    });
    const res = await post(
      `/trips/${TOKEN}/boarding-confirm`,
      { action: 'disembarked', station: '성수', line: '2' },
      { ...ctx.env, TRIP_DO: hooked },
    );
    expect(await res.json()).toMatchObject({ ok: true, lockState: 'leg1' });
    expect((await getTrip(ctx.env, TOKEN))?.boardingLock?.trainCode).toBe('9999');
  });

  it('sync TTL 갱신: refreshExpiry로 셀 lock의 expiresAt이 now+30분으로 늘고 rev는 그대로', async () => {
    const ctx = await withLock(seedTrip(CREATED, { boardingLock: { ...lock(), expiresAt: CREATED + 20 * 60_000 } }));
    const before = await getTrip(ctx.env, TOKEN);
    const res = await syncAtOrigin(ctx.env, Date.now());
    expect(res.status).toBe(200);
    const after = await getTrip(ctx.env, TOKEN);
    expect(after?.boardingLock?.expiresAt).toBe(Date.now() + 30 * 60_000);
    expect(after?.__lockRev).toBe(before?.__lockRev);
  });

  it('sync 수동 목록 탭 승격(trainCode+boardingLine): 셀에 user 권위로 부착된다', async () => {
    const ctx = await withLock(seedTrip(CREATED));
    const res = await post(
      '/boarding-lock/sync',
      { token: TOKEN, observedStationName: '뚝섬', observedAtMs: Date.now(), accuracy: 20, trainCode: '3334', boardingLine: '2' },
      ctx.env,
    );
    expect(res.status).toBe(200);
    vi.setSystemTime(kstMs('2026-11-03T18:14:00')); // KV 60s 캐시 지연이 지나 sync commit이 보인다.
    const seen = await getTrip(ctx.env, TOKEN);
    expect(seen?.boardingLock?.trainCode).toBe('3334');
    expect(seen?.boardingResponse).toBeDefined();
  });

  it('sync 환승 소비로 메모리 lock이 풀리면 셀도 releaseAuto로 풀린다', async () => {
    const waypoints: Trip['waypoints'] = [
      { stationName: '건대입구', line: '2', kind: 'transfer' },
      { stationName: '어린이대공원', line: '7', kind: 'intermediate' },
      { stationName: '군자', line: '7', kind: 'destination' },
    ];
    const ctx = await withLock(
      seedTrip(CREATED, { boardingLock: { ...lock(), segmentStations: ['뚝섬', '성수', '건대입구'] }, waypoints, destination: '군자' }),
    );
    const res = await post(
      '/boarding-lock/sync',
      { token: TOKEN, observedStationName: '건대입구', observedAtMs: Date.now(), accuracy: 20 },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const seen = await getTrip(ctx.env, TOKEN);
    expect(seen?.boardingLock).toBeUndefined();
  });
});
