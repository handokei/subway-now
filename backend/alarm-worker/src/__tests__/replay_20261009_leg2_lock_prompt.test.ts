/**
 * #2939 (plan 2026-10-10 W1, P1/A1) — 10/9 실측 트립(D1 `trip_events`, 군자역 환승) replay.
 *
 * 실측 타임라인 (불변 — 통과시키려 조정 금지):
 *   11:37:24 leg-boarding-prompt 군자(능동) line=5 outcome=fired (gateDecision=approaching)
 *   11:37:39 · 11:37:43 boarding-confirm-result lockState=leg1 (사용자 응답 2회)
 *   11:37:51 sync-received 군자(능동) promotedLock=true trainCode=5559 (lock 부착 완료)
 *   11:38:24 leg-boarding-prompt 군자(능동) line=5 outcome=fired ← **회귀 본체**: 열차를 이미
 *     아는 상태에서 "탑승하셨나요?"를 또 물었다.
 *
 * 근본: `maybeFireLegBoardingPrompt`(scheduled.ts)는 lock 활성 여부와 무관하게 환승 leg마다
 * 평가된다 — "이 leg의 lock이 실 trainCode를 가지면 차단"하는 게이트가 없었다. #2898의 5분
 * soft-block(같은 열차 approaching→imminent 재확인 허용)이 11:38:24 재발사를 정상 통과시켰다
 * (현재 설계상 정상 동작 — 문제는 lock 존재를 보는 축 자체의 부재).
 *
 * fix 후 기대: 11:37:51 lock 부착 이후 같은 leg(line=5, 군자)의 `leg-boarding-prompt` 평가는
 * 11:38:24 상당 cycle에서 발사 0건이어야 한다(plan §3 AC1).
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { maybeFireLegBoardingPrompt, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import type { ArrivalEntry, SeoulArrivalClient } from '../seoul';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: await exportPKCS8(privateKey),
    bundleId: 'com.example.app',
  };
});

beforeEach(() => resetApnsJwtCache());

// D1 11:37:24 발사를 epoch 0으로 두고, 이후 오프셋은 실측 시:분:초 차이 그대로.
const BASE_AT = 1_700_000_000_000;
const offsetFromBase = (totalSec: number): number => BASE_AT + totalSec * 1000;

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
  } as unknown as Env;
}

function makeStats(): ScheduledStats {
  return {
    legBoardingPromptFired: 0,
    legBoardingPromptBlocked: 0,
    legBoardingPromptSkippedWalking: 0,
    legBoardingPromptSkippedNoOptIn: 0,
    silentPushFiredByKind: { boardingPrompt: 0 },
    envCorrected: 0,
    errors: 0,
  } as unknown as ScheduledStats;
}

function makeTrip(): Trip {
  return {
    token: 'trip-20261009-b00dd879',
    createdAt: offsetFromBase(0) - 20 * 60_000,
    // 환승 후 leg: 군자(5호선) → 광화문 방면.
    waypoints: [
      { stationName: '동대문역사문화공원', line: '5', kind: 'intermediate' },
      { stationName: '광화문', line: '5', kind: 'destination' },
    ],
    apnsEnv: 'production',
    registeredAt: offsetFromBase(0),
    currentLegAnchor: { boardingStation: '군자', line: '5' },
    promptOptIn: true,
  } as unknown as Trip;
}

function makeControllableSeoul(getPool: () => readonly ArrivalEntry[]): SeoulArrivalClient {
  return {
    stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
    async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
      if (stationName !== '군자') return [];
      return [...getPool()];
    },
    async fetchPositions(): Promise<never[]> {
      return [];
    },
  } as unknown as SeoulArrivalClient;
}

function arrival(trainCode: string, isUp: boolean, arvlCd: number | null): ArrivalEntry {
  return {
    destination: '광화문',
    arrivalSeconds: 90,
    trainCode,
    isUp,
    subwayNm: '지하철5호선',
    subwayId: '1005',
    arvlCd,
  } as unknown as ArrivalEntry;
}

describe('#2939 replay — 10/9 b00dd879 군자 leg-2 lock 부착 후 재발사 회귀', () => {
  it('11:37:24 fired(approaching) → 11:37:51 lock 5559 부착 → 11:38:24 상당 재평가는 발사 0건', async () => {
    let simNow = offsetFromBase(0);
    const kv = new InMemoryKV(() => simNow);
    const env = makeEnv(kv);
    const trip = makeTrip();
    const stats = makeStats();

    // ── 11:37:24 — 최초 발사(approaching). 실측과 동일하게 fired 1건.
    let pool: readonly ArrivalEntry[] = [arrival('5559', true, 5)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const deps: ScheduledDeps = { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: pushFetch, seoul, archFlag: 'off' };

    await maybeFireLegBoardingPrompt(trip, env, deps, stats, simNow, () => {}, () => 'p-1137-24');
    expect(stats.legBoardingPromptFired).toBe(1);

    // ── 11:37:51 — 사용자 응답 처리(11:37:39/43)로 lock 부착(device sync-received promotedLock,
    // trainCode=5559, 현재 leg와 동일 line=5). 이 fix의 게이트가 보는 신호 그 자체.
    trip.boardingLock = {
      trainCode: '5559',
      line: '5',
      subwayId: '1005',
      selectedDepartureTime: offsetFromBase(27),
      segmentStations: ['군자', '동대문역사문화공원', '광화문'],
      expiresAt: offsetFromBase(27) + 30 * 60_000,
    };

    // ── 11:38:24 상당(+60s) — 열차를 이미 아는 상태에서 재평가. fix 전엔 #2898 soft-block
    // same-train bypass로 또 발사됐다(회귀 본체). fix 후엔 lock-already-attached로 차단돼야 한다.
    simNow = offsetFromBase(60);
    pool = [arrival('5559', true, 1)];
    await maybeFireLegBoardingPrompt(trip, env, deps, stats, simNow, () => {}, () => 'p-1138-24');

    expect(stats.legBoardingPromptFired).toBe(1);
    expect((pushFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
