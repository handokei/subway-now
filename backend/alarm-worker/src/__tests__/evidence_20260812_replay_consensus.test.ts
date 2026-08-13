/**
 * 2026-08-12 저녁 25분 침묵 evidence의 leg2 공백 replay — consensus-C(#2329, 설계 SSoT #2323).
 *
 * `evidence_20260812_replay.test.ts`(#2321)가 다룬 것은 lock 활성 trip의 device-sync-stale
 * 4중 게이트 회귀였다. 본 파일은 그 evidence의 다른 절반 — 오토락 재부착이 삭제된(#2154) 이후
 * 환승 직후 leg2가 진짜 lockless가 되는 구조 자체를 재현한다: C 토글(infoModeEnabled) OFF인
 * lockless trip은 `runLocklessIntermediate`(C 토글 전용 경로)로 진입하지 못해 종전엔
 * `stats.lockMissing`만 누적된 채 advance/fire가 영구 0이었다(08-12 실측: 25분 침묵 + 알림 0건).
 *
 * 08-12 저녁 페이퍼 시뮬레이션(#2323 설계안 (7)) 파라미터를 그대로 사용한다:
 *   W(transferTimeSec)=278s(건대입구 2→7), hop 80s. 두 cron cycle(80s 간격) 연속 match로
 *   confirmed에 도달 — CONFIRM_MIN_MATCH_COUNT=2.
 *
 * acceptance:
 *  - confirmed 전(cycle 1, match=1) → advance/fire 0.
 *  - confirmed 후(cycle 2, match=2) → advance 1 + 기존 `fireArvlCdStationPush` 재사용 발사 1건
 *    (신규 emitter 없음 — dedup/APNs 전송 경로 전부 arvlCd fire path 그대로).
 */

import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runScheduled, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { putTrip } from '../trips';
import { seedSsot, writeSsot } from '../tripPositionSsot';
import type { Env, Trip } from '../types';
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

const T0 = 1_700_000_000_000;
const HOP_MS = 80_000;

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

// 장암행 후보 trainCode '8801' — 7호선 상행(중곡 방향), ETA는 cycle마다 80s씩 카운트다운
// (실제 열차가 일관되게 접근 중이라는 신호. 예측 절대 도착시각은 두 cycle 모두 T0+300s로 동일).
function makeConsensusSeoul(now: number, etaSeconds: number): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => now,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: String(etaSeconds),
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: '중곡',
              btrainNo: '8801',
              subwayNm: '지하철7호선',
              arvlCd: 3,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'evidence-0812-consensus-tok',
    route: { type: 'direct', line: '7', stops: 4 },
    destination: '중곡',
    waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
    boardingLock: undefined,
    infoModeEnabled: false,
    subsurface: true,
    expiresAt: T0 + 60 * 60_000,
    createdAt: T0 - 30 * 60_000,
    alarmAtEpochMs: T0 - 60_000,
    ...overrides,
  };
}

async function runOnce(
  kv: InMemoryKV,
  seoul: SeoulArrivalClient,
  fetchImpl: ReturnType<typeof vi.fn>,
  now: number,
): Promise<ScheduledStats> {
  return runScheduled(makeEnv(kv), {
    seoul,
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => now,
    generatePushId: () => 'evidence-0812-consensus-push',
  } satisfies ScheduledDeps);
}

describe('evidence 2026-08-12 leg2 공백 replay — consensus-train confirmed-only fire (#2329)', () => {
  it('T0 → cycle1(match=1, confirmed 전) fire 0 → cycle2(match=2, confirmed) 중곡 imminent 1회 발사', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '건대입구', {
      expiresAt: trip.expiresAt,
    });
    ssot.motionState = 'moving';
    ssot.lastAdvanceAt = T0;
    ssot.lastDeviceSyncAt = T0;
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    // cycle 1 — T0+80s. 후보 최초 관측(init). match=1(<CONFIRM_MIN_MATCH_COUNT=2) → confirmed 전.
    const now1 = T0 + HOP_MS;
    const fetchImpl1 = vi.fn(async () => new Response('', { status: 200 }));
    const stats1 = await runOnce(kv, makeConsensusSeoul(now1, 220), fetchImpl1, now1);
    expect(stats1.arvlCdFireFired).toBe(0);
    expect(fetchImpl1).not.toHaveBeenCalled(); // confirmed 전 — 기존 fire path(APNs 전송) 미도달.

    const afterCycle1 = await ((await import('../tripPositionSsot')).readSsot(
      kv as unknown as KVNamespace,
      trip.token,
    ));
    expect(afterCycle1?.legConsensus?.status).toBe('tracking');

    // cycle 2 — T0+160s. 같은 실차가 80s만큼 더 카운트다운(ETA 220→140, 절대 도착시각 동일)
    // → deltaSec≈0 → match=2 → confirmed. confirmed 후에만 advance+fire 1회.
    const now2 = T0 + 2 * HOP_MS;
    const fetchImpl2 = vi.fn(async () => new Response('', { status: 200 }));
    const stats2 = await runOnce(kv, makeConsensusSeoul(now2, 140), fetchImpl2, now2);

    expect(stats2.arvlCdFireFired).toBe(1);
    expect(stats2.arvlCdFireSuccess).toBe(1);
    expect(fetchImpl2).toHaveBeenCalled(); // 기존 arvlCd alert push 경로(신규 emitter 없음) 재사용.

    const afterCycle2 = await ((await import('../tripPositionSsot')).readSsot(
      kv as unknown as KVNamespace,
      trip.token,
    ));
    expect(afterCycle2?.legConsensus?.status).toBe('confirmed');
    expect(afterCycle2?.legConsensus?.confirmedTrainCode).toBe('8801');
    expect(afterCycle2?.lockSuggestion?.confidence).toBe('consensus');
    // lock 승격 금지 — trip.boardingLock은 여전히 미부착.
    const storedTrip = JSON.parse((await kv.get(`trip:${trip.token}`)) ?? 'null') as Trip | null;
    expect(storedTrip?.boardingLock).toBeUndefined();
  });

  it('무회귀 — infoModeEnabled=true(C 토글 ON) trip은 기존 runLocklessIntermediate 경로 그대로(consensus 미개입)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({ infoModeEnabled: true });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '건대입구', {
      expiresAt: trip.expiresAt,
    });
    ssot.motionState = 'moving';
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const now1 = T0 + HOP_MS;
    const fetchImpl1 = vi.fn(async () => new Response('', { status: 200 }));
    await runOnce(kv, makeConsensusSeoul(now1, 220), fetchImpl1, now1);

    const after = await ((await import('../tripPositionSsot')).readSsot(
      kv as unknown as KVNamespace,
      trip.token,
    ));
    // consensus 경로가 개입하지 않았으므로 legConsensus는 여전히 미설정.
    expect(after?.legConsensus).toBeUndefined();
  });
});
