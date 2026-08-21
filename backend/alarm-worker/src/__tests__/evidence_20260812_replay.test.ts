/**
 * 2026-08-12 저녁 실탑승 dump replay test (#2306 RCA → #2321).
 *
 * 목적: token_hash b00dd879, 18:26:49~18:51:09 KST(25분) device sync 부재(앱 suspend) 동안
 * 7호선 4역 통과 + 용마산 목적지 알림이 0건이었던 evidence를 fixture로 재현한다.
 * lock 활성(trainCode 보유) trip에서 arvlCd waypoint arrivals가 존재해도 backend 4중 게이트
 * (stationary cron skip / motion 게이트 / transfer-destination 60s 신선도 / stale SSoT fire
 * 3분 guard)가 모두 "device 최근 갱신" 전제로 설계돼 있어 25분 침묵 동안 advance/fire 둘 다
 * 0건으로 동결됐다.
 *
 * 재기저 후 acceptance:
 *  - device sync stale(#2321 DEVICE_SYNC_STALE_THRESHOLD_MS 초과) + lock 활성 + trainCode 일치
 *    arvlCd evidence → 게이트 dormant, arvlCd ground truth로 advance + fire.
 *  - Seoul outage(신호 자체 부재) 시에는 device stale이어도 침묵 유지(오발사 0) — 시간 적분
 *    추정 금지 기존 룰 무회귀.
 *  - device sync가 신선한 기존 케이스는 전부 기존 게이트 동작 그대로(무회귀) — 이 파일에서는
 *    회귀 여부를 lifecycleStationarySkipped=1 그대로 유지되는 별도 fresh 시나리오로 확인.
 *
 * 동작 원칙: 관측 가능한 결과(advance/fire count, log reason)만 assert. 내부 함수 호출 여부는
 * assert하지 않는다.
 */

import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import {
  runScheduled,
  type ScheduledDeps,
  type ScheduledStats,
} from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { putTrip } from '../trips';
import { seedSsot, writeSsot } from '../tripPositionSsot';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: pem,
    bundleId: 'com.example.app',
  };
});

beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;
const TWENTY_FIVE_MIN_MS = 25 * 60 * 1000;

const APNS_HOSTS = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
} as const;

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

// evidence trip — 7호선 용마산 lock, trainCode '7246' (2026-08-12 저녁 dump 재현).
function makeBoardingLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW - 30 * 60_000,
    segmentStations: ['건대입구', '중곡', '군자', '용마산'],
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  };
}

function makeArrivedSeoul(stationName: string, trainCode = '7246'): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: '0',
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: stationName,
              btrainNo: trainCode,
              // #2355 — 실 Seoul API는 subwayNm=null, subwayId만 유효값으로 보낸다. subwayId만
              // 남겨 seoul.ts:parseEntry가 subwayId→line 역파생 경로를 타도록 fixture 교정
              // (masking 제거).
              subwayNm: null,
              subwayId: '1007',
              arvlCd: 1,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

// Seoul outage — realtimeArrivalList 빈 응답 (신호 자체 부재).
function makeOutageSeoul(): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
  });
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'evidence-0812-tok',
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '용마산',
    waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
    boardingLock: makeBoardingLock(),
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW - 30 * 60_000,
    alarmAtEpochMs: NOW - 60_000,
    ...overrides,
  };
}

async function runOnce(
  kv: InMemoryKV,
  seoul: SeoulArrivalClient,
  fetchImpl: ReturnType<typeof vi.fn>,
): Promise<ScheduledStats> {
  return runScheduled(makeEnv(kv), {
    seoul,
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
    generatePushId: () => 'evidence-0812-push',
  } satisfies ScheduledDeps);
}

describe('evidence 2026-08-12 저녁 25분 device silence — staleness-aware gates (#2321)', () => {
  it('intermediate waypoint(중곡) — 25분 device 침묵 + lock trainCode 일치 arvlCd → advance+fire (gate #1/#2)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '건대입구', {
      expiresAt: trip.expiresAt,
    });
    ssot.motionState = 'stationary';
    ssot.lastAdvanceAt = NOW - TWENTY_FIVE_MIN_MS;
    ssot.lastAdvanceEvidence = 'arvlcd-confirmed-train';
    // #2321 — device가 25분 전 마지막으로 /position을 보낸 뒤 침묵(앱 suspend). motionState는
    // 그 시점의 마지막 값('stationary')에 영구 고정된 채 갱신되지 않는다.
    ssot.lastDeviceSyncAt = NOW - TWENTY_FIVE_MIN_MS;
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runOnce(kv, makeArrivedSeoul('중곡'), fetchImpl);

    expect(stats.arvlCdFireFired).toBe(1);
    expect(stats.arvlCdFireSuccess).toBe(1);
    expect(stats.lifecycleStationarySkipped).toBe(0);
  });

  it('destination waypoint(용마산) — 25분 device 침묵 + approaching + lock trainCode 일치 → advance+fire (gate #3/#4)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      destination: '용마산',
      waypoints: [{ stationName: '용마산', line: '7', kind: 'destination' }],
      passedStations: ['군자'],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '군자', {
      expiresAt: trip.expiresAt,
    });
    ssot.motionState = 'stationary';
    ssot.lastAdvanceAt = NOW - TWENTY_FIVE_MIN_MS;
    ssot.lastAdvanceEvidence = 'arvlcd-confirmed-train';
    ssot.lastDeviceSyncAt = NOW - TWENTY_FIVE_MIN_MS;
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runOnce(kv, makeArrivedSeoul('용마산'), fetchImpl);

    expect(stats.arvlCdFireFired).toBe(1);
    expect(stats.arvlCdFireSuccess).toBe(1);
    expect(stats.transferDestinationGateBlocked).toBe(0);
  });

  it('Seoul outage(신호 부재) + 25분 device 침묵 → 오발사 0 (침묵 유지, 시간 적분 추정 금지 무회귀)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '건대입구', {
      expiresAt: trip.expiresAt,
    });
    ssot.motionState = 'stationary';
    ssot.lastAdvanceAt = NOW - TWENTY_FIVE_MIN_MS;
    ssot.lastAdvanceEvidence = 'arvlcd-confirmed-train';
    ssot.lastDeviceSyncAt = NOW - TWENTY_FIVE_MIN_MS;
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runOnce(kv, makeOutageSeoul(), fetchImpl);

    expect(stats.arvlCdFireFired).toBe(0);
    expect(stats.arvlCdFireSuccess).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('무회귀 — device sync 신선(정상 운행) + stationary + intermediate → 기존 stationary skip 게이트 그대로 유지', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '건대입구', {
      expiresAt: trip.expiresAt,
    });
    ssot.motionState = 'stationary';
    // device sync가 방금(0ms 전) 갱신됨 — fresh. 기존 V8d stationary skip 게이트가 그대로 적용돼야 한다.
    ssot.lastDeviceSyncAt = NOW;
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const stats = await runOnce(kv, makeArrivedSeoul('중곡'), fetchImpl);

    expect(stats.lifecycleStationarySkipped).toBe(1);
    expect(stats.arvlCdFireFired).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
