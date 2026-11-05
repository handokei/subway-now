/**
 * 2026-08-12 저녁 25분 침묵 evidence의 leg2 공백 replay — #2766 (결정 D1, 게이트 전수감사 A).
 *
 * 이 파일은 원래(#2329, consensus-C) `tryFireConsensusTrainLeg`가 봉인 해제 시 2 cycle 연속
 * match로 'confirmed'에 도달해 중곡 imminent를 발사하는 것을 검증했다. 감사(tasks/audit-
 * 2026-09-20-gate-census.md §D1) 결과 그 fire 진입점은 이중 봉인(seedSsot lock 경로 2곳뿐이라
 * 도달 전 ssot===null 조기 return + lockAttachable:false 하드코딩)으로 프로덕션 출력이 0건이었다
 * (ADR-037 정합). 사용자 확정: "안내 시작조차 안 한 무의향 trip은 알림 0이 맞다" — 봉인 해제가
 * 아니라 fire 진입점 자체를 제거했다.
 *
 * 본 파일은 그 결정을 replay 형태로 고정한다:
 *  - 무의향(C 토글 OFF, infoModeEnabled=false) lockless trip의 intermediate leg는 실차가
 *    2 cycle 연속 확증되어도 advance/fire가 영구 0이고 legConsensus 상태기계 자체가 시작되지
 *    않는다(완전 침묵, 제거된 fire 진입점의 유일한 writer가 사라졌으므로).
 *  - 명시의향(C 토글 ON, infoModeEnabled=true) trip은 기존 `runLocklessIntermediate` 경로가
 *    무변화로 계속 동작한다 — 이 결정이 사용자 명시 의향 trip의 매역 push를 건드리지 않는다는
 *    회귀 방어(ADR-014 "사용자 명시 의향 trip = lock 활성과 동급" 동급 보장과 무관 — 이 leg는
 *    애초에 infoModeEnabled 게이트로 무변화).
 */

import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runScheduled, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { putTrip } from '../trips';
import { readSsot, seedSsot, writeSsot } from '../tripPositionSsot';
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
// #2329 설계 당시엔 이 신호가 legConsensus 'confirmed'로 수렴시켰다 — #2766 이후엔 fire
// 진입점 자체가 없어 이 신호를 관측하는 코드가 더 이상 존재하지 않는다.
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
              // #2355 — 실 Seoul API는 subwayNm=null, subwayId만 유효값으로 보낸다.
              subwayNm: null,
              subwayId: '1007',
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

describe('evidence 2026-08-12 leg2 공백 replay — #2766 결정 D1(무의향 lockless trip = 완전 침묵)', () => {
  it('무의향(infoModeEnabled=false) trip — 실차 2 cycle 연속 확증돼도 advance/fire/legConsensus 전부 영구 0 (완전 침묵)', async () => {
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

    // cycle 1 — T0+80s. #2329 설계였다면 후보 최초 관측(init, match=1)이었을 tick.
    const now1 = T0 + HOP_MS;
    const fetchImpl1 = vi.fn(async () => new Response('', { status: 200 }));
    const stats1 = await runOnce(kv, makeConsensusSeoul(now1, 220), fetchImpl1, now1);
    expect(stats1.arvlCdFireFired).toBe(0);
    expect(fetchImpl1).not.toHaveBeenCalled();

    const afterCycle1 = await readSsot(kv as unknown as KVNamespace, trip.token);
    // #2329 설계였다면 'tracking'이었을 상태 — fire 진입점 제거로 legConsensus 상태기계
    // 자체가 시작되지 않는다(유일 writer였던 tryFireConsensusTrainLeg가 없음).
    expect(afterCycle1?.legConsensus).toBeUndefined();

    // cycle 2 — T0+160s. #2329 설계였다면 같은 실차가 80s만큼 더 카운트다운해
    // match=2(CONFIRM_MIN_MATCH_COUNT)로 'confirmed'에 도달, 중곡 imminent 1회를 발사했을 tick.
    const now2 = T0 + 2 * HOP_MS;
    const fetchImpl2 = vi.fn(async () => new Response('', { status: 200 }));
    const stats2 = await runOnce(kv, makeConsensusSeoul(now2, 140), fetchImpl2, now2);

    expect(stats2.arvlCdFireFired).toBe(0);
    expect(stats2.arvlCdFireSuccess).toBe(0);
    expect(fetchImpl2).not.toHaveBeenCalled(); // 완전 침묵 — 알림 0건.

    const afterCycle2 = await readSsot(kv as unknown as KVNamespace, trip.token);
    expect(afterCycle2?.legConsensus).toBeUndefined();
    expect(afterCycle2?.lockSuggestion).toBeUndefined();
    // lock도 당연히 미부착.
    const storedTrip = JSON.parse((await kv.get(`trip:${trip.token}`)) ?? 'null') as Trip | null;
    expect(storedTrip?.boardingLock).toBeUndefined();
  });

  it('무회귀 — infoModeEnabled=true(C 토글 ON) trip의 runLocklessIntermediate 매역 push 경로는 무변화(legConsensus 미개입)', async () => {
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

    const after = await readSsot(kv as unknown as KVNamespace, trip.token);
    // consensus 경로 자체가 제거됐으므로(#2766) legConsensus는 여전히 미설정 — 이 trip의
    // 매역 push 판정은 오직 runLocklessIntermediate(motion/arvlCd ground truth)에 달려있다.
    expect(after?.legConsensus).toBeUndefined();
  });
});
