/**
 * #2625 — `fireSyncSkippedStationPasses` 단위 테스트.
 *
 * 재현 red: `/boarding-lock/sync`의 multi-shift advance(`advance.shiftedCount > 1`)가
 * `working.waypoints.slice(advance.shiftedCount)`로 건너뛰는 station-passed waypoint를
 * 무발사·무계측으로 드롭하던 회귀(2026-09-15 실 라이드 b00dd879, 건대입구/성수 무발사) —
 * 본 함수가 dropped waypoint 전체(kind==='intermediate'만)를 발사+계측하는지 검증.
 *
 * 커버 범위:
 *   - dropped station-passed waypoint 전부 발사(dedup/cap 미해당) + D1 outcome='sent'
 *   - transfer/destination kind는 건드리지 않는다(스코프 밖, 이슈 "하지 말 것")
 *   - 경로-무관 dedup(`stationPassedFiredKey`)이 이미 stamp된 역은 재발사 금지 +
 *     outcome='skipped-reason'
 *   - `SYNC_SKIPPED_STATION_FIRE_CAP` 초과분은 발사하지 않고 outcome='skipped-by-shift'만 계측
 *   - push 실패 시 outcome='failed', 발사 카운트 미증가
 *   - sleepModeEnabled 트립은 전체 skip(계측도 없음)
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
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
    waypoints: [
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
  it('건대입구/성수 2칸 shift — 드롭된 station-passed waypoint 2건 모두 발사 + D1 outcome=sent', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip();
    const skipped: Waypoint[] = [
      { stationName: '건대입구', line: '7', kind: 'intermediate' },
      { stationName: '성수', line: '7', kind: 'intermediate' },
    ];

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

    expect(stats).toEqual({ fired: 2, failed: 0, dedupSkipped: 0, capSkipped: 0 });
    const fireRows = rows.filter((r) => r.kind === 'cron-fire-attempt');
    expect(fireRows.map((r) => r.station)).toEqual(['건대입구', '성수']);
    expect(fireRows.every((r) => r.meta?.outcome === 'sent')).toBe(true);
  });

  it('transfer/destination kind는 건드리지 않는다(스코프 밖) — 발사도 계측도 없음', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip();
    const skipped: Waypoint[] = [
      { stationName: '건대입구', line: '7', kind: 'transfer' },
      { stationName: '뚝섬', line: '7', kind: 'destination' },
    ];

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
    expect(rows.filter((r) => r.kind === 'cron-fire-attempt')).toHaveLength(0);
  });

  it('경로-무관 dedup 키가 이미 존재 — 재발사 금지 + outcome=skipped-reason', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip();
    const dedupKey = stationPassedFiredKey(trip.token, trip.boardingLock!.trainCode, '건대입구');
    await kv.put(dedupKey, '1');
    const skipped: Waypoint[] = [{ stationName: '건대입구', line: '7', kind: 'intermediate' }];

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

  it(`상한(${'SYNC_SKIPPED_STATION_FIRE_CAP'}) 초과분 — 발사 없이 outcome=skipped-by-shift만 계측`, async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip();
    const skipped: Waypoint[] = Array.from(
      { length: SYNC_SKIPPED_STATION_FIRE_CAP + 2 },
      (_, i): Waypoint => ({ stationName: `역${i}`, line: '7', kind: 'intermediate' }),
    );

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

    expect(stats).toEqual({
      fired: SYNC_SKIPPED_STATION_FIRE_CAP,
      failed: 0,
      dedupSkipped: 0,
      capSkipped: 2,
    });
    const capRows = rows.filter((r) => r.meta?.outcome === 'skipped-by-shift');
    expect(capRows).toHaveLength(2);
  });

  it('push 실패 — outcome=failed, 발사 카운트 미증가', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { db, rows } = makeDbMock();
    const trip = makeTrip();
    const failFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 })) as unknown as typeof fetch;
    const skipped: Waypoint[] = [{ stationName: '건대입구', line: '7', kind: 'intermediate' }];

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
    const skipped: Waypoint[] = [{ stationName: '건대입구', line: '7', kind: 'intermediate' }];

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
    const skipped: Waypoint[] = [{ stationName: '건대입구', line: '7', kind: 'intermediate' }];

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
});
