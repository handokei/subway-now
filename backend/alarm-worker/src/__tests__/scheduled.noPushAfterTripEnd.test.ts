/**
 * #3005 / #3100 PR-3 — F-E1 + F-S2 (D1 11/02 트립 186 재현).
 *
 * 실측 시퀀스: 20:02:46 destination skipped(`ssot-not-at-or-approaching`) -> 같은 tick trip-end(lock-active-destination) ->
 * 20:03:16 mid-cycle이 끝난 트립에 destination push를 또 발사(midCycle:true).
 * 이 하네스는 SSoT를 목적지가 아닌 역(군자)에 두어 1차 pass의 도착 push를 같은 게이트로 막고(= 2033 skip),
 * 열차는 목적지 진입(arvlCd=1)으로 보고해 trip을 끝낸 뒤, 1차 pass가 반환한 스냅샷을 그대로 mid-cycle에 넘긴다.
 *
 *  F-E1: 종료된 트립에 대해 mid-cycle push 0.
 *  F-S2: trip-ended alert는 무소리였다 -> 취침 트립의 하차 도착 알람(alarm.wav)이 mid-cycle(F-E1)에만 의존했다.
 *        F-E1을 고쳐도 취침 하차 알람은 정확히 1회 나가야 하고(중복 0), 비취침은 무음 배너 1회(알람 소리 0)다.
 *
 * 기대값은 이슈 스펙에서 온다: 소리 리터럴은 정책 표를 import하지 않고 적는다.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runMidCycleFireOnly, runScheduled } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { seedSsot } from '../tripPositionSsot';
import { putTrip } from '../trips';
import { appendPositionPoint } from '../positionSeries';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;
const MID_OFFSET_MS = 30_000;
const HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;
const TOKEN = 'tripend-tok';
const TRAIN = '7246';
const DESTINATION = '어린이대공원';
const OTHER_STATION = '군자';

interface Captured {
  collapseId?: string;
  body: { aps: { sound?: string; 'interruption-level'?: string }; data?: { kind?: string } };
}

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: HOSTS.production,
    APNS_HOST_SANDBOX: HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: apnsConfig.keyId,
    APNS_TEAM_ID: apnsConfig.teamId,
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: apnsConfig.bundleId,
  };
}

function makeTrip(sleepModeEnabled: boolean): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: 1 },
    destination: DESTINATION,
    waypoints: [{ stationName: DESTINATION, line: '7', kind: 'destination' }],
    expiresAt: NOW + 3 * 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW - 60_000,
    sleepModeEnabled,
    boardingLock: {
      trainCode: TRAIN,
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: NOW,
      segmentStations: [DESTINATION],
      expiresAt: NOW + 3 * 60 * 60_000,
    },
  };
}

function seoulEntering(): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async (url: string) =>
      url.includes('/realtimePosition/')
        ? new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 })
        : new Response(
            JSON.stringify({
              realtimeArrivalList: [
                {
                  barvlDt: '0',
                  recptnDt: '',
                  updnLine: '상행',
                  trainLineNm: DESTINATION,
                  btrainNo: TRAIN,
                  subwayNm: '지하철7호선',
                  arvlCd: '1',
                },
              ],
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
  });
}

/** 1차 cron pass + 같은 스냅샷으로 mid-cycle pass 1회. 실제 APNs 요청을 단계별로 분리해 돌려준다. */
async function runOneCycle(opts: {
  sleep: boolean;
  ssotStation: string;
  tripOverride?: (trip: Trip) => Trip;
  farGpsSeries?: boolean;
}) {
  const kv = new InMemoryKV(() => NOW);
  const env = makeEnv(kv);
  const baseTrip = makeTrip(opts.sleep);
  await putTrip(kv as unknown as KVNamespace, opts.tripOverride ? opts.tripOverride(baseTrip) : baseTrip);
  if (opts.farGpsSeries) {
    // 서울 도심(목적지 어린이대공원에서 수 km 밖), 신선한 fix.
    await appendPositionPoint(kv as unknown as KVNamespace, TOKEN, { lat: 37.5, lng: 126.9, accuracy: 10, ts: NOW, motion: 'automotive' });
  }
  await seedSsot(kv as unknown as KVNamespace, TOKEN, opts.ssotStation, { line: '7' });

  const calls: Captured[] = [];
  const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ collapseId: init?.headers?.['apns-collapse-id'], body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;

  const seoul = seoulEntering();
  const stats = await runScheduled(env, {
    seoul,
    apnsConfig,
    apnsHosts: HOSTS,
    fetchImpl,
    now: () => NOW,
    generatePushId: () => 'p-main',
  });
  const mainCalls = calls.splice(0);
  await runMidCycleFireOnly(
    env,
    stats.midCycleSnapshot,
    { seoul, apnsConfig, apnsHosts: HOSTS, fetchImpl },
    NOW + MID_OFFSET_MS,
    () => undefined,
    () => 'p-mid',
  );
  const midCalls = calls.splice(0);
  return { mainCalls, midCalls, kv };
}

const kindOf = (c: Captured) => c.body.data?.kind;
const stationArrivals = (cs: Captured[]) => cs.filter((c) => kindOf(c) === 'destination' || kindOf(c) === 'station-arrival');
const tripEnded = (cs: Captured[]) => cs.filter((c) => kindOf(c) === 'trip-ended');
const alarms = (cs: Captured[]) => cs.filter((c) => c.body.aps.sound === 'alarm.wav');

