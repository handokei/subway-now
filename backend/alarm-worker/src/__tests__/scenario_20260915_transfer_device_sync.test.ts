/**
 * #2645 — 환승역 하차 확정이 arvlCd에 종속되던 회귀의 red→green fixture.
 *
 * 2026-09-15 실 라이드(D1 token_hash=b00dd879) 재구성:
 *   06:35:30  device → POST /boarding-lock/sync  observedStationName=건대입구 (사용자 환승역 도착 확정)
 *   06:36:58  transfer-advance 건대입구(L7) path=lock-active outcome=no-arvlcd (열차 7035가 이미
 *             떠나 arvlCd/positions 둘 다 못 잡음 — 환승 alert/하차 프롬프트/lock 해제 3종 동시 사망)
 *   06:42:52  lock-release:user 7035(7) (사용자가 6분간 떠난 열차를 backend가 추적하다 직접 해제)
 *
 * A안 fix(#2645 결정): device sync가 이미 confirm한 관측(SSoT.currentStationId===waypoint,
 * lastAdvanceEvidence='device-sync', 5분 이내 신선)을 transfer/destination waypoint의 독립
 * 확증으로 채택 — arvlCd/positions 둘 다 없어도(estimateBoardingLockArrival===null) 환승
 * alert(vanish-fallback) + 하차 프롬프트(hop-end) 발사 + lock 해제(isRealLineChange)를 성립시킨다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runScheduled, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { getTrip, putTrip } from '../trips';
import { writeSsot, type TripPositionSSoT } from '../tripPositionSsot';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: pem, bundleId: 'com.example.app' };
});

beforeEach(() => resetApnsJwtCache());

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

/** 7035(7호선) 열차가 건대입구를 이미 떠난 상태 재현 — arrivals/positions 둘 다 매칭 없음. */
function makeSeoulNoMatch(): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ realtimeArrivalList: [], realtimePositionList: [] }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

function makeLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7035',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW - 5 * 60_000,
    // buildLegSegmentStations — transfer waypoint push 직후 break이므로 세그먼트는 건대입구에서 끝난다.
    segmentStations: ['어린이대공원', '건대입구'],
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  };
}

/** 7호선→2호선 환승(건대입구) 후 성수 경유 뚝섬 도착. waypoint[0]=건대입구(transfer). */
function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'scenario-0915-tok',
    route: {
      type: 'transfer',
      fromLine: '7',
      toLine: '2',
      transferName: '건대입구',
      stops: 6,
      stopsToTransfer: 4,
      stopsFromTransfer: 2,
    } as unknown as Trip['route'],
    destination: '뚝섬',
    waypoints: [
      { stationName: '건대입구', line: '7', kind: 'transfer' },
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '뚝섬', line: '2', kind: 'destination' },
    ],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW - 10 * 60_000,
    alarmAtEpochMs: NOW,
    boardingLock: makeLock(),
    ...overrides,
  };
}

function deviceSyncConfirmedSsot(overrides: Partial<TripPositionSSoT> = {}): TripPositionSSoT {
  return {
    tripToken: 'scenario-0915-tok',
    currentStationId: '건대입구',
    motionState: 'stationary',
    motionEvidence: [],
    lastAdvanceAt: NOW,
    lastAdvanceEvidence: 'device-sync',
    passedStations: ['어린이대공원'],
    userIntentDeclared: false,
    seedOverrideCount: 0,
    alarmEvents: [],
    lastDeviceSyncAt: NOW,
    schemaVersion: 3,
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
    generatePushId: () => 'scenario-0915-push',
  } satisfies ScheduledDeps);
}

