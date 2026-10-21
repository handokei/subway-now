/**
 * #3157 — `fireSyncConsumedPrecedingAlarms` 단위 테스트.
 *
 * `/boarding-lock/sync`가 순수 intermediate를 소비(`working.waypoints.slice(shiftedCount)`)하면, 소비된
 * intermediate가 아직 도달하지 않은 transfer/destination 의 직전역일 때 cron의
 * `completeWaypointAdvance`가 그 역을 다시 볼 수 없어 취침/준비 알람이 영구 유실된다(트립 171 "곧 뚝섬").
 * 이 함수가 그 알람을 기존 `maybeFireSleepAlarm`/`maybeFirePrepareAlarm`(기존 dedup 키)으로 발사한다.
 * 호출자는 pre-slice trip과 shiftedCount를 넘긴다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { prepareAlarmCollapseId, sleepAlarmCollapseId } from '../collapseId';
import {
  fireSyncConsumedPrecedingAlarms,
  prepareAlarmFireKey,
  sleepAlarmFireKey,
  type SyncSkippedFireDeps,
} from '../scheduled';
import type { Env, Trip, Waypoint } from '../types';
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

function makeEnv(kv: InMemoryKV): Env {
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
  };
}

const I = (stationName: string): Waypoint => ({ stationName, line: '2', kind: 'intermediate' });
const T = (stationName: string): Waypoint => ({ stationName, line: '2', kind: 'transfer' });
const D = (stationName: string): Waypoint => ({ stationName, line: '2', kind: 'destination' });

function makeTrip(waypoints: Waypoint[], overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'sync-alarm-tok',
    route: { type: 'direct', line: '2', stops: waypoints.length },
    destination: '뚝섬',
    waypoints,
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW - 60_000,
    sleepModeEnabled: true,
    ...overrides,
  };
}

function makeFetch() {
  const collapseIds: string[] = [];
  const pushTypes: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    const h = init?.headers ?? {};
    pushTypes.push(h['apns-push-type']);
    if (h['apns-collapse-id'] !== undefined) collapseIds.push(h['apns-collapse-id']);
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, collapseIds, pushTypes };
}

async function run(trip: Trip, shiftedCount: number, kv = new InMemoryKV(() => NOW)) {
  const f = makeFetch();
  const deps = {
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: f.fetchImpl,
  } as SyncSkippedFireDeps;
  await fireSyncConsumedPrecedingAlarms(makeEnv(kv), trip, shiftedCount, deps, NOW, () => undefined, () => 'push-1');
  return { kv, ...f };
}

describe('#3157 — fireSyncConsumedPrecedingAlarms', () => {
  it('취침: 소비된 마지막 intermediate(역삼)가 destination(선릉) 직전역 -> 취침 알람(alert+companion) 1회', async () => {
    const trip = makeTrip([I('강남'), I('역삼'), D('선릉')]);
    const r = await run(trip, 2);
    expect(r.collapseIds).toEqual([sleepAlarmCollapseId(trip.token, '선릉')]);
    expect(r.pushTypes.sort()).toEqual(['alert', 'background']); // 주 alert + companion silent
    expect(await r.kv.get(sleepAlarmFireKey(trip.token, '선릉'))).not.toBeNull();
  });

  it('비취침: 준비 알람 1회 (취침 알람 키는 건드리지 않음)', async () => {
    const trip = makeTrip([I('강남'), I('역삼'), D('선릉')], { sleepModeEnabled: false });
    const r = await run(trip, 2);
    expect(r.collapseIds).toEqual([prepareAlarmCollapseId(trip.token, '선릉')]);
    expect(await r.kv.get(prepareAlarmFireKey(trip.token, '선릉'))).not.toBeNull();
    expect(await r.kv.get(sleepAlarmFireKey(trip.token, '선릉'))).toBeNull();
  });

  it('transfer 직전역도 동일하게 발사한다', async () => {
    const trip = makeTrip([I('성수'), T('건대입구'), D('뚝섬')]);
    const r = await run(trip, 1);
    expect(r.collapseIds).toEqual([sleepAlarmCollapseId(trip.token, '건대입구')]);
  });

  it('거부 — 직전역이 아닌 intermediate(강남 다음이 intermediate 역삼): 발사 0', async () => {
    const r = await run(makeTrip([I('강남'), I('역삼'), D('선릉')]), 1);
    expect(r.collapseIds).toEqual([]);
    expect(r.pushTypes).toEqual([]);
  });

  it('거부 — 관측역이 destination 자신(타깃 이미 도달): 발사 0', async () => {
    const r = await run(makeTrip([I('강남'), I('역삼'), D('선릉')]), 3);
    expect(r.pushTypes).toEqual([]);
  });

  it('거부 — 여러 개 소비돼도 타깃 직전 1개만 발사 (강남·역삼 소비, 선릉 직전은 역삼)', async () => {
    const r = await run(makeTrip([I('강남'), I('역삼'), I('삼성'), D('선릉')]), 3);
    // 소비 3개(강남, 역삼, 삼성) 중 타깃(선릉)의 직전역은 삼성뿐 — 알람 1회
    expect(r.collapseIds).toHaveLength(1);
  });

  it('이중 발사 없음 — cron이 이미 같은 타깃 키를 선점했으면 0', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip([I('강남'), I('역삼'), D('선릉')]);
    await kv.put(sleepAlarmFireKey(trip.token, '선릉'), '1');
    const r = await run(trip, 2, kv);
    expect(r.pushTypes).toEqual([]);
  });

  it('이중 발사 없음 — 같은 sync를 두 번 처리해도(재시도) 1회', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip([I('강남'), I('역삼'), D('선릉')]);
    const first = await run(trip, 2, kv);
    const second = await run(trip, 2, kv);
    expect(first.collapseIds).toHaveLength(1);
    expect(second.collapseIds).toEqual([]);
  });

  it('push 실패 시 dedup 롤백 (기존 maybeFire 계약 유지 — 다음 기회 보존)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip([I('강남'), I('역삼'), D('선릉')], { sleepModeEnabled: false });
    const failing = vi.fn(async () => new Response('', { status: 400 })) as unknown as typeof fetch;
    await fireSyncConsumedPrecedingAlarms(
      makeEnv(kv),
      trip,
      2,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: failing } as SyncSkippedFireDeps,
      NOW,
      () => undefined,
      () => 'push-1',
    );
    expect(await kv.get(prepareAlarmFireKey(trip.token, '선릉'))).toBeNull();
  });
});
