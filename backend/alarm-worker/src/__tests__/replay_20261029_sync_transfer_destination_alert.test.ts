/**
 * #2645 PR-3 — lock 활성 `/boarding-lock/sync`가 transfer/destination을 소비할 때 visible(alert) 알림을 발사한다.
 *
 * 실측(10/28 180, D1 token_hash b00dd879, `fixtures/replay_20261028_sync_lockless/events_180.json` — 불변):
 *   17:17:06 `sync-received 건대입구`(lock 2288 활성) -> `advance 어린이대공원`. 건대입구 `cron-fire-attempt` 0행,
 *   환승 visible push 0 (기존 혼합 분기는 transfer-release silent push + hop-end 프롬프트만 보냈다).
 *   사용자 수신은 기기 FG 로컬 알림뿐이었다.
 * 스펙: plan `tasks/plan-2026-10-28-sync-path-final.md` §3.2 PR-3 / §5.2 PR-3 red.
 *   발송은 매역 공용 `sendStationPassedAlertPush`(origin 'device-sync') 재사용, dedup = `stationPassedFiredKey`
 *   (진입 발사·도착 발사와 같은 키). 키는 발사 성공 후 put. lockless는 발사 0. 취침은 transfer/destination mute 아님.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { resetApnsJwtCache } from '../apns';
import { stationPassedFiredKey } from '../scheduled';
import { putTrip } from '../trips';
import type { BoardingLockMeta, Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { loadD1Events, makeTripEventSink } from './helpers/replay20261019';

const FIXTURE_DIR = 'replay_20261028_sync_lockless';
const events180 = loadD1Events(FIXTURE_DIR, 'events_180.json');
/** 180 17:17:06 — lock 활성 상태에서 건대입구(환승)를 관측한 sync. 이 행의 ts가 요청 시각. */
const SYNC_180 = events180.find((e) => e.kind === 'sync-received' && e.station === '건대입구' && e.meta === null)!;
const LOCK_TRAIN = '2288';

/** 180 환승 이후 경로(건대입구 transfer -> 7호선 -> 용마산 destination) — replay_20261028_trip180 makeTrip180과 동일 waypoints. */
const WAYPOINTS_180: Waypoint[] = [
  { stationName: '건대입구', line: '2', kind: 'transfer' },
  { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
  { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
  { stationName: '중곡', line: '7', kind: 'intermediate' },
  { stationName: '용마산', line: '7', kind: 'destination' },
];
const TRANSFER = WAYPOINTS_180[0].stationName;
const DESTINATION = WAYPOINTS_180[WAYPOINTS_180.length - 1].stationName;

let tokenSeq = 0;
let TOKEN = '';

function makeLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: LOCK_TRAIN,
    line: '2',
    subwayId: '1002',
    selectedDepartureTime: SYNC_180.ts - 60_000,
    segmentStations: ['성수', TRANSFER],
    expiresAt: SYNC_180.ts + 3_600_000,
    ...overrides,
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: TOKEN,
    route: { type: 'transfer', line: '2', stops: 5 } as unknown as Trip['route'],
    destination: DESTINATION,
    originStationName: '성수',
    waypoints: WAYPOINTS_180.map((w) => ({ ...w })),
    expiresAt: SYNC_180.ts + 3_600_000,
    createdAt: SYNC_180.ts - 240_000,
    alarmAtEpochMs: SYNC_180.ts,
    infoModeEnabled: true,
    boardingLock: makeLock(),
    ...overrides,
  } as Trip;
}

interface DecodedPush {
  pushType: string | undefined;
  data: Record<string, unknown>;
}

