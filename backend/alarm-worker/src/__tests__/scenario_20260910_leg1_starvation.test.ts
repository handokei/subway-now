/**
 * 2026-09-10 라이드 leg-1 침묵 시나리오 격리 테스트 (용마산7→건대입구환승→뚝섬2).
 *
 * 사용자 통증: leg-1(용마산→중곡→군자→어린이) 매역 도착 알림 전무, 현재역이 용마산에 고정.
 * D1(token b00dd879)은 모든 advance가 device sync발이고 cron 독립 advance/fire가 0건임을 보였다.
 *
 * 이 테스트의 목적 = "backend 추적 경로 자체가 깨졌나, 아니면 active lock이 backend에 없어서
 * 굶었나"를 코드로 격리한다. 두 케이스를 같은 trip shape로 대조:
 *   (A) active lock 있음 → cron이 중곡을 arvlCd로 advance+fire (backend 추적 정상 증명)
 *   (B) active lock 없음(lockMissing, 라이드 실측 상태) → 추적 0, boarding prompt만 → leg-1 침묵 재현
 *
 * 결론이 (A) pass + (B) 추적0 이면: backend 추적은 견고하며, 라이드 침묵의 root는 상류
 * (lock이 backend에 active로 도달 못 함)에 있음이 코드로 확정된다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runScheduled, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { getTrip, putTrip } from '../trips';
import { seedSsot, writeSsot } from '../tripPositionSsot';
import { isBoardingLockActive } from '../scheduled';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: pem, bundleId: 'com.example.app' };
});

beforeEach(() => resetApnsJwtCache());

// 실시계 기준 — POST /trips 핸들러의 validateTrip이 내부 Date.now()로 expiresAt 유효성을
// 검사하므로(app.fetch 경로), 고정 과거 NOW를 쓰면 invalid-expiresAt로 거부된다. cron/Seoul도
// 같은 NOW를 공유해 정합을 맞춘다.
const NOW = Date.now();
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

/** 중곡(7호선)에 열차 7039가 arvlCd=1(도착)로 뜬 Seoul 응답. */
function makeSeoulTrainAt(station: string, trainCode: string, subwayId: string, arvlCd: number): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: '30',
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: station,
              btrainNo: trainCode,
              subwayNm: null,
              subwayId,
              arvlCd,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

function makeLock(): BoardingLockMeta {
  return {
    trainCode: '7039',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW - 60_000,
    segmentStations: ['용마산', '중곡', '군자'],
    expiresAt: NOW + 60 * 60_000,
  };
}

/** 용마산7→건대입구환승→뚝섬2. waypoint[0]=중곡(leg-1 첫 intermediate). */
function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'scenario-0910-tok',
    route: { type: 'transfer', fromLine: '7', toLine: '2', transferName: '건대입구', stops: 6, stopsToTransfer: 4, stopsFromTransfer: 2 } as unknown as Trip['route'],
    destination: '뚝섬',
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '건대입구', line: '2', kind: 'transfer' },
      { stationName: '뚝섬', line: '2', kind: 'destination' },
    ],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW - 10 * 60_000,
    alarmAtEpochMs: NOW,
    ...overrides,
  };
}

async function runOnce(kv: InMemoryKV, seoul: SeoulArrivalClient): Promise<ScheduledStats> {
  const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
  return runScheduled(makeEnv(kv), {
    seoul,
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
    generatePushId: () => 'scenario-0910-push',
  } satisfies ScheduledDeps);
}

