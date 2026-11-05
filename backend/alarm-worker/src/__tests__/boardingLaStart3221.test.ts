/**
 * #3221 PR-3 — 탑승 LA push-to-start 발사기(`fireBoardingLaStart`) + 매역 도착 content builder 단위 계약.
 *
 * TDD: 이슈 스펙(plan §4-2, §8 PR-3, §13)만 보고 작성. 실측 사슬 acceptance는
 * `replay_20261028_trip179_boarding_la_start.test.ts`.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import {
  BOARDING_ACTIVITY_ATTRIBUTES_TYPE,
  fireBoardingLaStart,
  hasBoardingStartTarget,
} from '../boardingLaStart';
import { buildStationArrivedContentState, STATION_ARRIVED_DISPLAY_SEC } from '../liveActivity';
import type { Env, Trip, Waypoint } from '../types';

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());

const NOW = 1_793_136_466_000; // 2026-10-28 06:27:46 KST
const HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
const SPLIT = { split: true, boardingStart: 'push-to-start' } as const;

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'devtoken0123456789',
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '용마산',
    waypoints: [{ stationName: '용마산', line: '7', kind: 'destination' }],
    expiresAt: NOW + 3_600_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW,
    apnsEnv: 'production',
    laClient: SPLIT,
    boardingPushToStartToken: 'pts-token-abc',
    ...overrides,
  };
}

interface Db {
  rows: unknown[][];
  db: D1Database;
}
function makeDb(): Db {
  const rows: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          rows.push(args);
          return {};
        },
      }),
    }),
  } as unknown as D1Database;
  return { rows, db };
}

function makeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

function fire(trip: Trip, fetchImpl: typeof fetch, db?: D1Database, extra: Record<string, unknown> = {}) {
  return fireBoardingLaStart({
    trip,
    env: { DB: db } as unknown as Env,
    deps: { apnsConfig, apnsHosts: HOSTS, fetchImpl },
    now: NOW,
    log: () => undefined,
    path: 'boarding-prompt',
    phase: 'pre-boarding',
    station: '용마산',
    line: '7',
    title: '탑승하셨나요?',
    trainInfo: '용마산 7호선 · 06:27 중곡 방면 장암행 열차',
    ...extra,
  });
}

describe('hasBoardingStartTarget — split && push-to-start token일 때만', () => {
  it('split + token => true', () => expect(hasBoardingStartTarget(makeTrip())).toBe(true));
  it('laClient 없음(구 클라이언트) => false', () => {
    expect(hasBoardingStartTarget(makeTrip({ laClient: undefined }))).toBe(false);
  });
  it('token 없음 => false', () => {
    expect(hasBoardingStartTarget(makeTrip({ boardingPushToStartToken: undefined }))).toBe(false);
  });
});

describe('fireBoardingLaStart', () => {
  it('push-to-start token으로 event=start를 보낸다: attributes-type/static attributes/content-state/alert(소리)', async () => {
    const { calls, impl } = makeFetch([{ status: 200 }]);
    const result = await fire(makeTrip(), impl);
    expect(result).toEqual({ sent: true, dirty: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.push.apple.com/3/device/pts-token-abc');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['apns-push-type']).toBe('liveactivity');
    const { aps } = JSON.parse(String(calls[0].init.body));
    expect(aps.event).toBe('start');
    expect(aps['attributes-type']).toBe(BOARDING_ACTIVITY_ATTRIBUTES_TYPE);
    expect(BOARDING_ACTIVITY_ATTRIBUTES_TYPE).toBe('BoardingActivityAttributes');
    expect(aps.attributes).toEqual({ promptId: `pre-boarding-${NOW}`, tripToken: 'devtoken0123456789' });
    expect(aps['content-state']).toEqual({
      phase: 'pre-boarding',
      originStation: '용마산',
      line: '7호선',
      lineName: '7호선',
      lineColorHex: '#747F00',
      title: '탑승하셨나요?',
      trainInfo: '용마산 7호선 · 06:27 중곡 방면 장암행 열차',
    });
    expect(aps.alert).toEqual({ title: '탑승하셨나요?', body: '용마산 7호선 · 06:27 중곡 방면 장암행 열차', sound: 'default' });
  });

  it('hop-end: nextLine을 canonical 노선명으로, body를 싣고 trainInfo는 생략', async () => {
    const { calls, impl } = makeFetch([{ status: 200 }]);
    await fire(makeTrip(), impl, undefined, {
      phase: 'hop-end',
      station: '건대입구',
      line: '7',
      nextLine: '2',
      title: '건대입구에서 내리셨나요?',
      trainInfo: undefined,
      body: '2호선 성수 방면으로 갈아타세요',
    });
    const { aps } = JSON.parse(String(calls[0].init.body));
    expect(aps['content-state']).toEqual({
      phase: 'hop-end',
      originStation: '건대입구',
      line: '7호선',
      lineName: '7호선',
      lineColorHex: '#747F00',
      title: '건대입구에서 내리셨나요?',
      body: '2호선 성수 방면으로 갈아타세요',
      nextLine: '2호선',
    });
    expect(aps.attributes.promptId).toBe(`hop-end-${NOW}`);
  });

  it('split이 아니거나 token이 없으면 아무것도 보내지 않는다', async () => {
    const { calls, impl } = makeFetch([{ status: 200 }]);
    expect(await fire(makeTrip({ laClient: undefined }), impl)).toEqual({ sent: false, dirty: false });
    expect(await fire(makeTrip({ boardingPushToStartToken: undefined }), impl)).toEqual({ sent: false, dirty: false });
    expect(calls).toEqual([]);
  });

  it('D1 trip_events에 kind=la-boarding-start 1행 (path, phase, status) — KV 쓰기 0', async () => {
    const { impl } = makeFetch([{ status: 200 }]);
    const { rows, db } = makeDb();
    await fire(makeTrip(), impl, db);
    expect(rows).toHaveLength(1);
    const [, ts, kind, station, line, meta] = rows[0];
    expect(ts).toBe(NOW);
    expect(kind).toBe('la-boarding-start');
    expect(station).toBe('용마산');
    expect(line).toBe('7');
    expect(JSON.parse(String(meta))).toEqual({ path: 'boarding-prompt', phase: 'pre-boarding', status: 200, ok: true });
  });

  it('APNs 실패(500): sent=false, D1에 실패 status/reason 기록, token은 유지', async () => {
    const { impl } = makeFetch([{ status: 500, body: { reason: 'InternalServerError' } }]);
    const { rows, db } = makeDb();
    const trip = makeTrip();
    const result = await fire(trip, impl, db);
    expect(result).toEqual({ sent: false, dirty: false });
    expect(trip.boardingPushToStartToken).toBe('pts-token-abc');
    expect(JSON.parse(String(rows[0][5]))).toEqual({
      path: 'boarding-prompt',
      phase: 'pre-boarding',
      status: 500,
      ok: false,
      reason: 'InternalServerError',
    });
  });

  it('410 Unregistered: token을 비우고 dirty=true (죽은 token으로 매번 재시도하지 않는다)', async () => {
    const { impl } = makeFetch([{ status: 410, body: { reason: 'Unregistered' } }]);
    const trip = makeTrip();
    const result = await fire(trip, impl);
    expect(result).toEqual({ sent: false, dirty: true });
    expect(trip.boardingPushToStartToken).toBeUndefined();
  });

  it('env 불일치(400 BadDeviceToken) -> 반대 host 재시도 성공: sent=true, trip.apnsEnv 정정, dirty=true', async () => {
    const { calls, impl } = makeFetch([
      { status: 400, body: { reason: 'BadDeviceToken' } },
      { status: 200 },
    ]);
    const trip = makeTrip({ apnsEnv: 'sandbox' });
    const result = await fire(trip, impl);
    expect(result).toEqual({ sent: true, dirty: true });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['api.sandbox.push.apple.com', 'api.push.apple.com']);
    expect(trip.apnsEnv).toBe('production');
  });
});

describe('buildStationArrivedContentState — 매역 도착 DI 축소 표시용 여정 content', () => {
  const trip = makeTrip({
    destination: '뚝섬',
    waypoints: [
      { stationName: '군자(능동)', line: '7', kind: 'intermediate', remainingSecToDest: 780 },
      { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate', remainingSecToDest: 600 },
      { stationName: '건대입구', line: '7', kind: 'transfer', remainingSecToDest: 420 },
      { stationName: '성수', line: '2', kind: 'intermediate', remainingSecToDest: 240 },
      { stationName: '뚝섬', line: '2', kind: 'destination', remainingSecToDest: 0 },
    ],
  });
  const arrived: Waypoint = trip.waypoints[0];

  it('arrivedStationName=그 역, 만료=now+표시시간(초), stationName=그 역', () => {
    const cs = buildStationArrivedContentState(trip, arrived, NOW);
    expect(cs.arrivedStationName).toBe('군자(능동)');
    expect(cs.arrivedUntilEpochSec).toBe(Math.floor(NOW / 1000) + STATION_ARRIVED_DISPLAY_SEC);
    expect(cs.stationName).toBe('군자(능동)');
  });

  it('남은 값은 그 역을 지난 뒤 기준: etaMinutes=목적지까지(13분), 환승까지 정거장 2역(어대·건대입구), stopsRemaining=4', () => {
    const cs = buildStationArrivedContentState(trip, arrived, NOW);
    expect(cs.etaMinutes).toBe(13);
    expect(cs.transferStationName).toBe('건대입구');
    expect(cs.stopsToTransfer).toBe(2);
    expect(cs.stopsRemaining).toBe(4);
  });

  it('질문 필드(boarding*)는 싣지 않는다 (split 여정 content 규칙)', () => {
    const keys = Object.keys(buildStationArrivedContentState(trip, arrived, NOW)).filter((k) => k.startsWith('boarding'));
    expect(keys).toEqual([]);
  });

  it('trip 객체를 변형하지 않는다 (waypoints 그대로)', () => {
    const before = JSON.stringify(trip.waypoints);
    buildStationArrivedContentState(trip, arrived, NOW);
    expect(JSON.stringify(trip.waypoints)).toBe(before);
  });

  it('waypoints가 이미 shift돼 head가 그 역이 아니면(sync-skipped) 전체 waypoints를 남은 구간으로 쓴다', () => {
    const shifted = { ...trip, waypoints: trip.waypoints.slice(1) };
    const cs = buildStationArrivedContentState(shifted, arrived, NOW);
    expect(cs.stopsToTransfer).toBe(2);
    expect(cs.arrivedStationName).toBe('군자(능동)');
  });
});
