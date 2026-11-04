/**
 * K5 #2926 PR-A — lockless 진행 전진 hold (KillSwitch `lockless_advance_legacy`, 기본 off = hold).
 *
 * 10/21 사용자 결정(memory decision_lock_only_alerts.md:24): lock 없는 여정은 backend가 위치 추적·역 전진·알림을 하지 않는다.
 * cron C1(`runLocklessIntermediate`) / C2(`runLocklessTransfer`) / C3(`runLocklessDestination`)과 sync `capLocklessSyncAdvance`가 그 대상.
 * 11/04 whole-trip replay는 `replay_20261104_lockless_wait_advance.test.ts`.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { getKillSwitch, isKillSwitchKey, setKillSwitch } from '../killSwitch';
import { capLocklessSyncAdvance, runScheduled, type ScheduledDeps } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { getTrip, putTrip } from '../trips';
import type { Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());
afterEach(() => vi.unstubAllGlobals());

const NOW = 1_700_000_000_000;
const TOKEN = 'lockless-hold-tok';
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;
const wp = (stationName: string, kind: Waypoint['kind'], line = '7'): Waypoint => ({ stationName, line, kind });

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
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

/** 모든 역 질의에 상·하행 양방향으로 같은 열차가 arvlCd=1 — 방향 추론과 무관하게 전진 신호를 만든다. */
function seoulAlwaysArrived(): SeoulArrivalClient {
  const entry = (updnLine: string) => ({
    barvlDt: '0',
    recptnDt: '',
    updnLine,
    trainLineNm: '종착행',
    btrainNo: '7248',
    subwayNm: '지하철7호선',
    arvlCd: '1',
  });
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async (url: string) =>
      url.includes('/realtimePosition/')
        ? new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 })
        : new Response(JSON.stringify({ realtimeArrivalList: [entry('상행'), entry('하행')] }), { status: 200 })) as unknown as typeof fetch,
  });
}

function makeTrip(waypoints: Waypoint[], overrides: Partial<Trip> = {}): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: waypoints.length },
    destination: waypoints[waypoints.length - 1].stationName,
    waypoints,
    originStationName: '건대입구',
    expiresAt: NOW + 3 * 3_600_000,
    createdAt: NOW - 10 * 60_000,
    alarmAtEpochMs: NOW - 60_000,
    infoModeEnabled: true,
    promptOptIn: true,
    ...overrides,
  };
}

async function tick(trip: Trip, deps: Partial<ScheduledDeps> = {}) {
  const kv = new InMemoryKV(() => NOW);
  await putTrip(kv as unknown as KVNamespace, trip);
  await kv.put(
    `pos:${TOKEN}`,
    JSON.stringify([-40_000, -20_000, 0].map((d, i) => ({ lat: 0, lng: i * 0.0002, accuracy: 10, ts: NOW + d, motion: 'automotive' }))),
  );
  const stats = await runScheduled(makeEnv(kv), {
    seoul: seoulAlwaysArrived(),
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    now: () => NOW,
    generatePushId: () => 'p',
    ...deps,
  });
  return { stats, after: (await getTrip(kv as unknown as KVNamespace, TOKEN)) as Trip | null };
}

describe('KillSwitch lockless_advance_legacy 키', () => {
  it('유효 key이고 기본값 false(= hold)', async () => {
    expect(isKillSwitchKey('lockless_advance_legacy')).toBe(true);
    const kv = new InMemoryKV(() => NOW) as unknown as KVNamespace;
    expect(await getKillSwitch(kv, 'lockless_advance_legacy')).toBe('false');
    await setKillSwitch(kv, 'lockless_advance_legacy', 'true');
    expect(await getKillSwitch(kv, 'lockless_advance_legacy')).toBe('true');
    // 기존 키와 KV 키가 분리돼 있다.
    expect(await getKillSwitch(kv, 'lockless_intermediate')).toBe('false');
  });
});

