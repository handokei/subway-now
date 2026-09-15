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
import { getTrip, putTrip } from '../trips';
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
});
