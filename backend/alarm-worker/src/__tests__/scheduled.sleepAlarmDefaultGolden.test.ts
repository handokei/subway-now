/**
 * #3100 PR-1 — 기본값(설정 없음 / `{선택한 역, [1역 전]}`) 취침 알람 golden.
 *
 * 변경 전 코드(origin/dev)에서 green으로 고정한다. 이후 N역 전 일반화(PR-1 구현)가 기본값의
 * payload / dedup 키 / collapse-id / 문구 / companion wire / KV 호출 수 / D1 행을 **바이트 단위로**
 * 바꾸지 않았음을 같은 단언이 증명한다. 기대값은 실측 출력을 그대로 박은 것이며 통과시키려
 * 조정하지 않는다.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { sleepAlarmCollapseId } from '../collapseId';
import {
  completeWaypointAdvance,
  createEmptyScheduledStats,
  fireSyncConsumedPrecedingAlarms,
  sleepAlarmFireKey,
  type ScheduledDeps,
  type SyncSkippedFireDeps,
} from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import type { BoardingLockMeta, Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());
afterEach(() => vi.unstubAllGlobals());

const NOW = 1_700_000_000_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;
const TOKEN = 'golden-tok';
const ALARM_KEY_PREFIX = 'alarmFireKey:';

const wp = (stationName: string, kind: Waypoint['kind'], line = '7'): Waypoint => ({ stationName, line, kind });

function makeLock(segmentStations: string[]): BoardingLockMeta {
  return {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations,
    expiresAt: NOW + 3 * 60 * 60_000,
  };
}

function makeTrip(waypoints: Waypoint[], overrides: Partial<Trip> = {}): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: waypoints.length },
    destination: waypoints[waypoints.length - 1].stationName,
    waypoints,
    expiresAt: NOW + 3 * 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW - 60_000,
    sleepModeEnabled: true,
    boardingLock: makeLock(waypoints.map((w) => w.stationName)),
    ...overrides,
  };
}

function makeEnv(kv: InMemoryKV, db?: unknown): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    ...(db !== undefined ? { DB: db as D1Database } : {}),
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: apnsConfig.keyId,
    APNS_TEAM_ID: apnsConfig.teamId,
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: apnsConfig.bundleId,
  };
}

interface Captured {
  pushType?: string;
  collapseId?: string;
  priority?: string;
  threadId?: string;
  body: unknown;
  rawBody: string;
}

function captureFetch(status = 200) {
  const calls: Captured[] = [];
  const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const h = init?.headers ?? {};
    calls.push({
      pushType: h['apns-push-type'],
      collapseId: h['apns-collapse-id'],
      priority: h['apns-priority'],
      threadId: h['apns-thread-id'],
      body: JSON.parse(String(init?.body ?? '{}')),
      rawBody: String(init?.body ?? ''),
    });
    return new Response(status === 200 ? '' : '{"reason":"InternalServerError"}', { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** D1 fake — INSERT 인자(kind=3번째 bind)만 기록한다. */
function fakeD1() {
  const kinds: string[] = [];
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          kinds.push(String(args[2]));
        },
      }),
    }),
  };
  return { db, kinds };
}

function spyKv(kv: InMemoryKV) {
  const keys = { get: [] as string[], put: [] as string[], delete: [] as string[] };
  for (const op of ['get', 'put', 'delete'] as const) {
    const original = kv[op].bind(kv) as (key: string, ...rest: unknown[]) => Promise<unknown>;
    vi.spyOn(kv, op).mockImplementation(((key: string, ...rest: unknown[]) => {
      keys[op].push(key);
      return original(key, ...rest);
    }) as never);
  }
  const alarmKeyCalls = () => ({
    get: keys.get.filter((k) => k.startsWith(ALARM_KEY_PREFIX)).length,
    put: keys.put.filter((k) => k.startsWith(ALARM_KEY_PREFIX)).length,
    delete: keys.delete.filter((k) => k.startsWith(ALARM_KEY_PREFIX)).length,
  });
  const totals = () => ({ get: keys.get.length, put: keys.put.length, delete: keys.delete.length });
  return { alarmKeyCalls, totals };
}