describe('#2645 환승역 하차 확정 — device sync 구제 (2026-09-15 b00dd879 재구성)', () => {
  it('★fix: arvlCd/positions 없어도 device sync 확증(건대입구)이 있으면 환승 alert + 하차 프롬프트 발사 + lock 해제', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    await writeSsot(kv as unknown as KVNamespace, deviceSyncConfirmedSsot(), {
      expiresAt: trip.expiresAt,
    });

    const stats = await runOnce(kv, makeSeoulNoMatch());

    // 환승 alert(vanish-fallback, arvlCd=null 경로) 발사.
    expect(stats.vanishFallbackFired).toBe(1);
    // "하차했나요?" hop-end 프롬프트 발사.
    expect(stats.hopEndPromptFired).toBe(1);
    // fix 이전이라면 여기서 blocked(motion-stationary/no-arvlcd 고착)였을 것.
    expect(stats.boardingLockWaypointAdvanceBlocked).toBe(0);

    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    // 환승 waypoint 소진 → 다음 waypoint(성수)로 전진.
    expect(after?.waypoints[0]?.stationName).toBe('성수');
    // isRealLineChange(7→2) → 6분간 떠난 열차를 계속 추적하던 회귀를 lock 해제로 차단.
    expect(after?.boardingLock).toBeUndefined();
  });

  it('대조: device sync 확증이 없으면(SSoT 부재) 여전히 no-arvlcd로 고착 — 회귀 원본 재현', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    // SSoT 자체를 쓰지 않음 — 사용자가 sync를 아직 보내지 않은 것과 동형.

    const stats = await runOnce(kv, makeSeoulNoMatch());

    expect(stats.vanishFallbackFired).toBe(0);
    expect(stats.hopEndPromptFired).toBe(0);

    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    // 회귀 원본: waypoint 미전진, lock 미해제 — 떠난 열차를 계속 추적.
    expect(after?.waypoints[0]?.stationName).toBe('건대입구');
    expect(after?.boardingLock?.trainCode).toBe('7035');
  });

  it('오발사 방어: SSoT.currentStationId가 이 waypoint와 다르면(다른 역 관측) 구제하지 않는다', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    await writeSsot(
      kv as unknown as KVNamespace,
      deviceSyncConfirmedSsot({ currentStationId: '어린이대공원' }),
      { expiresAt: trip.expiresAt },
    );

    const stats = await runOnce(kv, makeSeoulNoMatch());

    expect(stats.vanishFallbackFired).toBe(0);
    expect(stats.hopEndPromptFired).toBe(0);
  });

  it('오발사 방어: lastAdvanceEvidence가 device-sync가 아니면(다른 채널 기록) 구제하지 않는다', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    await writeSsot(
      kv as unknown as KVNamespace,
      deviceSyncConfirmedSsot({ lastAdvanceEvidence: 'seed-override' }),
      { expiresAt: trip.expiresAt },
    );

    const stats = await runOnce(kv, makeSeoulNoMatch());

    expect(stats.vanishFallbackFired).toBe(0);
    expect(stats.hopEndPromptFired).toBe(0);
  });

  it('오발사 방어: device sync가 5분 이상 stale이면 구제하지 않는다', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    await writeSsot(
      kv as unknown as KVNamespace,
      deviceSyncConfirmedSsot({ lastDeviceSyncAt: NOW - 6 * 60_000 }),
      { expiresAt: trip.expiresAt },
    );

    const stats = await runOnce(kv, makeSeoulNoMatch());

    expect(stats.vanishFallbackFired).toBe(0);
    expect(stats.hopEndPromptFired).toBe(0);
  });

  it('범위 한정: intermediate waypoint(일반 매역)는 device sync 확증이 있어도 arvlCd 요구가 불변 — 구제 적용 안 함', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      waypoints: [
        { stationName: '군자', line: '7', kind: 'intermediate' },
        { stationName: '건대입구', line: '7', kind: 'transfer' },
        { stationName: '뚝섬', line: '2', kind: 'destination' },
      ],
      boardingLock: makeLock({ segmentStations: ['어린이대공원', '군자'] }),
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    await writeSsot(
      kv as unknown as KVNamespace,
      deviceSyncConfirmedSsot({ currentStationId: '군자' }),
      { expiresAt: trip.expiresAt },
    );

    const stats = await runOnce(kv, makeSeoulNoMatch());

    // intermediate는 이 fix의 스코프 밖 — arvlCd/positions 확증 없이는 여전히 미발사.
    expect(stats.vanishFallbackFired).toBe(0);
    expect(stats.hopEndPromptFired).toBe(0);
    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(after?.waypoints[0]?.stationName).toBe('군자');
  });
});
