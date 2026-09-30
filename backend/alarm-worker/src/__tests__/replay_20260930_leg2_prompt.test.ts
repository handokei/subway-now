/**
 * #2801 (replay) — 9/30 실측 트립(D1 `e25e1158`, 용마산7 → 건대입구 환승 → 2호선 → 뚝섬)에서
 * leg-2 "탑승하셨나요?" 프롬프트가 조기·반복 발사되던 회귀를 `maybeFireLegBoardingPrompt`
 * whole-cycle replay로 고정한다. #2834(`0e015b95`)가 dev에 이미 머지돼 있어 이 파일은 dev
 * 기준으로 **green**이어야 정상이다 — RED 증거는 PR 본문에 별도 첨부(#2834 fix 커밋 revert 후
 * 로컬 재현).
 *
 * 실측 D1 타임라인 (트립 e25e1158, 불변 — 통과시키려 조정 금지):
 *   06:34:09 lock 7039(7호선) @용마산 (boarding-prompt-response)
 *   06:35:25~06:40:45 leg-1 매역 발사(중곡/군자/어린이대공원/건대입구 transfer imminent) — 전부 sent
 *   06:41:08 transfer-advance(lock-active) → leg-2 anchor 건대입구/2호선
 *   06:42:11 leg-boarding-prompt fired ← **회귀 본체**: 열차가 아직 도착 전인데 조기 발사
 *   06:43:08 silenced
 *   06:44:10 fired(5분 게이트 우회) ← 회귀 재발
 *   06:45:15 / 06:46:08 / 06:47:10 silenced
 *   06:46:08 leg-resolve 3056 trainSttus=1(도착) streak1
 *   06:47:10 leg-resolve 3056 trainSttus=1 streak2
 *   06:48:10 leg-resolve 3056 trainSttus=2(출발) confirmed
 *   06:53:07 뚝섬 dst skip(ssot-not-at-or-approaching) / 06:53:37 뚝섬 dst imminent sent
 *
 * 정직한 재구성 표기: 06:42/06:44 발사 시점의 실 arrivals arvlCd는 D1에 로깅되지 않았다(레코드에
 * outcome/timestamp만 있고 candidateArvlCds 계측은 이 버그를 고친 #2801 커밋에서야 추가됨).
 * leg-resolve가 3056을 06:46에야 도착(sttus=1)으로 관측했으므로, 06:42/06:44 pool은 "임박 아닌
 * 열차만"(arvlCd 3=전역출발/99=운행중, 둘 다 observed) — **재구성**이다. 나머지 타임라인(lock
 * 시각, leg-2 anchor 전이, leg-resolve 확정, 발사/억제 순서)은 D1 실측.
 *
 * 스코프: leg-1 매역 4발사(중곡~건대)는 다른 함수(`maybeFireStationEvents` 계열)가 담당하고 이미
 * 별도 replay(`replay_20260912_line7_arvlcd_sampling.test.ts` 등)로 커버돼 있다 — 이 셋업까지
 * 얹으면 replay가 leg-2 프롬프트 게이트 검증이라는 단일 관심사를 벗어나 과도하게 비대해지므로,
 * 본 파일은 leg-2 boarding-prompt 게이트(`decideBoardingPromptFire`) 단일 관심사로 스코프를
 * 제한한다.
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

// D1 lock ts(06:34:09)를 epoch 0으로 두고, 이후 오프셋은 실측 분:초 그대로 반영한다.
const LOCK_AT = 1_700_000_000_000;
const offsetFromLock = (mm: number, ss: number): number => LOCK_AT + (mm * 60 + ss) * 1000;

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
    token: 'trip-e25e1158-leg2',
    createdAt: offsetFromLock(0, 0) - 20 * 60_000,
    // leg-2 실측 경로: 건대입구(2호선) → 성수(intermediate) → 뚝섬(destination).
    waypoints: [
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '뚝섬', line: '2', kind: 'destination' },
    ],
    apnsEnv: 'production',
    registeredAt: offsetFromLock(0, 0),
    // 06:41:08 transfer-advance가 남긴 leg-2 anchor.
    currentLegAnchor: { boardingStation: '건대입구', line: '2' },
    promptOptIn: true,
  } as unknown as Trip;
}

/** 후보 pool을 매 cycle 갈아끼우는 controllable Seoul mock — 건대입구 조회만 응답한다. */
function makeControllableSeoul(getPool: () => readonly ArrivalEntry[]): SeoulArrivalClient {
  return {
    stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
    async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
      if (stationName !== '건대입구') return [];
      return [...getPool()];
    },
    async fetchPositions(): Promise<never[]> {
      return [];
    },
  } as unknown as SeoulArrivalClient;
}

function arrival(trainCode: string, isUp: boolean, arvlCd: number | null): ArrivalEntry {
  return {
    destination: '뚝섬',
    arrivalSeconds: 90,
    trainCode,
    isUp,
    subwayNm: '지하철2호선',
    subwayId: '1002',
    arvlCd,
  } as unknown as ArrivalEntry;
}