describe('2026-09-10 leg-1 침묵 격리 (용마산7→뚝섬2)', () => {
  it('(A) active lock 있으면 cron이 중곡을 arvlCd로 advance+fire — backend 추적 정상', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({ boardingLock: makeLock() });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '용마산', {
      expiresAt: trip.expiresAt,
    });
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const seoul = makeSeoulTrainAt('중곡', '7039', '1007', 1);
    const stats = await runOnce(kv, seoul);

    expect(stats.arvlCdFireSuccess).toBe(1);
  });

  it('(B) active lock 없으면(lockMissing, 라이드 실측 상태) cron 추적 0 — leg-1 침묵 재현', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip(); // boardingLock 미부여
    await putTrip(kv as unknown as KVNamespace, trip);

    const seoul = makeSeoulTrainAt('중곡', '7039', '1007', 1);
    const stats = await runOnce(kv, seoul);

    // lock 없으면 runTrainCodeTracking 경로에 진입하지 못해 매역 arvlCd fire가 0건.
    expect(stats.arvlCdFireSuccess).toBe(0);
  });

  it('(C) 탭 lock을 POST /trips로 보내면 backend가 active로 저장한다 — 전달 사슬(backend half) 확정', async () => {
    // 9/10 shape: 사용자가 용마산에서 7039(7호선) 탭 → device가 register(POST /trips)에 lock 동봉.
    // waypoints에 line-7이 포함되므로 isBoardingLockConsistentWithWaypoints 통과 → 드롭 안 됨.
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const body = {
      token: 'scenario-0910-e2e',
      route: { type: 'transfer', fromLine: '7', toLine: '2', transferName: '건대입구', stops: 6, stopsToTransfer: 4, stopsFromTransfer: 2 },
      destination: '뚝섬',
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '건대입구', line: '2', kind: 'transfer' },
        { stationName: '뚝섬', line: '2', kind: 'destination' },
      ],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW - 10 * 60_000,
      alarmAtEpochMs: NOW,
      boardingLock: {
        trainCode: '7039',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW - 60_000,
        segmentStations: ['용마산', '중곡', '군자'],
        expiresAt: NOW + 60 * 60_000,
      },
    };
    const res = await app.fetch(
      new Request('http://example.com/trips', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const stored = await getTrip(env.TRIPS, 'scenario-0910-e2e');
    expect(stored?.boardingLock?.trainCode).toBe('7039');
    expect(isBoardingLockActive(stored as Trip, NOW)).toBe(true);
  });

  it('(E) ★fix 회귀: 탭 lock trip은 motionState=stationary + SSoT.userIntentDeclared=false(stale)여도 추적 (#2554 배선)', async () => {
    // 지하서 GPS 얼면 motion이 stationary로 오판된다. #2554 이전엔 userIntentDeclared를 true로
    // 세팅하는 배선이 없어(dead wire) 탭 lock이 있어도 stationary+intermediate면 skip → leg-1 침묵.
    // #2554 fix: stationary 게이트가 trip의 확정(boardingLock/infoModeEnabled)을 직접 파생(OR)해
    // SSoT 필드가 stale-false여도 탭한 trip은 우회. 이 테스트가 red→green 회귀 방어.
    const kv = new InMemoryKV();
    const trip = makeTrip({ boardingLock: makeLock() });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '용마산', {
      expiresAt: trip.expiresAt,
    });
    // 정지 판정 + SSoT 필드는 stale-false(탭 전에 seed된 상황 재현) + sync fresh.
    await writeSsot(
      kv as unknown as KVNamespace,
      { ...ssot, motionState: 'stationary', userIntentDeclared: false, lastDeviceSyncAt: NOW },
      { expiresAt: trip.expiresAt },
    );

    const seoul = makeSeoulTrainAt('중곡', '7039', '1007', 1);
    const stats = await runOnce(kv, seoul);

    // #2554 fix: trip.boardingLock에서 의향 파생 → stationary 우회 → cron 추적 → 중곡 매역 fire.
    expect(stats.arvlCdFireSuccess).toBe(1);
    expect(stats.lifecycleStationarySkipped).toBe(0);
  });

  it('(F) 대조: lockless(정보용) trip은 stationary면 여전히 skip — 절전 게이트 보존', async () => {
    // lock 없는 lockless trip은 backend 독립 추적 대상이 아니므로 stationary skip(절전)을 그대로
    // 유지한다. #2554 우회는 lock 활성 trip에만 적용 — lockless 회귀 없음.
    const kv = new InMemoryKV();
    const trip = makeTrip(); // boardingLock 미부여(lockless)
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '용마산', {
      expiresAt: trip.expiresAt,
    });
    await writeSsot(
      kv as unknown as KVNamespace,
      { ...ssot, motionState: 'stationary', userIntentDeclared: false, lastDeviceSyncAt: NOW },
      { expiresAt: trip.expiresAt },
    );

    const seoul = makeSeoulTrainAt('중곡', '7039', '1007', 1);
    const stats = await runOnce(kv, seoul);

    // lockless + stationary → skip 유지 → 추적 0.
    expect(stats.arvlCdFireSuccess).toBe(0);
    expect(stats.lifecycleStationarySkipped).toBeGreaterThan(0);
  });

  it('(D) 전달된 lock으로 cron이 즉시 추적 — POST /trips → cron 매역 fire 사슬 end-to-end', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const body = {
      token: 'scenario-0910-chain',
      route: { type: 'transfer', fromLine: '7', toLine: '2', transferName: '건대입구', stops: 6, stopsToTransfer: 4, stopsFromTransfer: 2 },
      destination: '뚝섬',
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '건대입구', line: '2', kind: 'transfer' },
        { stationName: '뚝섬', line: '2', kind: 'destination' },
      ],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW - 10 * 60_000,
      alarmAtEpochMs: NOW,
      boardingLock: {
        trainCode: '7039',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW - 60_000,
        segmentStations: ['용마산', '중곡', '군자'],
        expiresAt: NOW + 60 * 60_000,
      },
    };
    await app.fetch(
      new Request('http://example.com/trips', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );

    const seoul = makeSeoulTrainAt('중곡', '7039', '1007', 1);
    const stats = await runOnce(kv, seoul);

    // POST /trips로 들어온 lock만으로 cron이 leg-1 중곡을 arvlCd로 advance+fire.
    expect(stats.arvlCdFireSuccess).toBe(1);
  });
});
