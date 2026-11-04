/**
 * K5 #2926 PR-B — cron 연결: lock 없는 trip이 `예상 소요 x1.5 + 15분`을 넘으면 cleanup 1회(lockless-timeout) + 종료 안내 1회.
 * 10/21 사용자 결정("lockless trip 시한 종료 = 예상 소요 x1.5 + 15분, 종료 안내 1회")의 미구현분.
 * fixture는 합성 — 시한 판정은 trip 필드만의 함수라 덤프 의존 없음.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runScheduled, type ScheduledDeps } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { getTrip, putTrip } from '../trips';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
// route 3 hop x 90s = 270s -> 270*1.5 = 405s + 15분
const WINDOW_MS = 405_000 + 15 * MIN;

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', bundleId: 'com.example.app', privateKeyPem: await exportPKCS8(privateKey) };
  resetApnsJwtCache();
});

function captureEvents(): { db: Env['DB']; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const run = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...args: unknown[]) => {
      if (sql.includes('trip_events')) inserts.push(args);
      return { run };
    },
  }));
  return { db: { prepare } as unknown as Env['DB'], inserts };
}

function makeEnv(kv: InMemoryKV, db: Env['DB']): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    DB: db,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  const waypoints = [
    { stationName: '중곡', line: '7', kind: 'intermediate' },
    { stationName: '군자', line: '7', kind: 'intermediate' },
    { stationName: '장승배기', line: '7', kind: 'intermediate' },
    { stationName: '용마산', line: '7', kind: 'destination' },
  ] as Trip['waypoints'];
  return {
    token: 'lltimeout-tok',
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '용마산',
    waypoints,
    routeWaypoints: waypoints,
    expiresAt: NOW + 6 * 60 * MIN,
    createdAt: NOW - WINDOW_MS - MIN, // 기한을 1분 넘김
    alarmAtEpochMs: NOW - MIN,
    ...overrides,
  } as Trip;
}

function makeSeoul(now: () => number): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now,
    fetchImpl: (async () => new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
  });
}

async function runAt(kv: InMemoryKV, db: Env['DB'], now: number): Promise<ReturnType<typeof vi.fn>> {
  const fetchImpl = vi.fn(async (..._args: unknown[]) => new Response('', { status: 200 }));
  await runScheduled(makeEnv(kv, db), {
    seoul: makeSeoul(() => now),
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => now,
    generatePushId: () => 'lltimeout-push',
  } satisfies ScheduledDeps);
  return fetchImpl;
}

async function setup(tripOverrides: Partial<Trip> = {}) {
  const kv = new InMemoryKV();
  const trip = makeTrip(tripOverrides);
  await putTrip(kv as unknown as KVNamespace, trip);
  const { db, inserts } = captureEvents();
  return { kv, db, inserts, token: trip.token, trip };
}

const alertBodies = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.map((c) => String((c[1] as RequestInit | undefined)?.body ?? '')).filter((b) => b.includes('trip-ended'));
const ends = (inserts: unknown[][]) => inserts.filter((a) => a[2] === 'trip-end');
const readTrip = (kv: InMemoryKV, token: string) => getTrip(kv as unknown as KVNamespace, token);

describe('K5 PR-B — lockless 시한 종료', () => {
  it('기한 초과 lockless trip -> trip 삭제 + trip-end(lockless-timeout) 1행 + 종료 alert 1회(외부 reason=expired)', async () => {
    const { kv, db, inserts, token } = await setup();
    const f = await runAt(kv, db, NOW);
    expect(await readTrip(kv, token)).toBeNull();
    const rows = ends(inserts);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0][5] as string)).toMatchObject({ reason: 'lockless-timeout', endPath: 'lockless-timeout' });
    const alerts = alertBodies(f);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('"reason":"expired"');
    expect(alerts[0]).not.toContain('lockless-timeout');
  });

  it('기한 직전(1분 남음) -> 종료 0', async () => {
    const { kv, db, inserts, token } = await setup({ createdAt: NOW - WINDOW_MS + MIN });
    const f = await runAt(kv, db, NOW);
    expect(await readTrip(kv, token)).not.toBeNull();
    expect(ends(inserts)).toHaveLength(0);
    expect(alertBodies(f)).toHaveLength(0);
  });

  it('lock 활성 trip은 아무리 오래돼도 종료 0', async () => {
    const { kv, db, inserts, token } = await setup({
      boardingLock: {
        trainCode: '7252',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW - MIN,
        segmentStations: ['중곡', '용마산'],
        expiresAt: NOW + 30 * MIN,
      } as Trip['boardingLock'],
    });
    await runAt(kv, db, NOW);
    expect(await readTrip(kv, token)).not.toBeNull();
    expect(ends(inserts).filter((a) => String(a[5]).includes('lockless-timeout'))).toHaveLength(0);
  });

  it('lock 해제 후에는 해제 시각 기준 — 해제가 최근이면 종료 0, 해제 후 기한 초과면 종료', async () => {
    const recent = await setup({ lockEverAttached: true, locklessSince: NOW - 5 * MIN });
    await runAt(recent.kv, recent.db, NOW);
    expect(await readTrip(recent.kv, recent.token)).not.toBeNull();

    const old = await setup({ lockEverAttached: true, locklessSince: NOW - WINDOW_MS - MIN });
    const f = await runAt(old.kv, old.db, NOW);
    expect(await readTrip(old.kv, old.token)).toBeNull();
    expect(alertBodies(f)).toHaveLength(1);
  });

  it('remainingSecToDest가 있으면 그 값이 소요 추정: 20분 소요 -> 기한 45분', async () => {
    const wps = makeTrip().waypoints.map((w, i) => (i === 0 ? { ...w, remainingSecToDest: 20 * 60 } : w));
    const window = 20 * 60_000 * 1.5 + 15 * MIN; // 45분
    const within = await setup({ routeWaypoints: wps, waypoints: wps, createdAt: NOW - window + MIN });
    await runAt(within.kv, within.db, NOW);
    expect(await readTrip(within.kv, within.token)).not.toBeNull();
    const over = await setup({ routeWaypoints: wps, waypoints: wps, createdAt: NOW - window - MIN });
    await runAt(over.kv, over.db, NOW);
    expect(await readTrip(over.kv, over.token)).toBeNull();
  });

  it('종료 직전 재조회: 그 사이 DELETE(null) 또는 lock 부착이면 종료·안내 0', async () => {
    const { kv, db, inserts } = await setup();
    const token = 'lltimeout-tok';
    const realGet = kv.get.bind(kv);
    let tripReads = 0;
    vi.spyOn(kv, 'get').mockImplementation((async (key: string, ...rest: unknown[]) => {
      if (key === `trip:${token}`) {
        tripReads += 1;
        if (tripReads >= 2) return null;
      }
      return (realGet as (...a: unknown[]) => unknown)(key, ...rest);
    }) as never);
    const f = await runAt(kv, db, NOW);
    expect(ends(inserts)).toHaveLength(0);
    expect(alertBodies(f)).toHaveLength(0);
  });

  it('재평가 dedup: 종료 alert는 같은 trip에 1회만(이미 발사된 dedup key면 push 0)', async () => {
    const { kv, db, trip } = await setup();
    await (kv as unknown as KVNamespace).put(`tripEndedAlert:${trip.token}:${trip.createdAt}`, '1');
    const f = await runAt(kv, db, NOW);
    expect(alertBodies(f)).toHaveLength(0);
  });

  it('lock 해제 시각을 모르는 구 레코드(lockEverAttached만)는 종료하지 않는다', async () => {
    const { kv, db, token, trip } = await setup();
    // putTrip을 거치면 locklessSince가 stamp되므로 필드 도입 전 레코드를 KV에 직접 심는다.
    await (kv as unknown as KVNamespace).put(`trip:${token}`, JSON.stringify({ ...trip, lockEverAttached: true }));
    await runAt(kv, db, NOW);
    expect(await readTrip(kv, token)).not.toBeNull();
  });
});