describe('POST /boarding-lock/sync — lock 활성 transfer/destination visible 발사 (#2645 PR-3)', () => {
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
    TOKEN = `replay-20261029-sync-td-${(tokenSeq += 1)}`;
    resetApnsJwtCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SYNC_180.ts);
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

  async function sync(observedStationName: string) {
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
        body: JSON.stringify({ token: TOKEN, observedStationName, observedAtMs: Date.now(), accuracy: 20 }),
      }),
      env,
      ctx,
    );
    await Promise.all(waits);
    return { status: res.status, body: (await res.json()) as { advanced: boolean } };
  }

  /** APNs로 나간 push를 (push-type, data)로 해석한다. */
  function pushes(): DecodedPush[] {
    return fetchSpy.mock.calls.map(([, init]) => {
      const { headers, body } = init as RequestInit;
      const parsed = JSON.parse(String(body)) as { data?: Record<string, unknown> };
      return { pushType: (headers as Record<string, string>)['apns-push-type'], data: parsed.data ?? {} };
    });
  }
  /** visible(alert) station-passed push의 (역, kind, origin). */
  const alerts = () =>
    pushes()
      .filter((p) => p.pushType === 'alert' && typeof p.data.nextWaypoint === 'string')
      .map((p) => ({ station: p.data.nextWaypoint as string, kind: p.data.kind as string, origin: p.data.origin }));
  const fireAttempts = (station: string) =>
    events.filter((e) => e.kind === 'cron-fire-attempt' && e.station === station);
  const firedKey = (station: string) => stationPassedFiredKey(TOKEN, LOCK_TRAIN, station);

  it('fixture 전제: 180 17:17:06 lock 활성 sync는 건대입구 소비였고 건대입구 cron-fire-attempt는 0행이었다(실측 결함)', () => {
    expect(SYNC_180.meta).toBeNull();
    expect(events180.filter((e) => e.kind === 'cron-fire-attempt' && e.station === TRANSFER)).toEqual([]);
    expect(events180.some((e) => e.kind === 'advance' && e.ts > SYNC_180.ts)).toBe(true);
  });

  it('★180 17:17:06 lock 활성 transfer 관측: 건대입구 visible(alert) push 정확히 1건(kind transfer, origin device-sync) + D1 sent 1 + dedup 키 stamp', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());

    const { status, body } = await sync(TRANSFER);

    expect(status).toBe(200);
    expect(body.advanced).toBe(true);
    expect(alerts()).toEqual([{ station: TRANSFER, kind: 'transfer', origin: 'device-sync' }]);
    const attempts = fireAttempts(TRANSFER);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].meta).toMatchObject({ waypointKind: 'transfer', outcome: 'sent' });
    expect(await kv.get(firedKey(TRANSFER))).not.toBeNull();
  });

  it('★destination 관측(lock 활성): 도착 visible push 1건(kind destination) — trip 종료 안내와 별개', async () => {
    const dest = WAYPOINTS_180.slice(-1).map((w) => ({ ...w }));
    await putTrip(kv as unknown as KVNamespace, makeTrip({ waypoints: dest }));

    const { body } = await sync(DESTINATION);

    expect(body.advanced).toBe(true);
    expect(alerts()).toEqual([{ station: DESTINATION, kind: 'destination', origin: 'device-sync' }]);
    expect(fireAttempts(DESTINATION)[0].meta).toMatchObject({ waypointKind: 'destination', outcome: 'sent' });
    // 종료 안내(trip-ended)는 nextWaypoint 없는 별도 alert — 기존 동작 유지.
    expect(pushes().filter((p) => p.pushType === 'alert')).toHaveLength(2);
  });

  it('거부(이미 진입/도착 발사된 역): 같은 dedup 키가 있으면 sync는 visible push 0 — 사유 sync-station-passed-dedup, trip은 그대로 전진', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    await kv.put(firedKey(TRANSFER), '1');

    const { body } = await sync(TRANSFER);

    expect(body.advanced).toBe(true);
    expect(alerts()).toEqual([]);
    const attempts = fireAttempts(TRANSFER);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].meta).toMatchObject({ outcome: 'skipped-reason', reason: 'sync-station-passed-dedup' });
  });

  it('거부(lockless): lock 없는 트립의 sync가 transfer를 소비해도 visible push 0(lock 없음=알림 없음)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip({ boardingLock: undefined }));

    const { body } = await sync(TRANSFER);

    expect(body.advanced).toBe(true);
    expect(alerts()).toEqual([]);
    expect(fireAttempts(TRANSFER)).toEqual([]);
  });

  it('거부(push 실패): APNs 실패 시 dedup 키 put 0 + D1 failed 1 — 다음 기회(cron/진입)가 보존된다', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip());
    fetchSpy.mockResolvedValue(new Response('{"reason":"BadDeviceToken"}', { status: 400 }));

    await sync(TRANSFER);

    expect(await kv.get(firedKey(TRANSFER))).toBeNull();
    const attempts = fireAttempts(TRANSFER);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].meta).toMatchObject({ outcome: 'failed' });
  });

  it('취침 모드: transfer는 mute 아님 — 취침 trip에서도 visible 1건 발사(isSleepMutedStationNotif는 intermediate만)', async () => {
    await putTrip(kv as unknown as KVNamespace, makeTrip({ sleepModeEnabled: true }));

    await sync(TRANSFER);

    expect(alerts().map((a) => a.station)).toEqual([TRANSFER]);
  });

  it('예산 분리: skipped intermediate(cap 1) + 관측 transfer = 2건 — 건너뛴 역 예산을 transfer가 먹지 않는다', async () => {
    const wps: Waypoint[] = [
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '뚝섬', line: '2', kind: 'intermediate' },
      ...WAYPOINTS_180.map((w) => ({ ...w })),
    ];
    await putTrip(kv as unknown as KVNamespace, makeTrip({ waypoints: wps }));

    await sync(TRANSFER);

    expect(alerts().map((a) => a.station).sort()).toEqual([TRANSFER, '뚝섬'].sort());
  });
});
