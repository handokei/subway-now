/**
 * #3350 A2/A3 — leg-2 탑승 프롬프트 평가의 (A2) weak-axis 게이트 예외 + (A3) 무기록 분기 D1 기록.
 *
 * A2: trackingOptIn-only trip은 lock 이력(`lockEverAttached`/`boardingCommitted`)이 없으면 leg-2 프롬프트가 차단된다(#3025).
 *     그러나 device가 환승역 도착을 직접 관측(`transferObservedAt`이 currentLegAnchor 역과 일치)한 trip은 lock 이력이 없어도 leg-2 기회를 얻어야 한다.
 * A3: leg-2 평가 중 무기록이던 분기(no-opt-in / weak-axis-blocked / SSoT 없는 no-anchor·결과)를 SSoT 없이 D1에 전이 시에만 기록한다.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { createEmptyScheduledStats, maybeFireLegBoardingPrompt, type ScheduledDeps } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeTripEventSink } from './helpers/replay20261019';

const NOW = 1_700_000_000_000;
const HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;
let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());

function arrivals(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        realtimeArrivalList: [
          { barvlDt: '60', recptnDt: '', updnLine: '상행', trainLineNm: '건대입구', btrainNo: '7246', subwayNm: '지하철7호선', arvlCd: 1 },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

function setup(db: D1Database) {
  const fetchImpl = arrivals();
  const deps: ScheduledDeps = {
    apnsConfig,
    apnsHosts: HOSTS,
    fetchImpl,
    seoul: new SeoulArrivalClient({ host: 'seoul.api', apiKey: 'KEY', fetchImpl }),
    archFlag: 'off',
  };
  const env = {
    TRIPS: new InMemoryKV() as unknown as KVNamespace,
    APNS_HOST: HOSTS.production,
    APNS_HOST_SANDBOX: HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
    DB: db,
  } as Env;
  return { deps, env };
}

function makeLeg2Trip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'trip-3350-leg2',
    createdAt: NOW - 20 * 60_000,
    waypoints: [{ stationName: '용마산', line: '7', kind: 'destination' }],
    apnsEnv: 'production',
    registeredAt: NOW,
    currentLegAnchor: { boardingStation: '건대입구', line: '7' },
    legBoardingEligibleAt: NOW,
    promptOptIn: false,
    infoModeEnabled: false,
    trackingOptIn: false,
    ...overrides,
  } as unknown as Trip;
}

async function run(trip: Trip) {
  const { db, events } = makeTripEventSink();
  const { deps, env } = setup(db);
  const stats = createEmptyScheduledStats(NOW);
  await maybeFireLegBoardingPrompt(trip, env, deps, stats, NOW, () => {}, () => 'pid-3350');
  // fake D1은 INSERT 시도만 잡는다(전이 dedup은 `recordTripEventOnTransition`의 조건부 INSERT SQL — tripEventLog.test.ts 소관).
  const legRows = events.filter((e) => e.kind === 'leg-boarding-prompt').map((e) => e.meta as { leg?: string; outcome: string });
  return { stats, legRows };
}

describe('#3350 A2 — weak-axis 게이트: 환승 관측으로 찍힌 anchor는 lock 이력 없이도 leg-2 프롬프트 허용', () => {
  it('trackingOptIn만 + lock 이력 없음 + transferObservedAt==anchor 역 -> 발사', async () => {
    const trip = makeLeg2Trip({ trackingOptIn: true, transferObservedAt: { stationName: '건대입구', line: '2', atMs: NOW - 30_000 } });
    const { stats } = await run(trip);
    expect(stats.legBoardingPromptFired).toBe(1);
    expect(stats.trackingOptInNoBoardingEvidenceBlocked).toBe(0);
  });

  it('거부: transferObservedAt이 anchor 역과 다르면(다른 역 관측) 기존대로 차단', async () => {
    const trip = makeLeg2Trip({ trackingOptIn: true, transferObservedAt: { stationName: '성수', line: '2', atMs: NOW - 30_000 } });
    const { stats } = await run(trip);
    expect(stats.legBoardingPromptFired).toBe(0);
    expect(stats.trackingOptInNoBoardingEvidenceBlocked).toBe(1);
  });

  it('거부: 환승 관측 없음 + lock 이력 없음 -> 기존대로 차단(#3025 ③ 유지)', async () => {
    const { stats } = await run(makeLeg2Trip({ trackingOptIn: true }));
    expect(stats.legBoardingPromptFired).toBe(0);
    expect(stats.trackingOptInNoBoardingEvidenceBlocked).toBe(1);
  });
});

describe('#3350 A3 — leg-2 평가 무기록 분기 D1 기록(SSoT 없이, 전이 시에만)', () => {
  it('의향 축 전무 -> outcome=no-opt-in', async () => {
    const { legRows } = await run(makeLeg2Trip());
    expect(legRows).toEqual([{ leg: 'leg2', outcome: 'no-opt-in' }]);
  });

  it('trackingOptIn-only 차단 -> outcome=weak-axis-blocked', async () => {
    const { legRows } = await run(makeLeg2Trip({ trackingOptIn: true }));
    expect(legRows).toEqual([{ leg: 'leg2', outcome: 'weak-axis-blocked' }]);
  });

  it('SSoT 없는 trip의 anchor 부재 -> outcome=no-anchor 기록', async () => {
    const { legRows } = await run(makeLeg2Trip({ infoModeEnabled: true, currentLegAnchor: undefined }));
    expect(legRows).toEqual([{ leg: 'leg2', outcome: 'no-anchor' }]);
  });

  it('SSoT 없는 trip의 leg-2 발사 평가 -> outcome=fired 기록', async () => {
    const { legRows } = await run(makeLeg2Trip({ infoModeEnabled: true }));
    expect(legRows.map((r) => r.outcome)).toEqual(['fired']);
    expect(legRows[0].leg).toBe('leg2');
  });
});

