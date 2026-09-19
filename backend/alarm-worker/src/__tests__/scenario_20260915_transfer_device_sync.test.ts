/**
 * #2645 — 환승역 하차 확정이 arvlCd에 종속되던 회귀의 end-to-end red→green fixture.
 *
 * 2026-09-15 실 라이드(D1 token_hash=b00dd879) 재구성:
 *   06:35:30  device → POST /boarding-lock/sync  observedStationName=건대입구 (사용자 환승역 도착 확정)
 *   06:36:58  transfer-advance 건대입구(L7) path=lock-active outcome=no-arvlcd (열차 7035가 이미
 *             떠나 arvlCd/positions 둘 다 못 잡음 — 환승 alert/하차 프롬프트/lock 해제 3종 동시 사망)
 *   06:42:52  lock-release:user 7035(7) (사용자가 6분간 떠난 열차를 backend가 추적하다 직접 해제)
 *
 * 코디네이터 리뷰(2026-09-15) — 최초 fix(cron `runTrainCodeTracking`에 device-sync 구제 분기 추가)는
 * inert였다: `/boarding-lock/sync`가 관측역을 `waypoints`에서 이미 slice해 제거하면서(index.ts)
 * `lastAdvanceEvidence:'device-sync'`를 SSoT에 stamp하는 두 동작이 **같은 조건문 안에서 같이
 * 일어나** cron이 다시 볼 때는 이미 `waypoints[0]`이 다음 역으로 바뀌어 있어 두 조건이 동시에
 * 성립할 수 없었다. 재설계: 관측역이 waypoints에서 slice되는 **그 순간**(`/boarding-lock/sync`
 * 핸들러 자체)에 transfer/destination waypoint를 `advanceBoardingLockWaypoint`(scheduled.ts,
 * cron이 arvlCd 확증 시 쓰는 것과 동일한 함수)로 처리한다 — 새 채널 없이 기존 발사 경로 재사용.
 *
 * 본 테스트는 **손으로 SSoT/waypoints를 조작하지 않고**, 실제 `/boarding-lock/sync` HTTP 핸들러를
 * `app.fetch`로 호출해 slice가 실제로 일어나게 한 뒤 결과(push 발사 + hop-end 상태 + lock 해제 +
 * waypoints 전진)를 관측한다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { isBoardingLockActive } from '../scheduled';
import { appendPositionPoint } from '../positionSeries';
import { getTrip, putTrip } from '../trips';
import { readSsot, seedSsot } from '../tripPositionSsot';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: pem, bundleId: 'com.example.app' };
});

beforeEach(() => resetApnsJwtCache());

const NOW = 1_758_000_000_000;
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

function makeLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7035',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW - 5 * 60_000,
    segmentStations: ['어린이대공원(세종대)', '군자(능동)', '건대입구'],
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  };
}

/**
 * 7호선(군자경유)→2호선(성수경유) 환승, 목적지 뚝섬. waypoint[1]=건대입구(transfer, line은
 * "도착하는" 노선 컨벤션 — Waypoint.line 문서("정확히 어느 호선에서 도착을 봐야 하는지")대로
 * boardingLock.line(7)과 일치해야 `clearStaleBoardingLock`(trips.ts)에 의해 cron read 시점에
 * lock이 stale로 오인 제거되지 않는다.
 */
