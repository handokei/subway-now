/**
 * #2895 -> #3057 — 시나리오 S3: 프롬프트 미응답 상태에서의 반복 발사 정책.
 *
 * #3057(2026-10-19 사용자 결정)로 approaching(arvlCd 3/5) 발사가 은퇴해 구 스펙 ①("approaching
 * 1회 + arrival 재확인 1회 = 2회")은 성립하지 않는다. 열차 1대당 도착 확정 1회로 수렴하고
 * (`MAX_FIRES_PER_TRAIN_CODE` 2->1), 새 열차가 도착 확정되면 #2898 ④로 5분 게이트를 bypass한다.
 *   1. 도착 전 신호(arvlCd 0/3/5)는 발사하지 않고, 도착 확정(arvlCd 1)에서 1회 발사한다.
 *   2. 사용자가 이미 응답했다면(boardingLock 활성) 재발사하지 않는다 — 스팸 금지.
 *   3. 같은 열차는 몇 번 관측돼도(5분 경과 후에도) 1회를 초과해 발사하지 않는다.
 *   4. 열차가 바뀌면(다음 열차) 도착 확정 시 5분 이내여도 발사된다(단배차 miss 방지).
 *
 * 실제 cron 진입점(`runScheduled`)을 통해 재생한다 — 스펙 ②의 "이미 응답" 가드
 * (`isBoardingLockActive`, scheduled.ts:1640)는 `maybeFireLegBoardingPrompt` 내부가 아니라
 * 그 caller(`runScheduled`)에만 존재하므로, 함수를 직접 호출하면 그 가드를 우회해 거짓
 * green을 만든다 — `runScheduled` 전체를 거쳐야 실제 배선을 검증한다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runScheduled, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import type { ArrivalEntry, SeoulArrivalClient } from '../seoul';
import { getTrip, putTrip } from '../trips';
import type { BoardingLockMeta, Env, Trip } from '../types';
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

// `trips.ts`의 putTrip은 KV expirationTtl을 `trip.expiresAt - Date.now()`(실 벽시계)로 계산한다
// (시뮬레이션 `now` 무관) — 과거 고정 epoch을 쓰면 KV TTL이 실제보다 훨씬 짧게 계산돼 재생
// 중간에 trip이 조용히 삭제된다. 실제 `Date.now()`에 앵커링해 그 함정을 피한다.
const NOW = Date.now();

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

function makeBoardingLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: 'U1',
    line: '2',
    subwayId: '1002',
    selectedDepartureTime: NOW - 5 * 60_000,
    segmentStations: ['건대입구', '성수', '뚝섬'],
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'trip-s3-' + Math.random().toString(36).slice(2),
    route: { type: 'transfer', firstLine: '7', secondLine: '2', transfers: [{ station: '건대입구' }] },
    waypoints: [
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '뚝섬', line: '2', kind: 'destination' },
    ],
    apnsEnv: 'production',
    registeredAt: NOW - 20 * 60_000,
    createdAt: NOW - 20 * 60_000,
    expiresAt: NOW + 60 * 60_000,
    // #2794 폴링윈도우 게이트 — 즉시 평가 대상이 되도록 윈도우 안에 둔다(evidence_20260812
    // replay test와 동일 패턴).
    alarmAtEpochMs: NOW - 60_000,
    currentLegAnchor: { boardingStation: '건대입구', line: '2' },
    promptOptIn: true,
    ...overrides,
  } as unknown as Trip;
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

async function tick(
  kv: InMemoryKV,
  seoul: SeoulArrivalClient,
  fetchImpl: ReturnType<typeof vi.fn>,
  now: number,
  log?: ReturnType<typeof vi.fn>,
): Promise<ScheduledStats> {
  return runScheduled(makeEnv(kv), {
    seoul,
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => now,
    generatePushId: () => `s3-push-${now}`,
    log: log as unknown as ScheduledDeps['log'],
  } satisfies ScheduledDeps);
}

/** leg-boarding-prompt 관련 'gate blocked' 로그에서 reason만 추출(가장 최근 호출). */
function lastLegBoardingGateBlockedReason(log: ReturnType<typeof vi.fn>): string | undefined {
  const blocked = log.mock.calls
    .filter(([message]) => message === 'leg-boarding-prompt: gate blocked')
    .at(-1) as [string, { reason?: string }] | undefined;
  return blocked?.[1]?.reason;
}

