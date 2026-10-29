/**
 * #3083 PR-2 — lockless `/boarding-lock/sync` 순수 intermediate hold + 첫 transfer/destination까지 cap.
 *
 * 실측(10/28 179, D1 token_hash b00dd879): lock 없는 트립에 기기가 틀린 역을 보냈다.
 *   06:26:56 `sync-received 중곡`(meta 없음 = 승격 아님) → 같은 초 `advance 군자(능동) shiftedCount 1`
 *   → 06:27:55 `lock-attached 7035`(실열차는 06:26:46~06:27:46 용마산). 중곡 `cron-fire-attempt` 0행 —
 *   lock 전 sync가 중곡을 소비해 lock 후 매역 알림이 사라졌다.
 * 입력(불변 실측, 통과시키려 조정 금지): `fixtures/replay_20261028_sync_lockless/events_179.json`(D1 trip_events),
 * `events_180.json`, `dump_excerpt.txt`(기기 덤프 원문 발췌). seed route = 첫 `route-signature-mismatch.incomingSig`.
 *
 * 스펙: plan `tasks/plan-2026-10-28-sync-path-final.md` §3.2 PR-2 / §5.2 PR-2 red / §5.3 (i).
 *   요청 시점 활성·비PENDING lock이 없으면 — 소비 범위에 transfer/destination이 없으면 0, 있으면 첫
 *   transfer/destination까지(DP2=c, 면제 없음). lock 활성 sync는 무변경(PR-3 #2645 소관).
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { resetApnsJwtCache } from '../apns';
import { getTrip, putTrip } from '../trips';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { loadD1Events, makeTripEventSink, parseRouteSig, routeSigOf } from './helpers/replay20261019';

const FIXTURE_DIR = 'replay_20261028_sync_lockless';
const events179 = loadD1Events(FIXTURE_DIR, 'events_179.json');
const events180 = loadD1Events(FIXTURE_DIR, 'events_180.json');

/** 179 seed route — 첫 route-signature-mismatch의 incomingSig(중곡부터 뚝섬까지, 건대입구 환승). */
const SEED_WAYPOINTS = parseRouteSig(
  routeSigOf(events179.find((e) => e.kind === 'route-signature-mismatch')!, 'incomingSig'),
);
const SEED_NAMES = SEED_WAYPOINTS.map((w) => w.stationName);
/** 첫 lock 전 sync(중곡, meta 없음) — 이 행의 ts가 요청 시각. */
const FIRST_SYNC = events179.find((e) => e.kind === 'sync-received' && e.meta === null)!;
const LOCK_ATTACHED = events179.find((e) => e.kind === 'lock-attached')!;
const TRANSFER_NAME = SEED_WAYPOINTS.find((w) => w.kind === 'transfer')!.stationName;
const DESTINATION_NAME = SEED_WAYPOINTS.find((w) => w.kind === 'destination')!.stationName;

let tokenSeq = 0;
let TOKEN = '';

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: TOKEN,
    route: {
      type: 'transfer',
      fromLine: '7',
      toLine: '2',
      transferName: TRANSFER_NAME,
      stops: 5,
      stopsToTransfer: 3,
      stopsFromTransfer: 2,
    } as unknown as Trip['route'],
    destination: DESTINATION_NAME,
    waypoints: SEED_WAYPOINTS.map((w) => ({ ...w })),
    expiresAt: FIRST_SYNC.ts + 3_600_000,
    createdAt: FIRST_SYNC.ts - 15_000,
    alarmAtEpochMs: FIRST_SYNC.ts,
    infoModeEnabled: true,
    ...overrides,
  };
}

function makeLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7035',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: LOCK_ATTACHED.ts - 60_000,
    segmentStations: SEED_NAMES.slice(0, 4),
    expiresAt: FIRST_SYNC.ts + 3_600_000,
    ...overrides,
  };
}

