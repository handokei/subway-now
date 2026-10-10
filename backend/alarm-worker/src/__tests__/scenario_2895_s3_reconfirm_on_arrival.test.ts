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

  // #2898 거부 케이스 — fix가 5분 게이트를 "제거"가 아니라 (trainCode, phase) 축으로
  // "세분화"했을 뿐임을 증명한다. 아래 4개는 전부 fix 후에도 GREEN이어야 한다.

  it('ⓐ approaching 발사 후 사용자가 응답(boardingLock 부착)하면 실제 도착해도 재확인 재발사하지 않는다', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 5), arrival('U2', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const stats1 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats1.legBoardingPromptFired).toBe(1); // approaching 1회차 발사(미응답)

    // 사용자가 이 시점에 응답 — boardingLock이 부착된다(실제 응답 채널과 동일 효과만 시뮬레이션).
    const respondedTrip = await getTrip(kv as unknown as KVNamespace, trip.token);
    if (!respondedTrip) throw new Error('trip missing');
    respondedTrip.boardingLock = makeBoardingLock();
    await putTrip(kv as unknown as KVNamespace, respondedTrip);

    // 90초 후 같은 열차가 실제 도착(arvlCd=1) — 응답했으므로 재확인을 다시 묻지 않아야 한다.
    now += 90_000;
    pool = [arrival('U1', false, 1), arrival('U2', false, 99)];
    const stats2 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats2.legBoardingPromptFired).toBe(0);
  });

  it('ⓑ 5분 경과 후에도 같은 열차 3번째 발사는 금지된다 — 하드 캡은 interval 게이트와 독립', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 5), arrival('U2', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now); // U1 approaching(1회)

    now += 90_000;
    pool = [arrival('U1', false, 1), arrival('U2', false, 99)];
    await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now); // U1 arrival(2회, 소진)

    // 5분(MIN_FIRE_INTERVAL_MS) 넘게 경과 — interval 소프트 블록 자체는 더 이상 걸리지 않는
    // 시점이어도, 같은 trainCode(U1)의 3번째 발사는 하드 캡(MAX_FIRES_PER_TRAIN_CODE=2)으로
    // 여전히 막혀야 한다. 새로운 phase(여기선 다시 'imminent' 범주의 다른 arvlCd)로 관측돼도
    // 동일 trainCode인 이상 발사하지 않는다.
    now += 6 * 60_000;
    pool = [arrival('U1', false, 0), arrival('U2', false, 99)];
    const stats3 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);

    expect(stats3.legBoardingPromptFired).toBe(0);
    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(2);
  });

  it('ⓒ 다른 열차 스팸(단배차)은 여전히 5분 게이트로 차단된다 — 직전 열차가 소진 전이면 bypass 없음', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 5), arrival('U9', false, 99)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const stats1 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats1.legBoardingPromptFired).toBe(1); // U1 approaching(1회, 아직 소진 아님)

    // 90초 후 U1은 그대로지만(아직 2회차 전) 완전히 다른 열차 U5가 approaching으로 새로 포착된다
    // (단배차 역에서 흔한 패턴) — U1이 소진되지 않았으므로 U5로의 전환은 bypass 대상이 아니다.
    // U5만 arvlCd=3(전역출발, 단일 후보)이라 pickAutoTrainCode가 명확히 'U5'를 선택한다(U1은
    // 그대로 arvlCd=5라 code=3 tier에서 걸리지 않음 — ambiguity 없이 cross-train 케이스만 검증).
    now += 90_000;
    pool = [arrival('U1', false, 5), arrival('U5', false, 3)];
    const stats2 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);

    expect(stats2.legBoardingPromptFired).toBe(0);
    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(1); // U1 1회뿐, U5는 차단
  });

  it('ⓓ selectedTrainCode=null(ambiguity) 상태에서도 재확인 1회는 허용하되 3번째는 금지 — #2880 fallback과 충돌 없음', async () => {
    const kv = new InMemoryKV(() => now);
    let now = NOW;
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    // 같은 arvlCd tier에 동일 방향 후보가 2개 이상이면 pickAutoTrainCode가 ambiguity로 null을
    // 반환한다(boardingPrompt.ts) — decision 자체는 영향받지 않는다(decideBoardingPromptFire는
    // pool arvlCd만 본다).
    let pool: readonly ArrivalEntry[] = [arrival('U1', false, 5), arrival('U2', false, 5)];
    const seoul = makeControllableSeoul(() => pool);
    const pushFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;

    const stats1 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats1.legBoardingPromptFired).toBe(1); // null-trainCode fallback 1회차(approaching)

    // 90초 후 같은 ambiguity(여전히 null)로 실제 도착(arvlCd=1) 관측 — null-trainCode 토큰
    // 기준으로도 같은 bypass 로직(스펙 ①과 동형)이 적용돼 재확인 1회가 더 발사돼야 한다.
    now += 90_000;
    pool = [arrival('U1', false, 1), arrival('U2', false, 1)];
    const stats2 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats2.legBoardingPromptFired).toBe(1);

    // 추가 30초 후 동일 phase('imminent')로 또 관측돼도 — null-trainCode 토큰 역시 2회 상한 +
    // 동일 dedupKey 중복 방지 둘 다로 3번째 발사는 막힌다.
    now += 30_000;
    pool = [arrival('U1', false, 0), arrival('U2', false, 0)];
    const stats3 = await tick(kv, seoul, pushFetch as unknown as ReturnType<typeof vi.fn>, now);
    expect(stats3.legBoardingPromptFired).toBe(0);

    const persisted = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(persisted?.legBoardingPromptState?.fireCount ?? 0).toBe(2);
  });
});