function seoul(): SeoulArrivalClient {
  return new SeoulArrivalClient({ apiKey: 'K', host: 'h', now: () => NOW, fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch });
}

async function advance(
  trip: Trip,
  kv: InMemoryKV,
  fetchImpl: typeof fetch,
  opts: { db?: unknown; now?: number; pushIdPrefix?: string } = {},
) {
  let n = 0;
  const now = opts.now ?? NOW;
  const deps = { seoul: seoul(), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl, now: () => now } as ScheduledDeps;
  await completeWaypointAdvance(
    trip,
    trip.waypoints[0],
    makeEnv(kv, opts.db),
    deps,
    createEmptyScheduledStats(now),
    now,
    () => undefined,
    () => `${opts.pushIdPrefix ?? 'g'}-${++n}`,
    'lock-active-destination',
  );
}

const alarmAlerts = (calls: Captured[]) => calls.filter((c) => c.pushType === 'alert' && /^alarm-/.test(c.collapseId ?? ''));
const companions = (calls: Captured[]) =>
  calls.filter((c) => c.pushType === 'background' && (c.body as { data?: { kind?: string } }).data?.kind === 'sleep-alarm-companion');

describe('#3100 golden — 기본값 키 문자열', () => {
  it('dedup 키 / collapse-id는 (token, 타깃)만으로 만들어진다 (remaining 접미사 없음)', () => {
    expect(sleepAlarmFireKey('tok', '건대입구')).toBe('alarmFireKey:tok:건대입구');
    expect(sleepAlarmCollapseId('tok', '건대입구')).toBe('alarm-tok-건대입구');
  });

  it('긴 역명도 64바이트로 절단되는 기존 규칙 그대로', () => {
    const id = sleepAlarmCollapseId('0123456789abcdefXYZ', '남한산성입구(성남법원.검찰청)');
    expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(64);
    expect(id.startsWith('alarm-0123456789abcdef-')).toBe(true);
  });
});

describe('#3100 golden — 기본값 push 바이트 (alert + companion)', () => {
  const CASES: { name: string; waypoints: Waypoint[]; locale: Trip['locale']; title: string; body: string; kind: string }[] = [
    { name: '하차 ko', waypoints: [wp('군자', 'intermediate'), wp('어린이대공원', 'destination')], locale: 'ko', title: '도착 임박', body: '곧 어린이대공원에 도착합니다. 하차 준비하세요!', kind: 'destination' },
    { name: '환승 ko', waypoints: [wp('군자', 'intermediate'), wp('건대입구', 'transfer')], locale: 'ko', title: '환승 임박', body: '곧 건대입구에 도착합니다. 환승 준비하세요!', kind: 'transfer' },
    { name: '하차 en', waypoints: [wp('군자', 'intermediate'), wp('어린이대공원', 'destination')], locale: 'en', title: 'Arrival imminent', body: 'Arriving at 어린이대공원 — exit soon!', kind: 'destination' },
    { name: '환승 ja', waypoints: [wp('군자', 'intermediate'), wp('건대입구', 'transfer')], locale: 'ja', title: 'まもなく乗換', body: 'まもなく건대입구に到着します。乗換の準備をしてください!', kind: 'transfer' },
    { name: '하차 zh', waypoints: [wp('군자', 'intermediate'), wp('어린이대공원', 'destination')], locale: 'zh', title: '即将到达', body: '即将到达어린이대공원。请准备下车!', kind: 'destination' },
  ];

  for (const c of CASES) {
    it(`${c.name}: alert 헤더/본문과 companion 본문이 바이트 동일`, async () => {
      const kv = new InMemoryKV(() => NOW);
      const f = captureFetch();
      const trip = makeTrip(c.waypoints, { locale: c.locale });
      const target = c.waypoints[1];
      await advance(trip, kv, f.fetchImpl);

      const [alert] = alarmAlerts(f.calls);
      expect(alarmAlerts(f.calls)).toHaveLength(1);
      expect(alert.collapseId).toBe(`alarm-${TOKEN}-${target.stationName}`);
      expect(alert.priority).toBe('10');
      expect(alert.threadId).toBe(TOKEN);
      expect(alert.rawBody).toBe(
        JSON.stringify({
          aps: {
            alert: { title: c.title, body: c.body },
            sound: 'alarm.wav',
            'interruption-level': 'time-sensitive',
          },
          data: { pushId: 'g-1' },
          body: { pushId: 'g-1' },
        }),
      );

      const [companion] = companions(f.calls);
      expect(companions(f.calls)).toHaveLength(1);
      expect(companion.priority).toBe('5');
      expect(companion.rawBody).toBe(
        JSON.stringify({
          aps: { 'content-available': 1 },
          data: {
            kind: 'sleep-alarm-companion',
            originStation: '군자',
            targetKind: c.kind,
            nextLine: '7',
            nextStation: target.stationName,
            tripToken: TOKEN,
            pushId: 'g-2',
            sentAt: NOW,
            title: c.title,
            body: c.body,
          },
        }),
      );
      // 기본값 companion wire에는 칸 구분 필드가 없다.
      expect(companion.rawBody).not.toContain('remainingStops');
    });
  }
});

