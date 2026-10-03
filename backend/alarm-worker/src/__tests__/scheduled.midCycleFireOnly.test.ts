/**
 * #2615 (재설계, 코드리뷰 F8 — allowlist 함수를 직접 단위로 다룰 수 있게 분리) —
 * `runMidCycleFireOnly` 단위 테스트. `runScheduled`를 전혀 거치지 않고 스냅샷을 직접
 * 구성해 fire-only 진입점만 격리 검증한다.
 *
 * 커버 범위:
 *   - 도착 확증(arvlCd ENTERING) 시 station-passed alert push 1건 발사 + D1
 *     cron-fire-attempt에 midCycle:true meta 기록
 *   - 미확증(arrived=false/estimate=null)이면 발사하지 않음(no-op, no mutation)
 *   - trip mutation 없음 — 이 함수는 putTrip을 호출하지 않는다(trip.boardingLock 등 캡처된
 *     스냅샷 값이 KV 상의 trip record와 무관하게 유지)
 *   - sleepModeEnabled 트립은 skip
 *   - 같은 pass 내 같은 (trip, station) 스냅샷 2건이면 in-memory dedup으로 1회만 발사
 *   - 발사 직전 KV dedup 키가 이미 존재하면(이전 mid pass가 이미 쐈음) skip — 재생 실증으로
 *     발견한 무한 재발사 회귀 차단
 *   - push 실패 시 D1에 outcome='failed' + midCycle:true 기록, 발사 카운트 미증가
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import {
  runMidCycleFireOnly,
  stationPassedFiredKey,
  type MidCycleTripSnapshot,
} from '../scheduled';
import { SeoulArrivalClient, type ArrivalEntry } from '../seoul';
import { ARRIVAL_CODE } from '../alarm';
import { putTrip } from '../trips';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: pem, bundleId: 'com.example.app' };
});

beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;

/** D1 INSERT를 가로채 trip_events row(특히 meta JSON)를 관측하는 mock binding. */
function makeDbMock() {
  const rows: { kind: string; station: string | null; meta: Record<string, unknown> | null }[] = [];
  const prepare = () => ({
    bind: (...args: unknown[]) => {
      rows.push({
        kind: args[2] as string,
        station: args[3] as string | null,
        meta: args[5] ? (JSON.parse(args[5] as string) as Record<string, unknown>) : null,
      });
      return { run: async () => ({ success: true }) };
    },
  });
  return { db: { prepare } as unknown as D1Database, rows };
}

function makeEnv(kv: InMemoryKV, db?: D1Database): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
    DB: db,
  };
}

function makeBoardingLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations: ['용마산', '중곡', '군자'],
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'mid-fire-tok',
    route: { type: 'direct', line: '7', stops: 2 },
    destination: '군자',
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '군자', line: '7', kind: 'destination' },
    ],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW - 60_000,
    boardingLock: makeBoardingLock(),
    ...overrides,
  };
}

function makeSnapshot(trip: Trip): MidCycleTripSnapshot {
  return { trip, waypoint: trip.waypoints[0], lock: trip.boardingLock! };
}

function makeSeoul(arrivals: ArrivalEntry[]): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: arrivals.map((a) => ({
            barvlDt: String(a.arrivalSeconds),
            recptnDt: '',
            updnLine: a.isUp ? '상행' : '하행',
            trainLineNm: a.destination,
            btrainNo: a.trainCode,
            subwayNm: a.subwayNm,
            arvlCd: a.arvlCd,
          })),
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

const SUCCESS_APNS_FETCH: typeof fetch = (async () =>
  new Response('', { status: 200 })) as unknown as typeof fetch;

const ENTERING_ARRIVAL: ArrivalEntry = {
  trainCode: '7246',
  arrivalSeconds: 30,
  isUp: true,
  destination: '온수',
  subwayNm: '7호선',
  arvlCd: ARRIVAL_CODE.ENTERING,
};

const NOT_YET_ARRIVAL: ArrivalEntry = {
  trainCode: '7246',
  arrivalSeconds: 120,
  isUp: true,
  destination: '온수',
  subwayNm: '7호선',
  arvlCd: 3,
};