describe('#3005 F-E1 — 1차 pass에서 종료된 트립에 mid-cycle이 push를 내지 않는다 (트립 186)', () => {
  for (const sleep of [false, true]) {
    it(`${sleep ? '취침' : '비취침'}: 1차 pass가 게이트로 도착 push를 막고 트립을 끝냈다면 mid-cycle push는 0`, async () => {
      const { mainCalls, midCalls } = await runOneCycle({ sleep, ssotStation: OTHER_STATION });
      // 전제: 실측 2033->2035와 같은 상태 — 1차 pass에는 역 도착 push가 없고 trip-ended만 있다.
      expect(stationArrivals(mainCalls)).toHaveLength(0);
      expect(tripEnded(mainCalls)).toHaveLength(1);
      // F-E1: 끝난 트립에 mid-cycle push 0 (모든 종류).
      expect(midCalls).toEqual([]);
    });
  }
});

describe('#3100 F-S2 — 종료 경로에서도 취침 하차 도착 알람은 정확히 1회, 비취침은 알람 소리 0', () => {
  it('취침: 도착 push가 게이트로 막혀 trip-end로 끝나면 trip-ended alert가 alarm.wav + time-sensitive로 나간다 (전체 알람 정확히 1)', async () => {
    const { mainCalls, midCalls } = await runOneCycle({ sleep: true, ssotStation: OTHER_STATION });
    const all = [...mainCalls, ...midCalls];
    expect(alarms(all)).toHaveLength(1);
    const [alarm] = alarms(all);
    expect(kindOf(alarm)).toBe('trip-ended');
    expect(alarm.body.aps['interruption-level']).toBe('time-sensitive');
  });

  it('취침: 1차 pass가 도착 push를 이미 보냈다면(SSoT가 목적지) 알람은 그 push 1회뿐 — trip-ended는 무음, 중복 0', async () => {
    const { mainCalls, midCalls } = await runOneCycle({ sleep: true, ssotStation: DESTINATION });
    const all = [...mainCalls, ...midCalls];
    expect(alarms(all)).toHaveLength(1);
    expect(kindOf(alarms(all)[0])).not.toBe('trip-ended');
    const [ended] = tripEnded(all);
    expect(ended.body.aps.sound).toBeUndefined();
    expect(midCalls).toEqual([]);
  });

  it('비취침: trip-end 무음 배너 1회, 알람 소리 0 (정책 표: 비취침 하차 도착 = 무음 active)', async () => {
    const { mainCalls, midCalls } = await runOneCycle({ sleep: false, ssotStation: OTHER_STATION });
    const all = [...mainCalls, ...midCalls];
    expect(alarms(all)).toHaveLength(0);
    expect(all.filter((c) => c.body.aps.sound !== undefined)).toHaveLength(0);
    expect(tripEnded(all)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// audit-sides — F-S2 형제 종료 경로 판정 (PR 본문 판정표)
const INTERMEDIATE = '군자';
const onlyIntermediate = (trip: Trip): Trip => ({
  ...trip,
  waypoints: [{ stationName: INTERMEDIATE, line: '7', kind: 'intermediate' }],
});

describe('audit-sides — waypoints-exhausted 종료(lock-active, 마지막 intermediate 통과)', () => {
  it('취침: 도착 push 없이 끝나면 종료 alert가 alarm.wav + time-sensitive로 겸한다 (알람 정확히 1, mid-cycle 0)', async () => {
    const { mainCalls, midCalls } = await runOneCycle({ sleep: true, ssotStation: INTERMEDIATE, tripOverride: onlyIntermediate });
    const all = [...mainCalls, ...midCalls];
    expect(tripEnded(all)).toHaveLength(1);
    expect(alarms(all)).toHaveLength(1);
    expect(kindOf(alarms(all)[0])).toBe('trip-ended');
    expect(alarms(all)[0].body.aps['interruption-level']).toBe('time-sensitive');
    expect(midCalls).toEqual([]);
  });

  it('비취침: 종료 alert는 무음 배너 1회, 소리 0', async () => {
    const { mainCalls, midCalls } = await runOneCycle({ sleep: false, ssotStation: INTERMEDIATE, tripOverride: onlyIntermediate });
    const all = [...mainCalls, ...midCalls];
    expect(tripEnded(all)).toHaveLength(1);
    expect(all.filter((c) => c.body.aps.sound !== undefined)).toHaveLength(0);
  });
});

describe('audit-sides — lockless 종료는 겸용하지 않는다 (lock 없음 = 알림 없음)', () => {
  it('취침 lockless 마지막 intermediate 소진: 종료 alert 무음, alarm.wav 0', async () => {
    const { mainCalls, midCalls } = await runOneCycle({
      sleep: true,
      ssotStation: INTERMEDIATE,
      tripOverride: (trip) => {
        const { boardingLock: _lock, ...lockless } = onlyIntermediate(trip);
        return lockless;
      },
    });
    const all = [...mainCalls, ...midCalls];
    expect(alarms(all)).toHaveLength(0);
    for (const ended of tripEnded(all)) expect(ended.body.aps.sound).toBeUndefined();
  });
});

describe('audit-sides — gps-far backstop 종료는 겸용하지 않는다 (사용자가 멀리 있음)', () => {
  it('취침: 목적지 도달 후 GPS가 계속 멀어 backstop으로 끝나면 종료 alert 무음, alarm.wav 0', async () => {
    const { mainCalls, midCalls } = await runOneCycle({
      sleep: true,
      ssotStation: OTHER_STATION,
      farGpsSeries: true,
      tripOverride: (trip) => ({ ...trip, destinationImminentFirstAt: NOW - 16 * 60_000 }),
    });
    const all = [...mainCalls, ...midCalls];
    // 전제: backstop 경로로 실제 종료됐다.
    expect(tripEnded(all)).toHaveLength(1);
    expect(alarms(all).filter((c) => kindOf(c) === 'trip-ended')).toHaveLength(0);
    expect(tripEnded(all)[0].body.aps.sound).toBeUndefined();
  });
});