describe('POST /boarding-lock/sync — lockless 순수 hold + 첫 transfer/destination cap (#3083 PR-2)', () => {
  let kv: InMemoryKV;
  let env: Env;
  let events: ReturnType<typeof makeTripEventSink>['events'];
  let fetchSpy: ReturnType<typeof vi.fn>;
  let apnsPem: string;

  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('ES256');
    apnsPem = await exportPKCS8(privateKey);
  });

  beforeEach(() => {
    TOKEN = `replay-20261028-sync-${(tokenSeq += 1)}`;
    resetApnsJwtCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIRST_SYNC.ts);
    kv = new InMemoryKV();
    const sink = makeTripEventSink();
    events = sink.events;
    env = {
      TRIPS: kv as unknown as KVNamespace,
      DB: sink.db,
      APNS_HOST: 'api.push.apple.com',
      APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
      SEOUL_API_HOST: 'seoul.api',
      SEOUL_API_KEY: 'KEY',
      APNS_KEY_ID: 'K',
      APNS_TEAM_ID: 'T',
      APNS_PRIVATE_KEY: apnsPem,
      APNS_BUNDLE_ID: 'com.example.app',
    } as Env;
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function sync(observedStationName: string, extra: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => void waits.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const res = await app.fetch(
      new Request('http://example.com/boarding-lock/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, observedStationName, observedAtMs: Date.now(), accuracy: 20, ...extra }),
      }),
      env,
      ctx,
    );
    await Promise.all(waits);
    return { status: res.status, body: (await res.json()) as { ok: boolean; advanced: boolean; currentWaypoint: string | null } };
  }

  const heads = async () => (await getTrip(kv as unknown as KVNamespace, TOKEN))?.waypoints.map((w) => w.stationName);
  const held = () => events.filter((e) => e.kind === 'advance-held');

  it('fixture 전제: 179 첫 lock 전 sync는 중곡이고 같은 초 advance 1건이 있었다(현행 결함의 실측 증거)', () => {
    expect(FIRST_SYNC.station).toBe(SEED_NAMES[0]);
    const advance = events179.find((e) => e.kind === 'advance')!;
    expect(advance.ts).toBe(FIRST_SYNC.ts);
    expect(JSON.parse(advance.meta!)).toEqual({ shiftedCount: 1 });
    expect(LOCK_ATTACHED.ts).toBeGreaterThan(FIRST_SYNC.ts);
    expect(events179.filter((e) => e.kind === 'cron-fire-attempt' && e.station === SEED_NAMES[0])).toEqual([]);
  });

  it('★179 06:26:56 lockless sync 중곡: 소비하지 않는다 — head 중곡 유지, advance 행 0, advance-held 1건(requested 1 -> 0)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());

    const { status, body } = await sync(FIRST_SYNC.station!);

    expect(status).toBe(200);
    expect(body.advanced).toBe(false);
    expect(await heads()).toEqual(SEED_NAMES);
    expect(events.filter((e) => e.kind === 'advance')).toEqual([]);
    expect(held()).toHaveLength(1);
    expect(held()[0].station).toBe(FIRST_SYNC.station);
    expect(held()[0].meta).toMatchObject({ requested: 1, cappedTo: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('hold 사유 단위: 뒤 intermediate 관측(어린이대공원)도 transfer 전이면 0 — requested 3 -> 0', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const target = SEED_NAMES[2];
    const { body } = await sync(target);
    expect(body.advanced).toBe(false);
    expect(await heads()).toEqual(SEED_NAMES);
    expect(held()[0].meta).toMatchObject({ requested: 3, cappedTo: 0 });
  });

  it('거부(고친 뒤에도 소비): 관측이 첫 transfer(건대입구)면 transfer까지 소비 — 168 환승 anchor 체인 유지', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const { body } = await sync(TRANSFER_NAME);
    const transferIdx = SEED_WAYPOINTS.findIndex((w) => w.kind === 'transfer');
    expect(body.advanced).toBe(true);
    expect(await heads()).toEqual(SEED_NAMES.slice(transferIdx + 1));
    expect(held()).toEqual([]);
    const after = await getTrip(kv as unknown as KVNamespace, TOKEN);
    expect(after?.currentLegAnchor).toEqual({ boardingStation: TRANSFER_NAME, line: SEED_WAYPOINTS[transferIdx + 1].line });
  });

  it('거부 + cap: 환승 너머 관측(성수)은 첫 transfer까지만 소비 — requested 5 -> 4, head 성수', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const transferIdx = SEED_WAYPOINTS.findIndex((w) => w.kind === 'transfer');
    const { body } = await sync(SEED_NAMES[transferIdx + 1]);
    expect(body.advanced).toBe(true);
    expect(await heads()).toEqual(SEED_NAMES.slice(transferIdx + 1));
    expect(held()).toHaveLength(1);
    expect(held()[0].meta).toMatchObject({ requested: transferIdx + 2, cappedTo: transferIdx + 1 });
  });

  it('cap: lockless에서 destination 관측도 첫 transfer까지만 소비(목적지 너머 점프 차단)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const transferIdx = SEED_WAYPOINTS.findIndex((w) => w.kind === 'transfer');
    const { body } = await sync(DESTINATION_NAME);
    expect(body.advanced).toBe(true);
    expect(await heads()).toEqual(SEED_NAMES.slice(transferIdx + 1));
    expect(held()[0].meta).toMatchObject({ cappedTo: transferIdx + 1 });
  });

  it('trainCode 동봉 lockless sync도 면제 없음(DP2=c) — 승격이 거부되면(확증 실패) hold, lock 미생성', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    const { body } = await sync(FIRST_SYNC.station!, { trainCode: '7035', line: '7' });
    expect(body.advanced).toBe(false);
    expect(await heads()).toEqual(SEED_NAMES);
    expect(held()[0].meta).toMatchObject({ requested: 1, cappedTo: 0 });
    expect((await getTrip(kv as unknown as KVNamespace, TOKEN))?.boardingLock).toBeUndefined();
  });

  it('거부(고친 뒤에도 소비): 활성 lock이 있으면 같은 중곡 sync가 소비한다 — 179 06:29:43형(PR-3/PR-4 소관, 무변경)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip({ boardingLock: makeLock() }));
    const { body } = await sync(FIRST_SYNC.station!);
    expect(body.advanced).toBe(true);
    expect(await heads()).toEqual(SEED_NAMES.slice(1));
    expect(held()).toEqual([]);
  });

  it('거부(고친 뒤에도 소비): 180 17:17:06형 — lock 활성 transfer 관측은 소비한다(PR-2는 lockless만)', async () => {
    const sync180 = events180.find((e) => e.kind === 'sync-received' && e.station === TRANSFER_NAME)!;
    expect(sync180.meta).toBeNull();
    vi.setSystemTime(FIRST_SYNC.ts);
    const transferIdx = SEED_WAYPOINTS.findIndex((w) => w.kind === 'transfer');
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({
        waypoints: SEED_WAYPOINTS.slice(transferIdx).map((w) => ({ ...w })),
        boardingLock: makeLock({ trainCode: '2288', line: '7' }),
      }),
    );
    const { body } = await sync(TRANSFER_NAME);
    expect(body.advanced).toBe(true);
    expect(held()).toEqual([]);
  });

  it('PENDING sentinel / 만료 lock은 lock 없음과 같다 — hold', async () => {
    await putTrip(
      kv as unknown as KVNamespace,
      makeTrip({ boardingLock: makeLock({ trainCode: 'PENDING-TRAIN-CODE' }) }),
    );
    expect((await sync(FIRST_SYNC.station!)).body.advanced).toBe(false);
    await putTrip(kv as unknown as KVNamespace, makeTrip({ boardingLock: makeLock({ expiresAt: FIRST_SYNC.ts }) }));
    expect((await sync(FIRST_SYNC.station!)).body.advanced).toBe(false);
    expect(await heads()).toEqual(SEED_NAMES);
  });
});