describe('#2801 replay — 9/30 e25e1158 leg-2 boarding-prompt 조기·반복 발사 회귀', () => {
  it('#2834 게이트가 조기 발사(06:42/06:44 상당)를 억제하고, 열차 도착(06:46 상당)에만 발사하며, 지하 미관측(회귀 안전)에도 fallback 발사한다', async () => {
    // #2838 — fire-once KV key(TTL 5분)는 실 벽시계가 아니라 이 replay의 시뮬레이션 시계로
    // 만료를 판정해야 한다(그렇지 않으면 cycle C의 fire-once stamp가 cycle D까지 실 벽시계
    // 기준으로는 만료되지 않아, 실측상 6분 지난 cycle D가 인위적으로 차단된다).
    let simNow = offsetFromLock(0, 0);
    const kv = new InMemoryKV(() => simNow);
    const env = makeEnv(kv);
    const trip = makeTrip();
    const stats = makeStats();

    // 회귀 재구성 pool: 06:42/06:44 — 3056(전역출발=99)/3058(운행중=3), 전부 observed, 임박 0건.
    let pool: readonly ArrivalEntry[] = [arrival('3056', true, 99), arrival('3058', true, 3)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const deps: ScheduledDeps = { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: pushFetch, seoul, archFlag: 'off' };

    // ── cycle A (06:42:11 상당) — 실측에선 fired였던 조기 발사. fix 후엔 억제돼야 한다.
    simNow = offsetFromLock(8, 11);
    await maybeFireLegBoardingPrompt(trip, env, deps, stats, simNow, () => {}, () => 'p-a');
    expect(stats.legBoardingPromptFired).toBe(0);
    expect(stats.legBoardingPromptBlocked).toBe(1);
    expect(trip.legBoardingPromptState?.fired).toBeFalsy();
    expect((pushFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // ── cycle B (06:44:10 상당) — 동일 pool, 여전히 억제(구 코드는 5분 우회로 재발사).
    simNow = offsetFromLock(10, 10);
    await maybeFireLegBoardingPrompt(trip, env, deps, stats, simNow, () => {}, () => 'p-b');
    expect(stats.legBoardingPromptFired).toBe(0);
    expect(stats.legBoardingPromptBlocked).toBe(2);
    expect((pushFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // ── cycle C (06:46:08 상당) — leg-resolve가 관측한 3056 도착(arvlCd=1)이 pool에 등장.
    // 사용자가 실제 열차 도착 시점에 "탑승하셨나요?"를 받는다(사용자-가시 결과).
    pool = [arrival('3056', true, 1), arrival('3058', true, 3)];
    simNow = offsetFromLock(12, 8);
    await maybeFireLegBoardingPrompt(trip, env, deps, stats, simNow, () => {}, () => 'p-c');
    expect(stats.legBoardingPromptFired).toBe(1);
    expect(stats.legBoardingPromptBlocked).toBe(2);
    expect(trip.legBoardingPromptState?.fired).toBe(true);
    expect((pushFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // ── cycle D (회귀 안전, 지하 진입 시뮬) — 새 열차(3060) 전부 arvlCd=null(미관측)만 pool에
    // 있어도 fallback-unobservable로 발사돼야 한다(equal-protection, #2801 §2 조항 2 — 지하 miss
    // 재발 방지). MIN_FIRE_INTERVAL_MS(5분) 경과 + 새 trainCode로 dedup 통과시킨다.
    pool = [arrival('3060', true, null)];
    simNow = offsetFromLock(18, 8);
    await maybeFireLegBoardingPrompt(trip, env, deps, stats, simNow, () => {}, () => 'p-d');
    expect(stats.legBoardingPromptFired).toBe(2);
    expect(stats.legBoardingPromptBlocked).toBe(2);
    expect((pushFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('#2838 — cron stale-read(trip.legBoardingPromptState 소실)로 5분 repeat gate가 우회돼도 fire-once key가 재발사를 억제한다 (06:42→06:44 모사)', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const stats = makeStats();
    const log = vi.fn();

    // 도착 임박(arvlCd=1) — repeat gate/fire-once 둘 다 통과해야 발사되는 pool로 고정.
    const pool: readonly ArrivalEntry[] = [arrival('3056', true, 1)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const deps: ScheduledDeps = { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: pushFetch, seoul, archFlag: 'off' };

    // ── cycle A (06:42:11 상당) — 정상 첫 발사. trip.legBoardingPromptState가 stamp된다.
    const tripCycleA = makeTrip();
    await maybeFireLegBoardingPrompt(tripCycleA, env, deps, stats, offsetFromLock(8, 11), log, () => 'p-a');
    expect(stats.legBoardingPromptFired).toBe(1);
    expect(tripCycleA.legBoardingPromptState?.lastFiredAt).toBe(offsetFromLock(8, 11));
    expect((pushFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // ── cycle B (06:44:10 상당, 5분 미경과) — cron이 listTrips stale-read로 직전 cycle의
    // putTrip을 못 보고, `legBoardingPromptState`가 비어있는 **새 trip 객체**를 돌려준
    // 상황을 모사한다(같은 token, 같은 anchor). 구 코드는 promptState가 undefined라
    // `evaluateBoardingPromptRepeatGate`가 즉시 통과 → 5분 게이트 우회 재발사(회귀 재현).
    // fire-once key(#2838)는 trip 객체와 무관한 독립 KV/인메모리 상태이므로 이 stale-read와
    // 무관하게 억제해야 한다.
    const tripCycleB = makeTrip();
    expect(tripCycleB.legBoardingPromptState).toBeUndefined();
    await maybeFireLegBoardingPrompt(tripCycleB, env, deps, stats, offsetFromLock(10, 10), log, () => 'p-b');

    // fired 1회만 유지 — 우회 재발사가 없어야 한다.
    expect(stats.legBoardingPromptFired).toBe(1);
    expect((pushFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // reason='fire-once-key'로 억제 사유가 관측 가능해야 한다(D1 reason 로그 / wrangler tail).
    expect(
      log.mock.calls.some(
        ([, meta]) => (meta as { reason?: string } | undefined)?.reason === 'fire-once-key',
      ),
    ).toBe(true);
  });
});
