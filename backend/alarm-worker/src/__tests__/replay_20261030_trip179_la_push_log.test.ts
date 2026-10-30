/**
 * #2747 PR-2 — 10/28 trip 179 여정에서 backend가 보낸 LA push를 `la-push`로 관측하는 replay.
 *
 * waypoint 5개(군자 -> 어린이대공원 -> 건대입구 -> 성수 -> 뚝섬) 구간마다 LA push 3회(총 15 push, 4 advance).
 * fixture(`fixtures/capture_20261028_trip179/device_waypoints.contract.json`)는 device 등록 payload 실측 — **불변**.
 *
 * 계약: la-push 행 수 >= advance 수 && <= push 수, 같은 digest 연속이면 0행, KV write 불변(D1 statement는 trip_events뿐).
 */
import fs from 'node:fs';
import path from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApnsConfig } from '../apns';
import { resetApnsJwtCache } from '../apns';
import { validateTrip } from '../index';
import { SeoulArrivalClient } from '../seoul';
import { createEmptyScheduledStats, maybeFireLiveActivityUpdate, type ScheduledDeps } from '../scheduled';
import type { TripPositionSSoT } from '../tripPositionSsot';
import type { Trip } from '../types';
import { makeFakeLaPushDb } from './fakeLaPushDb';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'capture_20261028_trip179');
const KST_OFFSET_MS = 9 * 60 * 60_000;
const START = Date.UTC(2026, 9, 28, 6, 29, 46) - KST_OFFSET_MS;
const PUSHES_PER_STATION = 3;
const PUSH_GAP_MS = 35_000; // LA_PUSH_THRESHOLD_MS(30s) dedup 통과

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());

function registeredTrip(): Trip {
  const contract = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'device_waypoints.contract.json'), 'utf8')) as {
    route: unknown;
    waypoints: Record<string, unknown>[];
  };
  const trip = validateTrip({
    token: 'trip179',
    destination: '뚝섬',
    route: contract.route,
    waypoints: contract.waypoints,
    expiresAt: Date.now() + 3_600_000,
    alarmAtEpochMs: START + 60_000,
  });
  if (!trip) throw new Error('validateTrip rejected the device payload');
  return { ...trip, activityPushToken: 'la-token', activityState: 'live', apnsEnv: 'sandbox', originStationName: '중곡' };
}

/** 한 구간(waypoint index k)에서 pushes회 LA push. 반환: 성공(fired) push 수. */
async function ridePushes(trip: Trip, k: number, count: number, startAt: number, deps: ScheduledDeps): Promise<number> {
  const all = registeredTrip().waypoints;
  trip.waypoints = all.slice(k);
  const ssot = { currentStationId: k === 0 ? '중곡' : all[k - 1].stationName, motionEvidence: [] } as unknown as TripPositionSSoT;
  let fired = 0;
  for (let i = 0; i < count; i += 1) {
    const now = startAt + i * PUSH_GAP_MS;
    const ok = await maybeFireLiveActivityUpdate(trip, trip.waypoints[0], now + 120_000, deps, createEmptyScheduledStats(now), now, () => {}, ssot);
    if (ok) fired += 1;
  }
  return fired;
}

describe('#2747 PR-2 — trip 179 여정 la-push 관측', () => {
  it('행 수 >= advance 수 && <= push 수, 같은 digest 연속 push는 0행, D1 statement는 trip_events 전용(KV 불변)', async () => {
    const { db, laPushRows, statements } = makeFakeLaPushDb();
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const deps = {
      apnsConfig,
      apnsHosts: { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      seoul: new SeoulArrivalClient({ host: 'h', apiKey: 'K', fetchImpl: fetchImpl as unknown as typeof fetch }),
      db,
    } as ScheduledDeps;
    const trip = registeredTrip();
    const stationCount = trip.waypoints.length;

    let pushes = 0;
    let rowsAfterFirstStation = 0;
    for (let k = 0; k < stationCount; k += 1) {
      pushes += await ridePushes(trip, k, PUSHES_PER_STATION, START + k * PUSHES_PER_STATION * PUSH_GAP_MS, deps);
      if (k === 0) rowsAfterFirstStation = laPushRows().length;
    }

    const advances = stationCount - 1;
    expect(pushes).toBe(stationCount * PUSHES_PER_STATION);
    expect(rowsAfterFirstStation).toBe(1); // 같은 digest 3회 -> 1행
    expect(laPushRows().length).toBeGreaterThanOrEqual(advances);
    expect(laPushRows().length).toBeLessThanOrEqual(pushes);
    expect(laPushRows().length).toBe(stationCount); // 구간마다 digest가 달라 정확히 1행씩
    for (const sql of statements) expect(sql).toContain('trip_events');
    for (const row of laPushRows()) expect(JSON.parse(row.meta as string).activity).toBe('journey');
  });
});