describe('#3100 golden — 기본값 KV 호출 수 / D1 행', () => {
  const waypoints = [wp('군자', 'intermediate'), wp('어린이대공원', 'destination')];

  it('발사 1회: 알람 키 get 1 + put 1 + delete 0 (전체 KV도 변경 전과 동일)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch();
    await advance(makeTrip(waypoints), kv, f.fetchImpl);
    expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 1, delete: 0 });
    expect(spy.totals()).toEqual(KV_TOTALS_FIRE);
  });

  it('같은 쌍 재평가(dedup): 알람 키 get 1 + put 0 + delete 0, push 추가 0', async () => {
    const kv = new InMemoryKV(() => NOW);
    const f = captureFetch();
    await advance(makeTrip(waypoints), kv, f.fetchImpl);
    const spy = spyKv(kv);
    const before = f.calls.length;
    await advance(makeTrip(waypoints), kv, f.fetchImpl);
    expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 0, delete: 0 });
    expect(f.calls.length).toBe(before);
  });

  it('주 채널 실패(rollback): 알람 키 get 1 + put 1 + delete 1', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch(500);
    await advance(makeTrip(waypoints), kv, f.fetchImpl);
    expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 1, delete: 1 });
    expect(kv.store.has(sleepAlarmFireKey(TOKEN, '어린이대공원'))).toBe(false);
  });

  it('취침 OFF: 알람 키 접근 0 (준비 알람 키만)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch();
    await advance(makeTrip(waypoints, { sleepModeEnabled: false }), kv, f.fetchImpl);
    expect(spy.alarmKeyCalls()).toEqual({ get: 0, put: 0, delete: 0 });
  });

  it('sync catch-up 1회: 알람 키 get 1 + put 1', async () => {
    const kv = new InMemoryKV(() => NOW);
    const spy = spyKv(kv);
    const f = captureFetch();
    const chain = [wp('중곡', 'intermediate'), wp('군자', 'intermediate'), wp('어린이대공원', 'intermediate'), wp('건대입구', 'destination')];
    await fireSyncConsumedPrecedingAlarms(
      makeEnv(kv),
      makeTrip(chain),
      3,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl } as SyncSkippedFireDeps,
      NOW,
      () => undefined,
      () => 'p',
    );
    expect(spy.alarmKeyCalls()).toEqual({ get: 1, put: 1, delete: 0 });
    expect(alarmAlerts(f.calls)).toHaveLength(1);
  });

  it('기본값은 D1 sleep-alarm 행을 만들지 않는다 (발사/dedup/rollback 모두)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const d1 = fakeD1();
    await advance(makeTrip(waypoints), kv, captureFetch().fetchImpl, { db: d1.db });
    await advance(makeTrip(waypoints), kv, captureFetch().fetchImpl, { db: d1.db }); // dedup
    await advance(makeTrip(waypoints, { token: 'other' }), new InMemoryKV(() => NOW), captureFetch(500).fetchImpl, { db: d1.db }); // rollback
    expect(d1.kinds.filter((k) => k === 'sleep-alarm')).toEqual([]);
  });
});

/** 변경 전 코드 실측 — 기본값 발사 1회의 전체 KV get/put/delete 호출 수. */
const KV_TOTALS_FIRE = { get: 3, put: 3, delete: 0 };