describe('#2895 — S3: 미응답 상태에서 실제 도착 시 재확인 프롬프트', () => {
  it('① 도착 전 신호(arvlCd=5)는 발사하지 않고, 같은 열차가 도착 확정(arvlCd=1)되면 그때 1회 발사한다', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 5), arrival('U2', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const log = vi.fn();

    const stats1 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now, log);
    expect(stats1.legBoardingPromptFired).toBe(0); // 도착 확정 아님 — 조기 발사 금지
    expect(lastLegBoardingGateBlockedReason(log)).toBe('suppressed-not-imminent');

    now += 90_000;
    pool = [arrival('U1', false, 1), arrival('U2', false, 99)];
    const stats2 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now, log);
    expect(stats2.legBoardingPromptFired).toBe(1);
    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(1);
  });

  it('② 사용자가 이미 응답(boardingLock 활성)했으면 실제 도착해도 재발사하지 않는다 — 스팸 금지', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    // boardingLock이 있으면 F2 defense(isBoardingLockActive, scheduled.ts:1640)가 leg-boarding
    // prompt 평가 블록 자체를 건너뛴다 — 응답한 사용자에게 재확인을 보내지 않는다.
    const trip = makeTrip({ boardingLock: makeBoardingLock() });
    await putTrip(kv as unknown as KVNamespace, trip);

    const pool: readonly ArrivalEntry[] = [arrival('U1', false, 1), arrival('U2', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const stats = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats.legBoardingPromptFired).toBe(0);
  });

  it('③ 같은 열차는 도착 확정이 반복 관측돼도 1회를 초과해 발사하지 않는다', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 1), arrival('U2', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now); // 도착 1회차

    now += 90_000;
    pool = [arrival('U1', false, 2), arrival('U2', false, 99)]; // 같은 열차 출발 관측
    const stats2 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats2.legBoardingPromptFired).toBe(0);

    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(1);
  });

  it('④ 열차가 바뀌면(다음 열차 U3) 5분 이내여도 도착 확정 시 발사된다 — 단배차 miss 방지(#2898 ④ 재개통)', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 1), arrival('U2', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now); // U1 도착 — 소진

    now += 90_000;
    pool = [arrival('U3', false, 1), arrival('U2', false, 99)];
    const stats2 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats2.legBoardingPromptFired).toBe(1);
    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(2);
  });

  // #2898 거부 케이스 — 5분 게이트/상한은 제거가 아니라 (trainCode, phase) 축으로 세분화됐을 뿐이다.

  it('ⓐ 도착 확정 발사 후 사용자가 응답(boardingLock 부착)하면 실제 도착해도 재확인 재발사하지 않는다', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 1), arrival('U2', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const stats1 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats1.legBoardingPromptFired).toBe(1); // 도착 확정 1회차 발사(미응답)

    // 사용자가 이 시점에 응답 — boardingLock이 부착된다(실제 응답 채널과 동일 효과만 시뮬레이션).
    const respondedTrip = await getTrip(kv as unknown as KVNamespace, trip.token);
    if (!respondedTrip) throw new Error('trip missing');
    respondedTrip.boardingLock = makeBoardingLock();
    await putTrip(kv as unknown as KVNamespace, respondedTrip);

    // 90초 후 같은 열차가 실제 도착(arvlCd=1) — 응답했으므로 재확인을 다시 묻지 않아야 한다.
    now += 90_000;
    pool = [arrival('U1', false, 2), arrival('U2', false, 99)];
    const stats2 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats2.legBoardingPromptFired).toBe(0);
  });

  it('ⓑ 5분 경과 후에도 같은 열차 2번째 발사는 금지된다 — 하드 캡은 interval 게이트와 독립', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 1), arrival('U2', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now); // U1 도착(1회, 소진)

    // 5분(MIN_FIRE_INTERVAL_MS) 넘게 경과 — interval 소프트 블록은 더 이상 걸리지 않는 시점이어도
    // 같은 trainCode(U1)는 하드 캡(MAX_FIRES_PER_TRAIN_CODE=1)으로 막혀야 한다.
    now += 6 * 60_000;
    pool = [arrival('U1', false, 2), arrival('U2', false, 99)];
    const stats2 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);

    expect(stats2.legBoardingPromptFired).toBe(0);
    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(1);
  });

  it('ⓒ 도착 확정이 아닌 다른 열차 신호(U5 arvlCd=3)는 직전 열차 소진 후에도 발사하지 않는다', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 1), arrival('U9', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const stats1 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats1.legBoardingPromptFired).toBe(1); // U1 도착(소진)

    now += 90_000;
    pool = [arrival('U5', false, 3), arrival('U9', false, 99)];
    const stats2 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);

    expect(stats2.legBoardingPromptFired).toBe(0);
    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(1);
  });

  it('ⓓ selectedTrainCode=null(ambiguity) 상태에서도 도착 확정 1회는 발사하고 같은 상태 반복은 금지 — #2880 fallback과 충돌 없음', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    // 같은 arvlCd tier에 동일 방향 후보가 2개면 pickAutoTrainCode가 ambiguity로 null을 반환한다.
    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 1), arrival('U2', false, 1)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const stats1 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats1.legBoardingPromptFired).toBe(1); // null-trainCode fallback 1회차

    now += 90_000;
    pool = [arrival('U1', false, 1), arrival('U2', false, 1)];
    const stats2 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats2.legBoardingPromptFired).toBe(0); // null-trainCode 토큰도 상한 1

    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(1);
  });
});