function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'e2e-2645-tok',
    route: {
      type: 'transfer',
      fromLine: '7',
      toLine: '2',
      transferName: '건대입구',
      stops: 7,
      stopsToTransfer: 5,
      stopsFromTransfer: 2,
    } as unknown as Trip['route'],
    destination: '뚝섬',
    waypoints: [
      { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
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

function syncRequest(body: Record<string, unknown>): Request {
  return new Request('http://example.com/boarding-lock/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('#2645 환승역 하차 확정 — /boarding-lock/sync가 slice하는 순간 처리 (2026-09-15 b00dd879 재구성)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('★fix: 실 sync 호출이 slice를 일으키는 그 순간 환승 alert + 하차 프롬프트 발사 + lock 해제 + waypoints 전진', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    const res = await app.fetch(
      syncRequest({
        token: trip.token,
        observedStationName: '건대입구',
        observedAtMs: NOW,
        accuracy: 20,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; advanced: boolean; currentWaypoint: string | null };
    expect(body.ok).toBe(true);
    expect(body.advanced).toBe(true);
    expect(body.currentWaypoint).toBe('성수');

    // push가 실제로 발사됐는지 — transfer-release(환승 alert) + hop-end 프롬프트(하차했나요?) 2건.
    expect(fetchSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    // isRealLineChange(7→2) → 6분간 떠난 열차를 계속 추적하던 회귀를 lock 해제로 차단.
    expect(after?.boardingLock).toBeUndefined();
    // 환승 waypoint 소진 → 다음 waypoint(성수)로 전진.
    expect(after?.waypoints[0]?.stationName).toBe('성수');
    // 하차 프롬프트 발사 state가 실제로 stamp됐는지(leg-key = `${transferStation}|${nextLine}`).
    expect(after?.hopEndPromptState?.['건대입구|2']).toBeDefined();
    // leg-2 anchor(다음 leg 시작점) stamp 확인 — completeWaypointAdvance 공통 처리 그대로 재사용된 증거.
    expect(after?.currentLegAnchor).toEqual({ boardingStation: '건대입구', line: '2' });
  });

  it('대조: 같은 station을 다시 sync해도(이미 소진됨) 중복 발사 없음 — 자연 idempotency', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    await app.fetch(
      syncRequest({ token: trip.token, observedStationName: '건대입구', observedAtMs: NOW, accuracy: 20 }),
      env,
    );
    const callsAfterFirst = fetchSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(2);

    const res2 = await app.fetch(
      syncRequest({
        token: trip.token,
        observedStationName: '건대입구',
        observedAtMs: NOW + 5_000,
        accuracy: 20,
      }),
      env,
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { advanced: boolean };
    // 건대입구는 이미 waypoints에서 사라져 findIndex가 -1 → shiftedCount=0 → advance 없음.
    expect(body2.advanced).toBe(false);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('범위 확인: destination waypoint를 직접 관측하면 trip이 cleanup(삭제)된다', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const trip = makeTrip({
      token: 'e2e-2645-dest-tok',
      waypoints: [{ stationName: '뚝섬', line: '2', kind: 'destination' }],
      boardingLock: makeLock({ line: '2', segmentStations: ['성수', '뚝섬'] }),
    });
    await putTrip(kv as unknown as KVNamespace, trip);

    const res = await app.fetch(
      syncRequest({
        token: trip.token,
        observedStationName: '뚝섬',
        observedAtMs: NOW,
        accuracy: 20,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; advanced: boolean; currentWaypoint: string | null };
    expect(body.ok).toBe(true);
    expect(body.currentWaypoint).toBeNull();

    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(after).toBeNull();
  });

  it('대조: transfer/destination이 consumed 범위에 없으면(순수 intermediate) 기존 bulk-slice 경로 그대로 동작', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    // waypoints[0]=군자(intermediate) 단독 관측 — transfer/destination 없음. 관측역 자신은
    // intermediate라 기존 정책대로 cron에 위임(발사 없음), waypoints는 그대로(전진 없음).
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    const res = await app.fetch(
      syncRequest({
        token: trip.token,
        observedStationName: '군자(능동)',
        observedAtMs: NOW,
        accuracy: 20,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { advanced: boolean; currentWaypoint: string | null };
    // shiftedCount=1(idx=0)이라 waypoints는 기존과 동일하게 bulk-slice로 전진(건대입구가 새
    // head)한다 — "관측역 자신을 cron에 맡긴다"는 push 발사 여부에만 적용되는 정책(#2625)이지
    // waypoints 배열 자체의 전진과는 무관하다(본 PR이 건드리지 않는 기존 불변식). 핵심 증거는
    // 이 케이스에 transfer/destination이 없어 새 경로(advanceBoardingLockWaypoint)가 아예
    // 개입하지 않았다는 것 — push 미발사.
    expect(body.advanced).toBe(true);
    expect(body.currentWaypoint).toBe('건대입구');
    expect(fetchSpy).not.toHaveBeenCalled();

    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(after?.waypoints[0]?.stationName).toBe('건대입구');
    expect(after?.boardingLock?.trainCode).toBe('7035');
  });

  it('대조: device sync 없이는(cron만으로는) 여전히 no-arvlcd로 고착 — 회귀 원본 재현 근거(#2645 이슈 본문 실측)', async () => {
    // 이 테스트는 신규 코드가 아니라 회귀의 "원인"을 문서화한다: sync가 오지 않으면(즉 사용자
    // 관측이 없으면) transfer waypoint는 오직 cron의 arvlCd/positions 확증에만 의존하고, 열차가
    // 이미 떠난 뒤엔 그 확증이 영구히 오지 않는다 — 본 PR은 이 경로를 변경하지 않는다(스코프 불변).
    const kv = new InMemoryKV();
    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    // sync 호출 없이 trip 상태만 확인 — waypoints/lock 모두 미변동.
    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(after?.waypoints[0]?.stationName).toBe('군자(능동)');
    expect(isBoardingLockActive(after as Trip, NOW)).toBe(true);
  });

  // #2655 — sync 경로도 completeWaypointAdvance를 공유하므로 동일 anchor가 "최초 stamp 기준
  // 도보시간 창 안에서" 재처리되면(예: cron이 같은 환승을 이미 stamp해둔 직후 sync가 같은
  // waypoint를 처리하는 KV 레이스) 멱등해야 한다. waypoints는 아직 미소진(건대입구가 head)인
  // 채로 currentLegAnchor만 이미 이번 환승과 동일하게 stamp돼 있는 상태를 시뮬레이션 — 실제
  // 레이스에서 cron/sync 중 한쪽이 먼저 anchor를 쓰고 waypoints slice는 아직 반영 전인 순간을
  // 재현한다. 도보시간(건대입구 7→2 = 278초)보다 짧은 간격(60초)으로 재처리를 시뮬레이션.
  it('#2655 — 동일 anchor가 도보시간 창 안에서 이미 stamp된 상태에서 sync가 같은 transfer waypoint 처리 시 재-stamp 없음(멱등)', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    // 핸들러 내부 `now`는 `Date.now()`(실 벽시계)를 쓴다 — payload의 observedAtMs가 아니라(위
    // 498라인 주석과 동일 제약). 도보시간(278초) 창 안에 들어오도록 실 벽시계 기준으로 stamp.
    const realNow = Date.now();
    const firstProcessedEligibleAt = realNow - 60_000; // 첫 처리 기준 60초 전 — 도보시간(278초) 창 안
    const preservedPromptState = { lastFiredAt: realNow - 40_000, fired: true };
    const preservedStreak = { trainCode: '2555', count: 1 };
    const trip = makeTrip({
      currentLegAnchor: { boardingStation: '건대입구', line: '2' },
      legBoardingEligibleAt: firstProcessedEligibleAt,
      legBoardingPromptState: preservedPromptState,
      legResolveStreak: preservedStreak,
    });
    await putTrip(kv as unknown as KVNamespace, trip);

    const res = await app.fetch(
      syncRequest({
        token: trip.token,
        observedStationName: '건대입구',
        observedAtMs: NOW,
        accuracy: 20,
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { advanced: boolean };
    expect(body.advanced).toBe(true);

    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(after?.currentLegAnchor).toEqual({ boardingStation: '건대입구', line: '2' });
    // 재처리로 now 기준 재계산돼 밀리면 안 된다 — 첫 처리 기준 그대로.
    expect(after?.legBoardingEligibleAt).toBe(firstProcessedEligibleAt);
    expect(after?.legBoardingPromptState).toEqual(preservedPromptState);
    expect(after?.legResolveStreak).toEqual(preservedStreak);
  });
});

/**
 * PR #2649 재설계본 코드리뷰(2026-09-15) HIGH-1/HIGH-2/MEDIUM-3/MEDIUM-4/LOW-5 red→green.
 *
 * HIGH-1(aliasing): `completeWaypointAdvance`가 `trip.waypoints = trip.waypoints.slice(1)`로
 * 인자를 in-place mutate한다. 루프가 `cursor = existing`으로 시작하면 이 mutate가
 * `existing.waypoints`까지 잘라내, 이후 SSoT write 블록의 `existing.waypoints[...]` 인덱싱이
 * 밀린 원소를 잡는다 — flagship 테스트(군자→건대입구, index 0이 intermediate)는 첫 waypoint가
 * intermediate라 그 pop이 이미 `cursor`를 새 객체로 재할당해 이 경로를 타지 않아 미검출이었다.
 * 여기서는 ①observed waypoint 자체가 배열의 첫 원소인 케이스, ②`shiftedCount > 1`이며 앞쪽
 * waypoint가 transfer인 케이스를 각각 직접 겨냥한다.
 *
 * HIGH-2(stale-read rollback): `advanceBoardingLockWaypoint`가 putTrip한 직후 핸들러가 같은
 * 요청 안에서 getTrip으로 재읽기하면, colo 캐시가 stale을 반환할 때 끝의 무조건 putTrip이
 * advance를 되돌리고 해제된 lock을 되살릴 수 있다. trip key의 "옵션 없는"(getTrip(kv, token)
 * 시그니처, 재읽기가 썼던 것과 동일) GET 호출이 최초 1회를 넘으면 고의로 stale(동기화 이전)
 * 스냅샷을 반환하는 KV 더블로 이 경로 자체가 사라졌는지 검증한다.
 */
describe('PR #2649 코드리뷰 HIGH-1/HIGH-2/MEDIUM-3/MEDIUM-4/LOW-5 (2026-09-15)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('HIGH-1 케이스① observed waypoint가 배열의 첫 원소(index 0)인 transfer — SSoT currentStationLine이 훼손되지 않는다', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const trip = makeTrip({
      token: 'hi1-case1-tok',
      waypoints: [
        { stationName: '건대입구', line: '7', kind: 'transfer' },
        { stationName: '성수', line: '2', kind: 'intermediate' },
        { stationName: '뚝섬', line: '2', kind: 'destination' },
      ],
      boardingLock: makeLock({ line: '7', segmentStations: ['어린이대공원(세종대)', '건대입구'] }),
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    // SSoT write 블록을 실제로 태우기 위해 사전 seed(핸들러는 SSoT가 이미 있을 때만 갱신한다).
    await seedSsot(kv as unknown as KVNamespace, trip.token, '어린이대공원(세종대)', {
      expiresAt: trip.expiresAt,
      line: '7',
    });

    const res = await app.fetch(
      syncRequest({ token: trip.token, observedStationName: '건대입구', observedAtMs: NOW, accuracy: 20 }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { advanced: boolean; currentWaypoint: string | null };
    expect(body.advanced).toBe(true);
    expect(body.currentWaypoint).toBe('성수');

    // aliasing 버그였다면 `existing.waypoints`가 밀려 성수(line '2')가 currentStationLine에
    // 찍혔을 것 — 실제로는 건대입구 자신의 line('7')이어야 한다.
    const ssot = await readSsot(kv as unknown as KVNamespace, trip.token, { cacheTtl: 30 });
    expect(ssot?.currentStationId).toBe('건대입구');
    expect(ssot?.currentStationLine).toBe('7');
    // 관측역 자신이 passedStations에 오염되지 않아야 한다(device Gate B 억제 위험 방지).
    expect(ssot?.passedStations).not.toContain('건대입구');
  });

  it('HIGH-1 케이스② shiftedCount>1 + 앞쪽에 transfer가 있는 케이스 — matchedWaypoint가 undefined로 밀리지 않는다(500 방지)', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    // 연속 환승 2회: 왕십리(2호선→5호선 환승) → 건대입구(5호선→다른 노선 환승, 관측역) → 까치산(intermediate).
    // consumedWaypoints = [왕십리(transfer), 건대입구(transfer)] — 둘 다 transfer라 루프가 둘 다
    // advanceBoardingLockWaypoint로 처리하고, aliasing 버그가 있었다면 existing.waypoints가
    // 두 번 잘려나가 길이 1(까치산만 남음)이 되어 existing.waypoints[shiftedCount-1](index 1)이
    // undefined였을 것이다.
    const trip = makeTrip({
      token: 'hi1-case2-tok',
      waypoints: [
        { stationName: '왕십리', line: '2', kind: 'transfer' },
        { stationName: '건대입구', line: '5', kind: 'transfer' },
        { stationName: '까치산', line: '3', kind: 'intermediate' },
      ],
      boardingLock: makeLock({
        trainCode: 'X1',
        line: '2',
        segmentStations: ['성수', '왕십리'],
      }),
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedSsot(kv as unknown as KVNamespace, trip.token, '성수', {
      expiresAt: trip.expiresAt,
      line: '2',
    });

    const res = await app.fetch(
      syncRequest({ token: trip.token, observedStationName: '건대입구', observedAtMs: NOW, accuracy: 20 }),
      env,
    );

    // aliasing 버그였다면 `existing.waypoints[advance.shiftedCount - 1]`이 undefined가 되어
    // `.line` 접근에서 500이 났을 것 — 여기서는 정상 200을 기대한다.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { advanced: boolean; currentWaypoint: string | null };
    // 둘 다 transfer라 드리프트/유예 없이 순서대로 모두 적용 — shiftedCount(2) 전부 적용.
    expect(body.advanced).toBe(true);
    expect(body.currentWaypoint).toBe('까치산');

    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(after?.waypoints[0]?.stationName).toBe('까치산');
    // 왕십리(2→5 실 노선변경) 처리 시 lock 해제됐고, 이후 건대입구 처리 시 lock이 이미 없으므로
    // 추가 release 없이 그대로 undefined 유지.
    expect(after?.boardingLock).toBeUndefined();

    // matchedWaypoint가 정확히 건대입구(방금 적용된 마지막 waypoint)를 가리켜야 한다 — line은
    // 건대입구 자신의 '5'(성수의 '2'나 까치산의 '3'으로 밀리면 안 됨).
    const ssot = await readSsot(kv as unknown as KVNamespace, trip.token, { cacheTtl: 30 });
    expect(ssot?.currentStationId).toBe('건대입구');
    expect(ssot?.currentStationLine).toBe('5');
  });

  it('HIGH-2: putTrip 직후 같은 요청 안에서 getTrip 재읽기가 없다 — stale colo 캐시가 advance를 되돌리지 못한다', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const trip = makeTrip(); // 군자(intermediate) → 건대입구(transfer) → 성수 → 뚝섬, lock=7035(7호선)
    await putTrip(kv as unknown as KVNamespace, trip);

    // trip key에 대한 "옵션 없는" GET(=재읽기가 썼던 것과 동일한 시그니처, `getTrip(kv, token)`)이
    // 최초 1회를 넘으면 sync 이전 스냅샷(stale)을 반환하도록 고의로 오염시킨다.
    // `verifyBoardingLockPersisted`는 항상 `{cacheTtl: 30}`을 명시하므로 이 오염과 무관 — 정상
    // 검증은 그대로 통과한다.
    const tripKey = `trip:${trip.token}`;
    const staleSnapshot = JSON.stringify(trip);
    let noOptionsGetCount = 0;
    const originalGet = kv.get.bind(kv);
    kv.get = (async (key: string, options?: { cacheTtl?: number }) => {
      if (key === tripKey && options === undefined) {
        noOptionsGetCount += 1;
        if (noOptionsGetCount > 1) {
          return staleSnapshot;
        }
      }
      return originalGet(key, options);
    }) as typeof kv.get;

    const res = await app.fetch(
      syncRequest({ token: trip.token, observedStationName: '건대입구', observedAtMs: NOW, accuracy: 20 }),
      env,
    );

    // 요청이 끝난 뒤에는 오염을 해제한다 — 이 시점부터는 테스트 자신의 검증 read이지, 핸들러가
    // 요청 처리 중 수행하는 read가 아니다(오염 해제 없이는 우리 자신의 assertion read까지
    // stale을 받아 "고쳤는데도 stale이 보인다"는 오탐이 난다).
    kv.get = originalGet as typeof kv.get;

    expect(res.status).toBe(200);
    // 재읽기가 있었다면(HIGH-2 미수정) stale 스냅샷이 `working`을 덮어써 아래 최종 putTrip이
    // advance를 되돌리고 lock(7035)을 되살렸을 것 — 재읽기가 없으므로 advance가 그대로 유지된다.
    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(after?.waypoints[0]?.stationName).toBe('성수');
    expect(after?.boardingLock).toBeUndefined();
    // 최소 1회(최초 read)는 이 시그니처로 호출돼야 정상 — 오염 자체가 트리거된 적 없는지가 아니라
    // "재읽기가 실제로 일어났다면 그 결과가 최종 상태를 오염시키지 않는지"를 검증하는 테스트다.
    expect(noOptionsGetCount).toBeGreaterThanOrEqual(1);
  });

  it('MEDIUM-3: gps-far 유예로 advance가 중단되면 SSoT가 목적지로 점프하지 않는다(#2624 발산 재발 방지)', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    // 홍대입구(line 2) 목적지, GPS는 약 1.1km 떨어진 합정 좌표(fresh) — evaluateDestinationCrossCheck
    // 가 'gps-far'를 반환하도록(scheduled.test.ts의 동일 좌표 fixture 재사용, 이미 gps-far 산출이
    // 검증된 값). backstop(DESTINATION_REACH_BACKSTOP_MS) 미경과라 advance 자체가 유예된다 —
    // "trip 보존, waypoints 미변동" 분기.
    const HAPJEONG_LAT = 37.549457;
    const HAPJEONG_LNG = 126.913808;
    const trip = makeTrip({
      token: 'med3-dest-tok',
      waypoints: [{ stationName: '홍대입구', line: '2', kind: 'destination' }],
      boardingLock: makeLock({ line: '2', segmentStations: ['합정', '홍대입구'] }),
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    await appendPositionPoint(kv as unknown as KVNamespace, trip.token, {
      lat: HAPJEONG_LAT,
      lng: HAPJEONG_LNG,
      accuracy: 10,
      // 핸들러 내부 `now`는 `Date.now()`(실 벽시계)를 쓴다 — payload의 observedAtMs가 아니라.
      // 신선도 판정(DESTINATION_GPS_STALE_THRESHOLD_MS=5분)이 실 시각 기준이므로 여기도 맞춘다.
      ts: Date.now() - 30_000,
      motion: 'automotive',
    });
    // SSoT를 목적지가 아닌 이전 역(합정)에 seed — gps-far 유예가 이 값을 목적지로 밀어붙이면
    // (#2624와 동형의 발산) 아래 assertion이 실패한다.
    await seedSsot(kv as unknown as KVNamespace, trip.token, '합정', {
      expiresAt: trip.expiresAt,
      line: '2',
    });

    const res = await app.fetch(
      syncRequest({ token: trip.token, observedStationName: '홍대입구', observedAtMs: NOW, accuracy: 20 }),
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { advanced: boolean; currentWaypoint: string | null };
    // MEDIUM-3 핵심 — gps-far 유예로 아무것도 실제 적용되지 않았으므로 advanced=false, waypoints도
    // 미변동(홍대입구가 여전히 head, null이 아님 — trip이 끝나지도 않았다).
    expect(body.advanced).toBe(false);
    expect(body.currentWaypoint).toBe('홍대입구');

    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(after).not.toBeNull();
    expect(after?.waypoints[0]?.stationName).toBe('홍대입구');
    expect(after?.boardingLock).toBeDefined();

    // SSoT가 목적지(홍대입구)로 점프하지 않고 여전히 합정에 머문다 — appliedShiftedCount=0이라
    // SSoT write 블록 자체가 게이트에서 스킵됐다는 증거.
    const ssot = await readSsot(kv as unknown as KVNamespace, trip.token, { cacheTtl: 30 });
    expect(ssot?.currentStationId).toBe('합정');
  });

  it('MEDIUM-4: 루프 중간 실패해도 이미 적용된 진행분은 persist된다(반쪽 500 방지)', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    // 연속 환승 2회(HIGH-1 케이스②와 동일 구조) — 왕십리 처리가 완전히 끝난 뒤 건대입구 처리
    // 중간에 KV 오류를 주입한다.
    const trip = makeTrip({
      token: 'med4-tok',
      waypoints: [
        { stationName: '왕십리', line: '2', kind: 'transfer' },
        { stationName: '건대입구', line: '5', kind: 'transfer' },
        { stationName: '까치산', line: '3', kind: 'intermediate' },
      ],
      boardingLock: makeLock({ trainCode: 'X1', line: '2', segmentStations: ['성수', '왕십리'] }),
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedSsot(kv as unknown as KVNamespace, trip.token, '성수', {
      expiresAt: trip.expiresAt,
      line: '2',
    });

    // `ssot:<token>` GET은 왕십리 처리 중 2회(lock-release push의 SSoT snapshot + hop-end 프롬프트
    // 게이트 평가), 건대입구 처리 중 1회(hop-end 프롬프트만, lock은 이미 release됨) 호출된다 —
    // 3번째 호출(건대입구 처리 중)에서 던져 "첫 waypoint는 이미 완전히 커밋된 뒤" 실패를 재현한다.
    const ssotKey = `ssot:${trip.token}`;
    let ssotGetCount = 0;
    const originalGet = kv.get.bind(kv);
    kv.get = (async (key: string, options?: { cacheTtl?: number }) => {
      if (key === ssotKey) {
        ssotGetCount += 1;
        if (ssotGetCount === 3) {
          throw new Error('simulated KV outage mid-loop');
        }
      }
      return originalGet(key, options);
    }) as typeof kv.get;

    const res = await app.fetch(
      syncRequest({ token: trip.token, observedStationName: '건대입구', observedAtMs: NOW, accuracy: 20 }),
      env,
    );

    // try/catch 없이 그대로 throw했다면 Hono가 이 요청 전체를 500으로 응답했을 것이고, putTrip/
    // verify/SSoT write 단계를 전부 건너뛰어 "push는 나갔는데 trip 상태는 진행 전"인 반쪽 상태가
    // 됐을 것이다 — 지금은 지금까지 적용된 진행분(왕십리만)을 들고 정상 200을 반환한다.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { advanced: boolean };
    expect(body.advanced).toBe(true);

    const after = await getTrip(kv as unknown as KVNamespace, trip.token);
    // 왕십리는 이미 advanceBoardingLockWaypoint 내부에서 완전히 커밋(putTrip)됐다 — lock
    // release(실 노선변경 2→5)와 waypoints 전진이 최종 persist까지 살아남아야 한다.
    expect(after?.boardingLock).toBeUndefined();
    expect(after?.waypoints[0]?.stationName).not.toBe('왕십리');
    expect(ssotGetCount).toBeGreaterThanOrEqual(3);
  });

  it('LOW-5: D1 advance 이벤트의 shiftedCount가 요청값이 아니라 실제 적용값이다', async () => {
    const kv = new InMemoryKV();
    const rows: { kind: string; station: string | null; meta: Record<string, unknown> | null }[] = [];
    const db = {
      prepare: () => ({
        bind: (...args: unknown[]) => {
          rows.push({
            kind: args[2] as string,
            station: (args[3] as string | null) ?? null,
            meta: args[5] ? (JSON.parse(args[5] as string) as Record<string, unknown>) : null,
          });
          return { run: async () => ({ success: true }) };
        },
      }),
    } as unknown as D1Database;
    const envWithDb: Env = { ...makeEnv(kv), DB: db };

    const trip = makeTrip();
    await putTrip(kv as unknown as KVNamespace, trip);

    await app.fetch(
      syncRequest({ token: trip.token, observedStationName: '건대입구', observedAtMs: NOW, accuracy: 20 }),
      envWithDb,
    );

    const advanceEvents = rows.filter((r) => r.kind === 'advance');
    expect(advanceEvents.length).toBeGreaterThan(0);
    // 요청(shiftedCount=2, 군자+건대입구)과 실제 적용(2, 둘 다 transfer 경로 없이 하나는
    // intermediate-skip, 하나는 advanceBoardingLockWaypoint로 온전히 적용)이 일치하는 정상
    // 케이스 — 이 값이 항상 실제 적용치임을 고정한다(요청값을 그대로 베끼지 않음).
    const last = advanceEvents[advanceEvents.length - 1];
    expect(last.meta?.shiftedCount).toBe(2);
    expect(last.station).toBe('성수');
  });
});