describe('cron C1 — lockless intermediate 전진 hold', () => {
  const waypoints = () => [wp('군자', 'intermediate'), wp('중곡', 'intermediate'), wp('용마산', 'destination')];

  it('hold(기본): 도착 신호에도 head 불변, 전진 카운터 0', async () => {
    const { after, stats } = await tick(makeTrip(waypoints()));
    expect(after?.waypoints.map((w) => w.stationName)).toEqual(['군자', '중곡', '용마산']);
    expect(stats.locklessIntermediateFired).toBe(0);
  });

  it('legacy=on: 구 동작(head 전진)', async () => {
    const { after } = await tick(makeTrip(waypoints()), { killSwitchLocklessAdvanceLegacy: true });
    expect(after?.waypoints.map((w) => w.stationName)).toEqual(['중곡', '용마산']);
  });
});

describe('cron C2 — lockless transfer 소비·앵커 hold', () => {
  const waypoints = () => [wp('건대입구', 'transfer', '2'), wp('어린이대공원', 'intermediate'), wp('용마산', 'destination')];

  it('hold(기본): 환승 waypoint 미소비, 앵커·legBoardingEligibleAt 미기록, 전진 카운터 0', async () => {
    const { after, stats } = await tick(makeTrip(waypoints(), { originStationName: '뚝섬' }));
    expect(after?.waypoints.map((w) => w.stationName)).toEqual(['건대입구', '어린이대공원', '용마산']);
    expect(after?.currentLegAnchor).toBeUndefined();
    expect(after?.legBoardingEligibleAt).toBeUndefined();
    expect(stats.locklessTransferAdvanced).toBe(0);
  });

  it('legacy=on: 구 동작(환승 소비 + 앵커)', async () => {
    const { after, stats } = await tick(makeTrip(waypoints(), { originStationName: '뚝섬' }), { killSwitchLocklessAdvanceLegacy: true });
    expect(stats.locklessTransferAdvanced).toBe(1);
    expect(after?.currentLegAnchor).toBeDefined();
  });
});

describe('cron C3 — lockless destination 종료 hold', () => {
  const waypoints = () => [wp('용마산', 'destination')];

  it('hold(기본): 종료·하차 확인 프롬프트 없이 trip 유지', async () => {
    const { after, stats } = await tick(makeTrip(waypoints(), { originStationName: '군자' }));
    expect(after?.waypoints.map((w) => w.stationName)).toEqual(['용마산']);
    expect(after?.destinationConfirmPendingSince).toBeUndefined();
    expect(stats.locklessDestinationAdvanced).toBe(0);
    expect(stats.destinationConfirmFired).toBe(0);
  });

  it('legacy=on: 구 동작(하차 판정 진행: pending stamp 또는 종료)', async () => {
    const { after, stats } = await tick(makeTrip(waypoints(), { originStationName: '군자' }), { killSwitchLocklessAdvanceLegacy: true });
    expect(stats.locklessDestinationAdvanced + stats.destinationConfirmFired + (after === null ? 1 : 0)).toBeGreaterThan(0);
  });
});

describe('sync capLocklessSyncAdvance — lockless면 0', () => {
  const trip = makeTrip([wp('군자', 'intermediate'), wp('건대입구', 'transfer', '2'), wp('중곡', 'intermediate'), wp('용마산', 'destination')]);

  it.each([1, 2, 3, 4])('lockless: 요청 %i칸(환승/목적지 포함)도 0으로 cap', (requested) => {
    expect(capLocklessSyncAdvance({ shiftedCount: requested }, trip, NOW)).toEqual({ shiftedCount: 0 });
  });

  it('활성 비PENDING lock이면 무변경', () => {
    const locked: Trip = {
      ...trip,
      boardingLock: { trainCode: '7252', line: '7', subwayId: '1007', selectedDepartureTime: NOW, segmentStations: ['군자', '건대입구', '중곡', '용마산'], expiresAt: NOW + 3_600_000 },
    };
    expect(capLocklessSyncAdvance({ shiftedCount: 3 }, locked, NOW)).toEqual({ shiftedCount: 3 });
  });
});
