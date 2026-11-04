/**
 * #3045 — boardingCommitted leg 오염 replay (2026-11-04 실측 trip, D1 trip_events 2152/2156).
 *
 * 실측: 건대입구(7호선) leg-2 anchor에서 7250이 ARRIVED(trainSttus=1, D1 2152, streak 1) →
 * DEPARTED(trainSttus=2, D1 2156, streak 2)로 전이했지만 `outcome:"pending"`이었다(응답 없는 leg-2에서
 * DEPARTED 전이만으로는 confirm하지 않는 #2780 AND 게이트). 사용자가 실제로 탄 열차는 7252(D1 2169)다.
 *
 * 이 테스트는 같은 trip이 leg-1에서 PENDING fallback을 탔다면(`boardingCommitted:true`가 trip 전 구간에
 * 남음 — leg 경계 오염) 이 게이트가 무력화돼 7250이 lock되는지를 묻는다. 기대: leg-2는 leg-2 응답
 * 마커가 없으면 leg-1의 boardingCommitted로 증거를 인정하지 않는다 -> pending 유지, lock 0.
 *
 * fixture 구분:
 *  - 실측(불변): candidates `[{trainCode:'7250',trainSttus:1|2}]`, streakCount, outcome, ts, station/line.
 *    (tasks/evidence-2026-11-04-ride-d1.json id 2152, 2156 그대로)
 *  - 합성(SYNTHETIC): Seoul position의 isUp/recptnMs, trip 형태(leg-1 응답 마커·boardingCommitted·
 *    waypoints). D1에는 `boardingCommitted`가 기록되지 않아 오염 상태는 가정이다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { runScheduled } from '../scheduled';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { getTrip, putTrip } from '../trips';
import type { Env, Trip } from '../types';
import type { PositionEntry, SeoulArrivalClient } from '../seoul';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
  resetApnsJwtCache();
});

const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };

/** 실측 D1 행 (id 2152, 2156) — tasks/evidence-2026-11-04-ride-d1.json verbatim. */
const REAL_D1_ROWS = [
  {
    id: 2152,
    ts: 1793780325926,
    kind: 'leg-resolve-attempt',
    station: '건대입구',
    line: '7',
    meta: '{"elapsedSinceAnchorMs":142348,"candidates":[{"trainCode":"7250","trainSttus":1}],"streakCount":1,"outcome":"pending","selectedTrainCode":"7250"}',
  },
  {
    id: 2156,
    ts: 1793780386018,
    kind: 'leg-resolve-attempt',
    station: '건대입구',
    line: '7',
    meta: '{"elapsedSinceAnchorMs":202440,"candidates":[{"trainCode":"7250","trainSttus":2}],"streakCount":2,"outcome":"pending","selectedTrainCode":"7250"}',
  },
] as const;

type LegMeta = {
  candidates: { trainCode: string; trainSttus: number }[];
  streakCount: number;
  outcome: string;
  selectedTrainCode?: string;
};

function makeDb(): { db: D1Database; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        inserts.push(args);
        return { run: async () => ({ success: true }), first: async () => null };
      },
    }),
  } as unknown as D1Database;
  return { db, inserts };
}

function makeEnv(kv: InMemoryKV, db: D1Database): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    DB: db,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 's',
    SEOUL_API_KEY: 'K',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  } as unknown as Env;
}

function seoulWith(trainCode: string, trainSttus: number, recptnMs: number): SeoulArrivalClient {
  return {
    stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
    async fetchArrivals() {
      return [];
    },
    async fetchPositions(line: string): Promise<PositionEntry[]> {
      if (line !== '7') return [];
      // SYNTHETIC: isUp / recptnMs (D1에는 candidates의 trainCode·trainSttus만 있다).
      return [{ trainCode, stationName: '건대입구', trainSttus, isUp: true, recptnMs } as unknown as PositionEntry];
    },
  } as unknown as SeoulArrivalClient;
}

describe('#3045 replay 20261104 — leg-1 boardingCommitted가 leg-2 증거 게이트를 무력화하지 않는다', () => {
  it('leg-2(건대입구 7) + boardingCommitted(leg-1 오염) + leg-2 마커 없음: 7250 ARRIVED→DEPARTED여도 lock 0, outcome=pending', async () => {
    const kv = new InMemoryKV();
    const { db, inserts } = makeDb();
    const [first, second] = REAL_D1_ROWS;
    const token = 'replay-20261104';
    // SYNTHETIC trip 형태 — leg-1에서 응답(마커 'leg1') + PENDING fallback(boardingCommitted) 후 환승한 상태.
    const trip = {
      token,
      route: { type: 'transfer', fromLine: '2', toLine: '7', stopsToTransfer: 0 },
      destination: '용마산',
      waypoints: [{ stationName: '용마산', line: '7', kind: 'destination' }],
      expiresAt: second.ts + 2 * 60 * 60_000,
      createdAt: first.ts - 30 * 60_000,
      alarmAtEpochMs: first.ts,
      infoModeEnabled: true,
      currentLegAnchor: { boardingStation: first.station, line: first.line },
      legBoardingEligibleAt: first.ts - 60_000,
      boardingCommitted: true,
      boardingResponse: { legKey: 'leg1', at: first.ts - 20 * 60_000 },
    } as unknown as Trip;
    await putTrip(kv as unknown as KVNamespace, trip);

    for (const [n, row] of REAL_D1_ROWS.entries()) {
      const { candidates } = JSON.parse(row.meta) as LegMeta;
      const [{ trainCode, trainSttus }] = candidates;
      await runScheduled(makeEnv(kv, db), {
        seoul: seoulWith(trainCode, trainSttus, row.ts),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
        now: () => row.ts,
        generatePushId: () => `p-replay-${n}`,
      });
    }

    // 이유 1) 실측과 동일하게 마지막 leg-resolve-attempt가 pending (D1 2156 outcome).
    const attempts = inserts
      .filter((a) => a[2] === 'leg-resolve-attempt')
      .map((a) => JSON.parse(a[5] as string) as LegMeta);
    expect(attempts[attempts.length - 1]).toMatchObject({ outcome: 'pending', streakCount: 2, selectedTrainCode: '7250' });
    // 이유 2) cron-leg2 경로의 lock-attached가 없다.
    expect(inserts.filter((a) => a[2] === 'lock-attached')).toHaveLength(0);
    // 결과) lock 미부착, 관측(streak)은 계속.
    const stored = await getTrip(kv as unknown as KVNamespace, token);
    expect(stored?.boardingLock).toBeUndefined();
    expect(stored?.legResolveStreak?.trainCode).toBe('7250');
  });
});
