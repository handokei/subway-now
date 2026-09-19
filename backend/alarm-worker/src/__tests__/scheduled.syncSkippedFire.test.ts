/**
 * #2625 — `fireSyncSkippedStationPasses` 단위 테스트.
 *
 * 재현 red: `/boarding-lock/sync`의 multi-shift advance(`advance.shiftedCount > 1`)가
 * 관측역 이전에 건너뛴 station-passed waypoint를 무발사·무계측으로 드롭하던 회귀
 * (2026-09-15 실 라이드 b00dd879, 건대입구/성수 무발사) — 본 함수가 그 waypoint들
 * (kind==='intermediate'만)을 발사+계측하는지 검증.
 *
 * 커버 범위 (코드리뷰 반영, PR #2635):
 *   - dropped station-passed waypoint 발사(dedup/cap 미해당) + D1 outcome='sent'
 *   - newest-first 순서(P1-2) — 관측역에 가까운 역부터 발사, cap 초과 시 오래된 역부터 밀림
 *   - transfer/destination kind는 발사하지 않되(스코프 밖) skip도 D1에 계측한다(P2-7)
 *   - 경로-무관 dedup(`stationPassedFiredKey`)이 이미 stamp된 역은 재발사 금지 +
 *     outcome='skipped-reason'
 *   - `SYNC_SKIPPED_STATION_FIRE_CAP` 초과분은 발사하지 않고 outcome='skipped-by-shift'만 계측
 *   - push 실패 시 outcome='failed', 발사 카운트 미증가
 *   - sleepModeEnabled 트립은 전체 skip(계측도 없음)
 *   - 역 단위 collapse-id(P1-5) — 같은 sync 내 여러 push가 trip 단위로 collapse되지 않는다
 *   - archFlag forward(P1-6) — 'on'이면 payload.boardingLine이 undefined로 실린다
 *   - 슬라이스 이전(pre-slice) trip.waypoints를 넘겨야 남은 정거장/환승 타깃이 정확하다(P1-3)
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { stationNotifCollapseId } from '../collapseId';
import {
  fireSyncSkippedStationPasses,
  stationPassedFiredKey,
  SYNC_SKIPPED_STATION_FIRE_CAP,
} from '../scheduled';
import type { BoardingLockMeta, Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: pem, bundleId: 'com.example.app' };
});

beforeEach(() => resetApnsJwtCache());

const NOW = 1_700_000_000_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;

function makeDbMock() {
  const rows: { kind: string; station: string | null; meta: Record<string, unknown> | null }[] = [];
  const prepare = () => ({
    bind: (...args: unknown[]) => {
      rows.push({
        kind: args[2] as string,
        station: args[3] as string | null,
        meta: args[5] ? (JSON.parse(args[5] as string) as Record<string, unknown>) : null,
      });
      return { run: async () => ({ success: true }) };
    },
  });
  return { db: { prepare } as unknown as D1Database, rows };
}

function makeEnv(kv: InMemoryKV, db?: D1Database): Env {
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
    DB: db,
  };
}

function makeBoardingLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations: ['어린이대공원', '건대입구', '성수', '뚝섬'],
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'sync-fire-tok',
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '뚝섬',
    // 코드리뷰 P1-3 — 슬라이스 이전(pre-slice) 전체 waypoints. 실제 caller(index.ts)도
    // `existing`(pre-slice)을 넘긴다.
    waypoints: [
      { stationName: '건대입구', line: '7', kind: 'intermediate' },
      { stationName: '성수', line: '7', kind: 'intermediate' },
      { stationName: '뚝섬', line: '7', kind: 'destination' },
    ],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW - 60_000,
    boardingLock: makeBoardingLock(),
    ...overrides,
  };
}

const SUCCESS_APNS_FETCH: typeof fetch = (async () =>
  new Response('', { status: 200 })) as unknown as typeof fetch;

describe('#2625 — fireSyncSkippedStationPasses', () => {
  it('#2661 — 건대입구/성수 2칸 shift에서 가장 최근 역(성수) 1건만 발사, 나머지는 skipped-by-shift로 계측만', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip();
    // 원본 waypoints에서 그대로 slice — 코드리뷰 P1-3(원래 인덱스 보존) 전제와 동일하게 object
    // reference를 유지한다.
    const skipped = trip.waypoints.slice(0, 2);

    const stats = await fireSyncSkippedStationPasses(
      makeEnv(kv, db),
      trip,
      skipped,
      trip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    expect(stats).toEqual({ fired: 1, failed: 0, dedupSkipped: 0, capSkipped: 1 });
    const fireRows = rows.filter((r) => r.kind === 'cron-fire-attempt');
    // newest-first — 관측역(성수)에 가까운 쪽부터 처리. cap=1이라 성수만 발사되고 건대입구는
    // 발사 없이 D1에만 남는다(#2661: 이미 지나간 역 알림 몰림 제거, 관측 가능성은 유지).
    expect(fireRows.map((r) => ({ station: r.station, outcome: r.meta?.outcome }))).toEqual([
      { station: '성수', outcome: 'sent' },
      { station: '건대입구', outcome: 'skipped-by-shift' },
    ]);
  });

  it('transfer/destination kind는 발사하지 않되 skip 자체는 D1에 계측한다(코드리뷰 P2-7)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip({
      waypoints: [
        { stationName: '군자', line: '7', kind: 'transfer' },
        { stationName: '어린이대공원', line: '7', kind: 'destination' },
      ],
    });
    const skipped: Waypoint[] = trip.waypoints;

    const stats = await fireSyncSkippedStationPasses(
      makeEnv(kv, db),
      trip,
      skipped,
      trip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    expect(stats).toEqual({ fired: 0, failed: 0, dedupSkipped: 0, capSkipped: 0 });
    const fireRows = rows.filter((r) => r.kind === 'cron-fire-attempt');
    expect(fireRows).toHaveLength(2);
    expect(fireRows.every((r) => r.meta?.outcome === 'skipped-reason')).toBe(true);
    expect(fireRows.every((r) => r.meta?.reason === 'sync-skip-non-intermediate')).toBe(true);
  });

  it('경로-무관 dedup 키가 이미 존재 — 재발사 금지 + outcome=skipped-reason', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip();
    const dedupKey = stationPassedFiredKey(trip.token, trip.boardingLock!.trainCode, '건대입구');
    await kv.put(dedupKey, '1');
    const skipped: Waypoint[] = [trip.waypoints[0]];

    const stats = await fireSyncSkippedStationPasses(
      makeEnv(kv, db),
      trip,
      skipped,
      trip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    expect(stats).toEqual({ fired: 0, failed: 0, dedupSkipped: 1, capSkipped: 0 });
    const fireRow = rows.find((r) => r.kind === 'cron-fire-attempt');
    expect(fireRow?.meta?.outcome).toBe('skipped-reason');
  });

  it(`상한(${'SYNC_SKIPPED_STATION_FIRE_CAP'}) 초과분 — newest-first로 발사하고 가장 오래된 역만 skipped-by-shift`, async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    // 역0(가장 오래됨) ... 역N(관측역에 가장 가까움) 순서로 배열.
    const waypoints: Waypoint[] = Array.from(
      { length: SYNC_SKIPPED_STATION_FIRE_CAP + 2 },
      (_, i): Waypoint => ({ stationName: `역${i}`, line: '7', kind: 'intermediate' }),
    );
    const trip = makeTrip({ waypoints: [...waypoints, { stationName: '종점', line: '7', kind: 'destination' }] });

    const stats = await fireSyncSkippedStationPasses(
      makeEnv(kv, db),
      trip,
      waypoints,
      trip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    expect(stats).toEqual({
      fired: SYNC_SKIPPED_STATION_FIRE_CAP,
      failed: 0,
      dedupSkipped: 0,
      capSkipped: 2,
    });
    const fireRows = rows.filter((r) => r.kind === 'cron-fire-attempt');
    // newest-first로 cap개가 발사되고 나머지(가장 오래된 쪽)가 버려진다. cap 값 자체에
    // 의존하지 않도록 기대값을 상수에서 산출한다(#2661에서 3→1로 바뀌어도 이 계약은 불변).
    const newestFirst = [...waypoints].reverse().map((w) => w.stationName);
    const sentStations = fireRows.filter((r) => r.meta?.outcome === 'sent').map((r) => r.station);
    expect(sentStations).toEqual(newestFirst.slice(0, SYNC_SKIPPED_STATION_FIRE_CAP));
    const capRows = fireRows.filter((r) => r.meta?.outcome === 'skipped-by-shift');
    expect(capRows.map((r) => r.station)).toEqual(newestFirst.slice(SYNC_SKIPPED_STATION_FIRE_CAP));
  });

  it('push 실패 — outcome=failed, 발사 카운트 미증가', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip();
    const failFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 })) as unknown as typeof fetch;
    const skipped: Waypoint[] = [trip.waypoints[0]];

    const stats = await fireSyncSkippedStationPasses(
      makeEnv(kv, db),
      trip,
      skipped,
      trip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: failFetch },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    expect(stats).toEqual({ fired: 0, failed: 1, dedupSkipped: 0, capSkipped: 0 });
    const fireRow = rows.find((r) => r.kind === 'cron-fire-attempt');
    expect(fireRow?.meta?.outcome).toBe('failed');
  });

  it('sleepModeEnabled 트립은 전체 skip(계측도 없음)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip({ sleepModeEnabled: true });
    const skipped: Waypoint[] = [trip.waypoints[0]];

    const stats = await fireSyncSkippedStationPasses(
      makeEnv(kv, db),
      trip,
      skipped,
      trip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    expect(stats).toEqual({ fired: 0, failed: 0, dedupSkipped: 0, capSkipped: 0 });
    expect(rows).toHaveLength(0);
  });

  it('발사 성공 시 경로-무관 dedup 키에 best-effort 1 put', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db } = makeDbMock();
    const trip = makeTrip();
    const dedupKey = stationPassedFiredKey(trip.token, trip.boardingLock!.trainCode, '건대입구');
    const skipped: Waypoint[] = [trip.waypoints[0]];

    await fireSyncSkippedStationPasses(
      makeEnv(kv, db),
      trip,
      skipped,
      trip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: SUCCESS_APNS_FETCH },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    expect(await kv.get(dedupKey)).toBe('1');
  });

  it('코드리뷰 P1-5 — 역 단위 collapse-id를 쓴다(같은 sync 내 여러 push가 trip 단위로 collapse되지 않음)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip();
    const skipped = trip.waypoints.slice(0, 2);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

    await fireSyncSkippedStationPasses(
      makeEnv(kv),
      trip,
      skipped,
      trip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: fetchSpy as unknown as typeof fetch },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    // #2661 — cap=1이라 한 sync에서 발사되는 건 newest(성수) 1건. collapse-id는 여전히 **역
    // 단위**여야 한다(연속된 sync들이 각각 다른 역을 발사할 때 trip 단위 collapse면 이전 역
    // 배너가 교체되며 순서 보장이 없어 과거 역명이 살아남을 수 있다 — #2625 P1-5의 원래 근거).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const collapseIds = fetchSpy.mock.calls.map(
      (call) => (call[1] as { headers: Record<string, string> }).headers['apns-collapse-id'],
    );
    expect(collapseIds).toEqual([stationNotifCollapseId(trip.token, '성수')]);
  });

  it("코드리뷰 P1-6 — archFlag='on'이면 payload.boardingLine이 undefined로 실린다(device lockless opt-out 게이트 존중)", async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip();
    const skipped: Waypoint[] = [trip.waypoints[0]];
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

    await fireSyncSkippedStationPasses(
      makeEnv(kv),
      trip,
      skipped,
      trip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: fetchSpy as unknown as typeof fetch, archFlag: 'on' },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
      data: { boardingLine?: string };
    };
    expect(body.data.boardingLine).toBeUndefined();
  });

  it("archFlag 미전달(기본) — payload.boardingLine에 lock.line이 그대로 실린다", async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeTrip();
    const skipped: Waypoint[] = [trip.waypoints[0]];
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));

    await fireSyncSkippedStationPasses(
      makeEnv(kv),
      trip,
      skipped,
      trip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: fetchSpy as unknown as typeof fetch },
      NOW,
      () => undefined,
      () => 'push-1',
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
      data: { boardingLine?: string };
    };
    expect(body.data.boardingLine).toBe('7');
  });

  it('코드리뷰 P1-3 — pre-slice trip.waypoints를 넘겨야 건너뛴(오래된) waypoint의 남은 정거장/환승 타깃이 정확하다', async () => {
    const kv = new InMemoryKV(() => NOW);
    // 2개 dropped(건대입구/아차산) + 그 뒤 환승(군자) + 목적지. "오래된" 쪽(건대입구)의
    // 카운트를 계산할 때, 사이에 낀 아차산·군자가 remaining에 포함돼야 정확하다.
    const preSliceWaypoints: Waypoint[] = [
      { stationName: '건대입구', line: '7', kind: 'intermediate' },
      { stationName: '아차산', line: '7', kind: 'intermediate' },
      { stationName: '군자', line: '7', kind: 'transfer' },
      { stationName: '어린이대공원', line: '5', kind: 'destination' },
    ];
    const correctTrip = makeTrip({ waypoints: preSliceWaypoints });
    const skipped: Waypoint[] = [preSliceWaypoints[0]];

    const correctFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    await fireSyncSkippedStationPasses(
      makeEnv(kv),
      correctTrip,
      skipped,
      correctTrip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: correctFetch as unknown as typeof fetch },
      NOW,
      () => undefined,
      () => 'push-1',
    );
    const correctBody = JSON.parse(correctFetch.mock.calls[0][1].body as string) as {
      aps: { alert: { body: string } };
    };
    // remaining(건대입구 이후) = [아차산, 군자(transfer), 어린이대공원] → 환승(군자)까지 2정거장.
    expect(correctBody.aps.alert.body).toBe('군자까지 2정거장 남음');

    // 버그 재현 대조군 — post-slice(건대입구·아차산·군자가 전부 빠진, 즉 caller가 `working`을
    // 넘기던 구현) waypoints를 넘기면 indexOf가 -1이 돼 환승 대신 destination을 잘못
    // 가리킨다(#2625 코드리뷰 P1-3이 잡은 회귀).
    const kv2 = new InMemoryKV(() => NOW);
    const brokenTrip = makeTrip({ waypoints: preSliceWaypoints.slice(3) });
    const brokenFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    await fireSyncSkippedStationPasses(
      makeEnv(kv2),
      brokenTrip,
      skipped,
      brokenTrip.boardingLock!,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: brokenFetch as unknown as typeof fetch },
      NOW,
      () => undefined,
      () => 'push-1',
    );
    const brokenBody = JSON.parse(brokenFetch.mock.calls[0][1].body as string) as {
      aps: { alert: { body: string } };
    };
    expect(brokenBody.aps.alert.body).toBe('어린이대공원까지 1정거장 남음');
    expect(brokenBody.aps.alert.body).not.toBe(correctBody.aps.alert.body);
  });
});
