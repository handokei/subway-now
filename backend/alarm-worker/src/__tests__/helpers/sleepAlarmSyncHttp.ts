/**
 * #3100 PR-2 — sync 경로(`/boarding-lock/sync`)를 HTTP 레벨로 구동하는 하네스.
 * 순수 점프(#3157) / 승격 fast-forward / 혼합 분기 세 경로가 공유한다. 입력은 전부 호출자가 정하고,
 * 이 파일은 trip seed -> 요청 -> waitUntil 체인 정착 -> 푸시/KV/D1 관측만 한다.
 */
import { vi } from 'vitest';
import app from '../../index';
import { inferLegDirection } from '../../legDirection';
import type { Env, Trip, Waypoint } from '../../types';
import { InMemoryKV } from '../inMemoryKv';
import { alarmAlerts, captureFetch, companions, fakeD1, makeEnv, spyKv, wp } from './sleepAlarmHarness';

export const SYNC_TOKEN = 'sync-pr2-tok';
const HOUR_MS = 60 * 60_000;
const SETTLE_MS = 150;

/** 알람 catch-up은 응답 이후 waitUntil 체인(ctx 없음 -> floating promise)에서 돈다 — 충분히 흘려보낸다. */
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

export function lockActiveTrip(waypoints: Waypoint[], overrides: Partial<Trip> = {}): Trip {
  const now = Date.now();
  const { line } = waypoints[0];
  return {
    token: SYNC_TOKEN,
    route: { type: 'direct', line, stops: waypoints.length } as unknown as Trip['route'],
    destination: waypoints[waypoints.length - 1].stationName,
    waypoints,
    expiresAt: now + 3 * HOUR_MS,
    createdAt: now - 10 * 60_000,
    alarmAtEpochMs: now,
    sleepModeEnabled: true,
    infoModeEnabled: true,
    boardingLock: {
      trainCode: '7246',
      line,
      subwayId: '1007',
      selectedDepartureTime: now - 5 * 60_000,
      segmentStations: waypoints.map((w) => w.stationName),
      expiresAt: now + 3 * HOUR_MS,
    },
    ...overrides,
  };
}

export interface SyncHttpResult {
  status: number;
  alarms: { collapseId?: string; body: Record<string, unknown> }[];
  companions: { body: Record<string, unknown> }[];
  alarmKeyCalls: { get: number; put: number; delete: number };
  sleepRows: { meta: Record<string, unknown> | null }[];
  stored: Trip | undefined;
}

async function runRequest(kv: InMemoryKV, body: Record<string, unknown>, trip: Trip): Promise<SyncHttpResult> {
  const f = captureFetch();
  vi.stubGlobal('fetch', f.fetchImpl);
  const d1 = fakeD1();
  const env: Env = makeEnv(kv, d1.db);
  const spy = spyKv(kv);
  const res = await app.fetch(
    new Request('http://example.com/boarding-lock/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: trip.token, observedAtMs: Date.now(), accuracy: 20, ...body }),
    }),
    env,
  );
  await settle();
  const raw = await kv.get(`trip:${trip.token}`);
  return {
    status: res.status,
    alarms: alarmAlerts(f.calls),
    companions: companions(f.calls),
    alarmKeyCalls: spy.alarmKeyCalls(),
    sleepRows: d1.rows.filter((r) => r.kind === 'sleep-alarm'),
    stored: raw === null ? undefined : (JSON.parse(raw) as Trip),
  };
}

/** 순수 점프 / 혼합 분기: 이미 lock이 있는 trip에 관측역만 보낸다. */
export async function syncObserved(trip: Trip, observedStationName: string): Promise<SyncHttpResult> {
  const kv = new InMemoryKV();
  await kv.put(`trip:${trip.token}`, JSON.stringify(trip));
  return runRequest(kv, { observedStationName }, trip);
}

/** 7호선 중곡->군자->어린이대공원->건대입구 상행 체인(승격 fast-forward 구동용 실제 노선 순서). */
export const FF_CHAIN_NAMES = ['중곡', '군자', '어린이대공원', '건대입구'];
const FF_LINE = '7';
const FF_TRAIN = '7039';
const FF_ORIGIN = '용마산';
const FF_DEPARTED_AGO_MS = 3 * 60_000;
const FF_RECEPTION_AGO_MS = 5_000;
/** `trainSttus` 2 = 출발 — 해당 역을 이미 출발한 열차. */
export const TRAIN_DEPARTED = 2;

/** 수동 목록 탭(sync) 승격: 열차가 `position` 역을 `trainSttus`로 지나는 중일 때 fast-forward skip 수가 정해진다. */
export async function syncPromote(
  targetKind: 'transfer' | 'destination',
  overrides: Partial<Trip>,
  position: { stationName: string; trainSttus: number },
): Promise<SyncHttpResult> {
  const now = Date.now();
  const isUp = inferLegDirection(FF_LINE, FF_ORIGIN, FF_CHAIN_NAMES[0]) === 'up';
  const lastIndex = FF_CHAIN_NAMES.length - 1;
  const waypoints = FF_CHAIN_NAMES.map((name, i) => wp(name, i === lastIndex ? targetKind : 'intermediate', FF_LINE));
  const trip: Trip = { ...lockActiveTrip(waypoints), boardingLock: undefined, ...overrides };
  const kv = new InMemoryKV();
  await kv.put(`trip:${trip.token}`, JSON.stringify(trip));
  await kv.put(
    `realtime-position:${FF_LINE}`,
    JSON.stringify({
      positions: [{ trainCode: FF_TRAIN, isUp, recptnMs: now - FF_RECEPTION_AGO_MS, ...position }],
      fetchedAt: now - FF_RECEPTION_AGO_MS,
      stationLogs: {
        [FF_ORIGIN]: { present: [], departed: [{ trainCode: FF_TRAIN, isUp, departedAt: now - FF_DEPARTED_AGO_MS }] },
      },
    }),
  );
  return runRequest(kv, { observedStationName: FF_ORIGIN, trainCode: FF_TRAIN, boardingLine: FF_LINE }, trip);
}
