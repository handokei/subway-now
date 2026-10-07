/**
 * #2895 — 시나리오 S3: 프롬프트 미응답 상태에서 열차가 실제 도착하면 확인을 한 번 더 물어야
 * 한다. TEST-ONLY (프로덕션 수정 금지) — 판정이 먼저다.
 *
 * 사용자 가치(이슈 본문): "탑승 전에 '탑승했나요?'가 오고, 정작 실제로 타는 순간엔 아무것도
 * 안 온다"가 현재 체감. 올바른 동작:
 *   1. approaching 시점(arvlCd 3/5)에 뜬 프롬프트에 사용자가 응답하지 않은 채 그 열차가 실제
 *      도착(arvlCd 0/1)하면 확인 프롬프트가 1회 더 발사된다.
 *   2. 사용자가 이미 응답했다면(boardingLock 활성) 재발사하지 않는다 — 스팸 금지.
 *   3. 같은 열차에 대해 2회(approaching 1 + arrival 1)를 초과해 발사하지 않는다.
 *   4. 열차가 바뀌면(다음 열차) 상한은 새로 적용된다.
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
  it('① approaching(arvlCd=5) 미응답 → 90초 후 실제 도착(arvlCd=1) 같은 trainCode면 재확인 1회 더 발사(fired=2)', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 5), arrival('U2', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const log = vi.fn();

    const stats1 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now, log);
    expect(stats1.legBoardingPromptFired).toBe(1); // approaching 1회차 발사

    // 90초 후 같은 열차가 실제 도착(arvlCd=1) — 5분 repeat gate 안쪽, 아직 미응답(lock 없음).
    now += 90_000;
    pool = [arrival('U1', false, 1), arrival('U2', false, 99)];
    const stats2 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now, log);

    // 실측(2026-10-07 작성 시점) 차단 사유 — evaluateBoardingPromptRepeatGate
    // (boardingPrompt.ts:242-263)의 MIN_FIRE_INTERVAL_MS(5분) 전역 간격 게이트가 approaching/
    // arrival을 phase 구분 없이 동일하게 취급해 차단한다. 스펙 ①을 만족시키려는 fix는 이
    // 사유 자체를 없애야 한다 — 이 assert가 green이 되는 순간이 바로 그 전이다.
    expect(lastLegBoardingGateBlockedReason(log)).toBe('fired-too-recently');
    // 스펙 ①: 실제 도착 시 재확인이 이번 tick에서 한 번 더 발사돼야 한다(현재 RED).
    expect(stats2.legBoardingPromptFired).toBe(1);
    // 누적 ground truth(KV persisted state) — 2회 발사 확정(현재 RED).
    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(2);
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

  it('③ 같은 열차에 대해 2회(approaching 1 + arrival 1) 초과 발사하지 않는다 — 3번째 cycle도 같은 trainCode면 추가 발사 없음', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 5), arrival('U2', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now); // approaching 1회차

    now += 90_000;
    pool = [arrival('U1', false, 1), arrival('U2', false, 99)];
    await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now); // arrival 2회차

    // 동일 열차가 여전히 arvlCd=0(진입/승강장 체류)으로 한 번 더 관측돼도 — 2회 상한 초과 금지.
    now += 30_000;
    pool = [arrival('U1', false, 0), arrival('U2', false, 99)];
    const stats3 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);

    expect(stats3.legBoardingPromptFired).toBe(0); // 3번째 cycle은 상한 초과로 추가 발사 없음
    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(2); // 누적 2 그대로, 초과 없음
  });

  it('④ 열차가 바뀌면(다음 열차 U3) 2회 상한이 새로 적용된다 — U1 2회 소진 후에도 U3 approaching은 발사된다', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 5), arrival('U2', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now); // U1 approaching
    now += 90_000;
    pool = [arrival('U1', false, 1), arrival('U2', false, 99)];
    await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now); // U1 arrival — U1 2회 소진

    // U1이 떠나고(후보에서 사라짐) 다음 열차 U3가 approaching으로 새로 들어온다.
    now += 90_000;
    pool = [arrival('U3', false, 5), arrival('U2', false, 99)];
    const stats3 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);

    // 스펙 ④: 열차가 바뀌면 상한이 새로 적용돼 U3 approaching이 이번 tick에 발사돼야 한다.
    expect(stats3.legBoardingPromptFired).toBe(1);
    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    // 누적 ground truth — U1 2회 + U3 1회 = 3.
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(3);
  });
});
