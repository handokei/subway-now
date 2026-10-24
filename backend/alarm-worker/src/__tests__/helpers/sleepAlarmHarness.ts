/**
 * #3100 — 취침 알람 골든/N역 전 테스트가 공유하는 하네스.
 * (golden: 기본값 바이트 고정 / N table: 설정별 칸 / MAX 변형: 상수 mock) 세 파일이 같은
 * env·trip·push 캡처·D1 fake·KV spy 구성을 쓰도록 한 곳에 둔다.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../../apns';
import {
  completeWaypointAdvance,
  createEmptyScheduledStats,
  runScheduled,
  type ScheduledDeps,
} from '../../scheduled';
import { SeoulArrivalClient } from '../../seoul';
import { putTrip } from '../../trips';
import type { BoardingLockMeta, Env, Trip, Waypoint } from '../../types';
import { InMemoryKV } from '../inMemoryKv';

export const NOW = 1_700_000_000_000;
export const TICK_MS = 60_000;
export const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;
export const TOKEN = 'sleep-n-tok';
export const ALARM_KEY_PREFIX = 'alarmFireKey:';

let apnsConfig: ApnsConfig;

/** 테스트 파일 최상위에서 한 번 호출 — APNs 키 생성과 JWT 캐시 초기화 훅을 등록한다. */
export function useApnsHarness(): void {
  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('ES256');
    apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
  });
  beforeEach(() => resetApnsJwtCache());
  afterEach(() => vi.unstubAllGlobals());
}

export const getApnsConfig = (): ApnsConfig => apnsConfig;

export const wp = (stationName: string, kind: Waypoint['kind'], line = '7'): Waypoint => ({ stationName, line, kind });

export function makeLock(segmentStations: string[]): BoardingLockMeta {
  return {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations,
    expiresAt: NOW + 3 * 60 * 60_000,
  };
}

export function makeTrip(waypoints: Waypoint[], overrides: Partial<Trip> = {}): Trip {
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

export function makeEnv(kv: InMemoryKV, db?: unknown): Env {
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

export interface Captured {
  pushType?: string;
  collapseId?: string;
  priority?: string;
  threadId?: string;
  body: Record<string, unknown>;
  rawBody: string;
}

export function captureFetch(status = 200) {
  const calls: Captured[] = [];
  const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const h = init?.headers ?? {};
    calls.push({
      pushType: h['apns-push-type'],
      collapseId: h['apns-collapse-id'],
      priority: h['apns-priority'],
      threadId: h['apns-thread-id'],
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      rawBody: String(init?.body ?? ''),
    });
    return new Response(status === 200 ? '' : '{"reason":"InternalServerError"}', { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** 취침/준비 알람 alert(collapse-id `alarm-`/`prepare-`)만. */
export const alarmAlerts = (calls: Captured[]) =>
  calls.filter((c) => c.pushType === 'alert' && /^(alarm|prepare)-/.test(c.collapseId ?? ''));

export const sleepAlerts = (calls: Captured[]) =>
  calls.filter((c) => c.pushType === 'alert' && /^alarm-/.test(c.collapseId ?? ''));

export const companions = (calls: Captured[]) =>
  calls.filter(
    (c) => c.pushType === 'background' && (c.body.data as { kind?: string } | undefined)?.kind === 'sleep-alarm-companion',
  );

export interface D1Row {
  kind: string;
  station: string | null;
  meta: Record<string, unknown> | null;
}

/** D1 fake — `trip_events` INSERT를 (kind, station, meta)로 기록한다. 다른 테이블 쓰기는 무시. */
export function fakeD1() {
  const rows: D1Row[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => null,
        run: async () => {
          if (!sql.includes('trip_events')) return;
          rows.push({
            kind: String(args[2]),
            station: (args[3] as string | null) ?? null,
            meta: typeof args[5] === 'string' ? (JSON.parse(args[5]) as Record<string, unknown>) : null,
          });
        },
      }),
    }),
  };
  return { db, rows };
}

/** KV get/put/delete 호출 키를 기록한다 (`vi.spyOn`). */
export function spyKv(kv: InMemoryKV) {
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

export function seoulWith(waypointStation: string, arvlCd: number, trainCode = '7246'): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async (url: string) => {
      if (url.includes('/realtimePosition/')) return new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 });
      return new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: '0',
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: waypointStation,
              btrainNo: trainCode,
              subwayNm: '지하철7호선',
              arvlCd: String(arvlCd),
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });
}

/** `completeWaypointAdvance`를 직접 호출한다 — `trip.waypoints[0]`이 방금 진입한 직전역 후보. */
export async function advance(
  trip: Trip,
  kv: InMemoryKV,
  fetchImpl: typeof fetch,
  opts: { db?: unknown; now?: number } = {},
): Promise<void> {
  let n = 0;
  const now = opts.now ?? NOW;
  const deps = { seoul: seoulWith(trip.waypoints[0].stationName, 1), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl, now: () => now } as ScheduledDeps;
  await completeWaypointAdvance(
    trip,
    trip.waypoints[0],
    makeEnv(kv, opts.db),
    deps,
    createEmptyScheduledStats(now),
    now,
    () => undefined,
    () => `g-${++n}`,
    'lock-active-destination',
  );
}

/** cron 1 tick: head waypoint에 lock 열차가 진입(arvlCd=1)했다고 보고 runScheduled를 돌린다. */
export async function cronTick(kv: InMemoryKV, fetchImpl: typeof fetch, tickIdx: number, headStation: string, db?: unknown) {
  return runScheduled(makeEnv(kv, db), {
    seoul: seoulWith(headStation, 1),
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl,
    now: () => NOW + tickIdx * TICK_MS,
    generatePushId: () => `p-${tickIdx}`,
  });
}

/** 정상 주행 walk: waypoints 앞에서부터 1 tick당 1역 진입. 각 tick 뒤 누적 알람 collapse-id 목록을 돌려준다. */
export async function walkTrip(trip: Trip, db?: unknown) {
  const kv = new InMemoryKV(() => NOW);
  const spy = spyKv(kv);
  const f = captureFetch();
  await putTrip(kv as unknown as KVNamespace, trip);
  const perTick: { station: string; alarmsSoFar: string[] }[] = [];
  for (let i = 0; i < trip.waypoints.length; i++) {
    const { stationName } = trip.waypoints[i];
    await cronTick(kv, f.fetchImpl, i, stationName, db);
    perTick.push({ station: stationName, alarmsSoFar: alarmAlerts(f.calls).map((c) => c.collapseId as string) });
  }
  return { kv, spy, perTick, calls: f.calls };
}
