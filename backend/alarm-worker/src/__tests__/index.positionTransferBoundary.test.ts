/**
 * #3350 PR-2 (리뷰 F2) — BG 경로. 취침 모드는 화면 잠금이 기본이라 `/boarding-lock/sync`(FG 전용)가 아니라 `POST /position`만 도착한다.
 * lockless trip이 `currentStationName`으로 환승 경계(마지막 소비 waypoint가 transfer)를 관측하면 sync 경로와 같은 소비·anchor stamp를 한다.
 * 입력 route는 11/12 b00dd879 실측(D1 2415 existingSig). 소비 0 유지: intermediate / destination / 활성 lock / 관측역 미동봉.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { resetApnsJwtCache } from '../apns';
import { getTrip, putTrip } from '../trips';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { loadD1Events, makeTripEventSink, parseRouteSig, routeSigOf } from './helpers/replay20261019';

const NOW = 1_794_471_000_000;
const rows = loadD1Events('replay_20261112_leg2_transfer_boundary', 'events.json');
const row2415 = rows.find((r) => r.id === 2415);
if (!row2415) throw new Error('D1 행 2415이 fixture에 없다');
const ROUTE = parseRouteSig(routeSigOf(row2415, 'existingSig'));
const NAMES = ROUTE.map((w) => w.stationName);
const TRANSFER = ROUTE.find((w) => w.kind === 'transfer')!;
const TRANSFER_IDX = ROUTE.findIndex((w) => w.kind === 'transfer');
const LEG2_FIRST = ROUTE[TRANSFER_IDX + 1];
const INTERMEDIATE = ROUTE[0];
const DESTINATION = ROUTE[ROUTE.length - 1];
const TOKEN = 'idx-3350-position';

describe('POST /position — BG lockless 환승 경계 관측 소비 (#3350 PR-2)', () => {
  let kv: InMemoryKV;
  let env: Env;
  let apnsPem: string;

  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('ES256');
    apnsPem = await exportPKCS8(privateKey);
  });

  beforeEach(() => {
    resetApnsJwtCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    kv = new InMemoryKV();
    env = {
      TRIPS: kv as unknown as KVNamespace,
      DB: makeTripEventSink().db,
      APNS_HOST: 'api.push.apple.com',
      APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
      SEOUL_API_HOST: 'seoul.api',
      SEOUL_API_KEY: 'KEY',
      APNS_KEY_ID: 'K',
      APNS_TEAM_ID: 'T',
      APNS_PRIVATE_KEY: apnsPem,
      APNS_BUNDLE_ID: 'com.example.app',
    } as Env;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function seed(extra: Partial<Trip> = {}) {
    await putTrip(kv as unknown as KVNamespace, {
      token: TOKEN,
      route: { type: 'transfer', transferName: TRANSFER.stationName, fromLine: TRANSFER.line, toLine: LEG2_FIRST.line, stops: 5, stopsToTransfer: TRANSFER_IDX + 1, stopsFromTransfer: 3 } as unknown as Trip['route'],
      destination: DESTINATION.stationName,
      waypoints: ROUTE.map((w) => ({ ...w })),
      expiresAt: NOW + 3_600_000,
      createdAt: NOW - 600_000,
      alarmAtEpochMs: NOW,
      infoModeEnabled: true,
      ...extra,
    } as Trip);
  }

  async function position(currentStationName?: string) {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const res = await app.fetch(
      new Request('http://example.com/position', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: TOKEN, lat: 37.54, lng: 127.07, accuracy: 20, ts: NOW, motion: 'unknown', appState: 'bg',
          ...(currentStationName !== undefined ? { currentStationName } : {}),
        }),
      }),
      env,
      ctx,
    );
    await Promise.all(waits);
    return { res, trip: await getTrip(kv as unknown as KVNamespace, TOKEN) };
  }

  it('★lockless + 환승역(건대입구) 관측 -> 환승 소비, anchor={환승역, leg-2 노선}, head=leg-2 첫 역', async () => {
    await seed();
    const { res, trip } = await position(TRANSFER.stationName);
    expect(res.status).toBe(200);
    expect(trip?.currentLegAnchor).toEqual({ boardingStation: TRANSFER.stationName, line: LEG2_FIRST.line });
    expect(trip?.waypoints[0]?.stationName).toBe(LEG2_FIRST.stationName);
  });

  it('거부: 환승 전 intermediate 관측은 소비 0', async () => {
    await seed();
    const { trip } = await position(INTERMEDIATE.stationName);
    expect(trip?.waypoints.map((w) => w.stationName)).toEqual(NAMES);
    expect(trip?.currentLegAnchor).toBeUndefined();
  });

  it('거부: destination 관측은 소비 0', async () => {
    await seed();
    const { trip } = await position(DESTINATION.stationName);
    expect(trip?.waypoints.map((w) => w.stationName)).toEqual(NAMES);
  });

  it('거부: currentStationName 미동봉(기존 BG 업로드)은 소비 0', async () => {
    await seed();
    const { trip } = await position();
    expect(trip?.waypoints.map((w) => w.stationName)).toEqual(NAMES);
    expect(trip?.currentLegAnchor).toBeUndefined();
  });

  it('거부: 활성 lock trip의 /position 관측은 이 경로로 소비하지 않는다(lockless 한정)', async () => {
    await seed({
      boardingLock: { trainCode: '2336', line: TRANSFER.line, expiresAt: NOW + 3_600_000 } as unknown as Trip['boardingLock'],
    });
    const { trip } = await position(TRANSFER.stationName);
    expect(trip?.waypoints.map((w) => w.stationName)).toEqual(NAMES);
    expect(trip?.currentLegAnchor).toBeUndefined();
  });
});