describe('#2615 — runMidCycleFireOnly (allowlist fire-only 진입점)', () => {
  it('도착 확증(ENTERING) — station-passed alert push 1건 발사 + D1 midCycle:true 기록', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip();
    const stats = await runMidCycleFireOnly(
      makeEnv(kv, db),
      [makeSnapshot(trip)],
      { seoul: makeSeoul([ENTERING_ARRIVAL]), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    expect(stats).toEqual({ evaluated: 1, fired: 1, errors: 0 });
    const fireRow = rows.find((r) => r.kind === 'cron-fire-attempt');
    expect(fireRow?.station).toBe('중곡');
    expect(fireRow?.meta?.outcome).toBe('sent');
    expect(fireRow?.meta?.midCycle).toBe(true);
  });

  it('미확증(아직 도착 전) — 발사하지 않는다(no-op)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip();
    const stats = await runMidCycleFireOnly(
      makeEnv(kv),
      [makeSnapshot(trip)],
      { seoul: makeSeoul([NOT_YET_ARRIVAL]), apnsConfig, apnsHosts: APNS_HOSTS },
      NOW,
      () => undefined,
      () => 'push-1',
    );
    expect(stats).toEqual({ evaluated: 1, fired: 0, errors: 0 });
  });

  it('estimate=null(Seoul 무응답) — 발사하지 않는다(vanish-fallback/consecutiveEtaMissing 등 범위 밖)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip();
    const stats = await runMidCycleFireOnly(
      makeEnv(kv),
      [makeSnapshot(trip)],
      { seoul: makeSeoul([]), apnsConfig, apnsHosts: APNS_HOSTS },
      NOW,
      () => undefined,
      () => 'push-1',
    );
    expect(stats).toEqual({ evaluated: 1, fired: 0, errors: 0 });
  });

  it('trip mutation 없음 — putTrip을 호출하지 않는다(KV의 trip record 불변)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    const before = await kv.get(`trip:${trip.token}`);

    await runMidCycleFireOnly(
      makeEnv(kv),
      [makeSnapshot(trip)],
      { seoul: makeSeoul([ENTERING_ARRIVAL]), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    const after = await kv.get(`trip:${trip.token}`);
    expect(after).toBe(before);
  });

  it('sleepModeEnabled 트립은 skip', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip({ sleepModeEnabled: true });
    const stats = await runMidCycleFireOnly(
      makeEnv(kv),
      [makeSnapshot(trip)],
      { seoul: makeSeoul([ENTERING_ARRIVAL]), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );
    expect(stats).toEqual({ evaluated: 1, fired: 0, errors: 0 });
  });

  it('같은 pass 내 같은 (trip, station) 스냅샷 2건 — in-memory dedup으로 1회만 발사', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip();
    const snapshot = makeSnapshot(trip);
    const stats = await runMidCycleFireOnly(
      makeEnv(kv),
      [snapshot, snapshot],
      { seoul: makeSeoul([ENTERING_ARRIVAL]), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );
    expect(stats).toEqual({ evaluated: 2, fired: 1, errors: 0 });
  });

  it('발사 직전 KV dedup 키가 이미 존재 — skip (이전 mid pass가 이미 쐈음, 무한 재발사 회귀 차단)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip();
    const dedupKey = stationPassedFiredKey(trip.token, trip.boardingLock!.trainCode, trip.waypoints[0].stationName);
    await kv.put(dedupKey, '1');

    const stats = await runMidCycleFireOnly(
      makeEnv(kv),
      [makeSnapshot(trip)],
      { seoul: makeSeoul([ENTERING_ARRIVAL]), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );
    expect(stats).toEqual({ evaluated: 1, fired: 0, errors: 0 });
  });

  it('발사 성공 시 표준 dedup 키에 best-effort 1 put — 다음 primary/mid pass가 이 키로 skip한다', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip();
    const dedupKey = stationPassedFiredKey(trip.token, trip.boardingLock!.trainCode, trip.waypoints[0].stationName);

    await runMidCycleFireOnly(
      makeEnv(kv),
      [makeSnapshot(trip)],
      { seoul: makeSeoul([ENTERING_ARRIVAL]), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    expect(await kv.get(dedupKey)).toBe('1');
  });

  it('push 실패 시 D1에 outcome=failed + midCycle:true 기록, 발사 카운트 미증가', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip();
    const failFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 })) as unknown as typeof fetch;

    const stats = await runMidCycleFireOnly(
      makeEnv(kv, db),
      [makeSnapshot(trip)],
      {
        seoul: makeSeoul([ENTERING_ARRIVAL]),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: failFetch,
      },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    expect(stats.fired).toBe(0);
    expect(stats.errors).toBe(1);
    const fireRow = rows.find((r) => r.kind === 'cron-fire-attempt');
    expect(fireRow?.meta?.outcome).toBe('failed');
    expect(fireRow?.meta?.midCycle).toBe(true);
  });
});
