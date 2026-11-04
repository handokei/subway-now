/**
 * #3055 / #3300 옵션 D PR-4b — HTTP 쪽을 DO 진행 셀에 연결한 효과(sync 전진 / confirm 탭 전진 / register).
 *
 * 노선·시각은 11/03 라이드(뚝섬 -> 건대입구 환승 -> 군자) 실측 형태를 따른다(`tripDoCellsHttp.test.ts`와 같은 seed).
 * flag `lock@1`은 진행 셀을 전혀 건드리지 않는다(롤백 시 progress KV 맞춤이 살아남는 전제) — DO 요청 경로로 증명한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { getTrip } from '../trips';
import { fetchCells, resetCellStageCache, runProgressOp } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import type { Env, Trip } from '../types';
import { waypointSignatureKey } from '../trips';
import { CacheLagKV } from './helpers/cacheLagKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';
import { captureFetch, getApnsConfig, useApnsHarness } from './helpers/sleepAlarmHarness';

useApnsHarness();

const TOKEN = 'progress-3055-tok';
const kstMs = (iso: string): number => Date.parse(`${iso}+09:00`);
const HOUR_MS = 60 * 60_000;
const CREATED = kstMs('2026-11-03T18:00:00');

const WAYPOINTS: Trip['waypoints'] = [
  { stationName: '건대입구', line: '2', kind: 'transfer' },
  { stationName: '어린이대공원', line: '7', kind: 'intermediate' },
  { stationName: '군자', line: '7', kind: 'destination' },
];
const lock = (trainCode = '3334') => ({
  trainCode,
  line: '2',
  subwayId: '1002',
  selectedDepartureTime: CREATED,
  segmentStations: ['뚝섬', '성수', '건대입구'],
  expiresAt: CREATED + HOUR_MS,
});

function seedTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 2 } as unknown as Trip['route'],
    destination: '군자',
    waypoints: WAYPOINTS,
    routeWaypoints: WAYPOINTS,
    expiresAt: CREATED + 3 * HOUR_MS,
    createdAt: CREATED,
    alarmAtEpochMs: CREATED,
    infoModeEnabled: true,
    boardingLock: lock(),
    ...overrides,
  };
}

interface Ctx {
  env: Env;
  kv: CacheLagKV;
  doNs: ReturnType<typeof makeFakeTripDoNamespace>;
  paths: string[];
}

async function makeCtx(flag: string): Promise<Ctx> {
  const kv = new CacheLagKV(0, { byCacheTtl: { defaultTtlSec: 60, laggedPrefixes: ['trip:'] } });
  const doNs = makeFakeTripDoNamespace();
  const paths: string[] = [];
  const recording = {
    idFromName: (name: string) => doNs.ns.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = doNs.ns.get(id);
      return {
        fetch: (request: Request): Promise<Response> => {
          paths.push(new URL(request.url).pathname);
          return stub.fetch(request);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  const env = {
    TRIPS: kv as unknown as KVNamespace,
    TRIP_DO: recording,
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: getApnsConfig().keyId,
    APNS_TEAM_ID: getApnsConfig().teamId,
    APNS_PRIVATE_KEY: getApnsConfig().privateKeyPem,
    APNS_BUNDLE_ID: getApnsConfig().bundleId,
  } as Env;
  await setTripDoFlag(env.TRIPS, flag);
  resetCellStageCache(kv);
  return { env, kv, doNs, paths };
}

const post = async (path: string, body: unknown, env: Env): Promise<Response> =>
  app.fetch(
    new Request(`http://example.com${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    env,
  );

const syncAt = (env: Env, station: string): Promise<Response> =>
  post('/boarding-lock/sync', { token: TOKEN, observedStationName: station, observedAtMs: Date.now(), accuracy: 20 }, env);

const names = (waypoints: Trip['waypoints'] | undefined): string[] => (waypoints ?? []).map((w) => w.stationName);

/** KV 최신 blob(캐시 지연 무시). */
const latestKv = (kv: CacheLagKV): Trip | undefined => {
  const raw = (kv as unknown as { store: Map<string, { value: string }> }).store.get(`trip:${TOKEN}`)?.value;
  return raw === undefined ? undefined : (JSON.parse(raw) as Trip);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(kstMs('2026-11-03T18:10:00'));
  vi.stubGlobal('fetch', captureFetch().fetchImpl);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function withTrip(flag: string, trip: Trip): Promise<Ctx> {
  const ctx = await makeCtx(flag);
  await ctx.kv.put(`trip:${TOKEN}`, JSON.stringify(trip));
  vi.setSystemTime(kstMs('2026-11-03T18:12:00'));
  return ctx;
}

describe('#3055 PR-4b — sync(환승 소비, sync-mixed): 진행 셀이 권위', () => {
  it('progress@1: 환승 소비가 셀 head를 정확히 한 칸 전진하고 lock 셀도 같은 op로 풀린다 (자기 충돌 없음)', async () => {
    const ctx = await withTrip('progress@1', seedTrip());
    const res = await syncAt(ctx.env, '건대입구');
    expect(res.status).toBe(200);
    const { progress, lock: lockCell } = await fetchCells(ctx.env, TOKEN);
    expect(names(progress?.waypoints)).toEqual(['어린이대공원', '군자']);
    expect(lockCell?.lock).toBeUndefined();
    // 요청이 끝난 뒤 KV blob도 같은 진행(자기 쓰기로 되감지 않음).
    expect(names(latestKv(ctx.kv)?.waypoints)).toEqual(['어린이대공원', '군자']);
  });

  it('progress@1: 같은 sync를 다시 보내도 다시 소비하지 않는다(head 키 선점 — 이미 지난 head는 noop)', async () => {
    const ctx = await withTrip('progress@1', seedTrip());
    await syncAt(ctx.env, '건대입구');
    const before = (await fetchCells(ctx.env, TOKEN)).progress;
    vi.setSystemTime(kstMs('2026-11-03T18:12:05'));
    await syncAt(ctx.env, '건대입구');
    const after = (await fetchCells(ctx.env, TOKEN)).progress;
    expect(names(after?.waypoints)).toEqual(['어린이대공원', '군자']);
    expect(after?.rev).toBe(before?.rev);
  });

  it('lock@1: 진행 셀 경로(/progress)를 전혀 호출하지 않고 KV waypoints로 현행 그대로 전진한다', async () => {
    const ctx = await withTrip('lock@1', seedTrip());
    const res = await syncAt(ctx.env, '건대입구');
    expect(res.status).toBe(200);
    expect(ctx.paths.filter((p) => p.startsWith('/progress'))).toEqual([]);
    expect(names(latestKv(ctx.kv)?.waypoints)).toEqual(['어린이대공원', '군자']);
  });
});

describe('#3055 PR-4b — register: 같은 세션 재등록은 진행 셀을 덮지 않는다', () => {
  it('progress@1: 셀이 앞선 뒤 낡은 incoming waypoints(전체 노선)로 재등록해도 head가 되감기지 않는다', async () => {
    const ctx = await withTrip('progress@1', seedTrip({ boardingLock: undefined }));
    // 환승 소비 후 셀 head = 어린이대공원.
    await getTrip(ctx.env, TOKEN); // 셀 시드
    await runProgressOp(
      ctx.env,
      TOKEN,
      { type: 'advanceHead', source: 'test', expectedHeadKey: waypointSignatureKey(WAYPOINTS[0]), count: 1 },
      Date.now(),
    );
    const res = await post(
      '/trips',
      {
        token: TOKEN,
        deviceToken: TOKEN,
        destination: '군자',
        route: { type: 'direct', line: '2', stops: 2 },
        waypoints: WAYPOINTS,
        expiresAt: CREATED + 3 * HOUR_MS,
        createdAt: CREATED,
        alarmAtEpochMs: CREATED,
        infoModeEnabled: true,
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const { progress } = await fetchCells(ctx.env, TOKEN);
    expect(names(progress?.waypoints)).toEqual(['어린이대공원', '군자']);
    expect(names(latestKv(ctx.kv)?.waypoints)).toEqual(['어린이대공원', '군자']);
  });

  const registerBody = (waypoints: Trip['waypoints'], createdAt: number) => ({
    token: TOKEN,
    deviceToken: TOKEN,
    destination: waypoints[waypoints.length - 1].stationName,
    route: { type: 'direct', line: waypoints[0].line, stops: waypoints.length },
    waypoints,
    expiresAt: CREATED + 3 * HOUR_MS,
    createdAt,
    alarmAtEpochMs: createdAt,
    infoModeEnabled: true,
  });

  it('progress@1: 신규 trip 등록은 진행 셀을 incoming waypoints로 초기화한다(빈 셀로 overlay되지 않는다)', async () => {
    const ctx = await makeCtx('progress@1');
    const res = await post('/trips', registerBody(WAYPOINTS, CREATED), ctx.env);
    expect(res.status).toBe(200);
    const { progress } = await fetchCells(ctx.env, TOKEN);
    expect(names(progress?.waypoints)).toEqual(['건대입구', '어린이대공원', '군자']);
    vi.setSystemTime(kstMs('2026-11-03T18:12:00'));
    expect(names((await getTrip(ctx.env, TOKEN))?.waypoints)).toEqual(['건대입구', '어린이대공원', '군자']);
  });

  it('progress@1: 다른 세션(노선·createdAt 변경) 재등록은 진행 셀을 새 incoming으로 재초기화한다', async () => {
    const ctx = await withTrip('progress@1', seedTrip({ boardingLock: undefined }));
    await getTrip(ctx.env, TOKEN); // 셀 시드(이전 세션)
    const newRoute: Trip['waypoints'] = [
      { stationName: '성수', line: '2', kind: 'intermediate' },
      { stationName: '잠실', line: '2', kind: 'destination' },
    ];
    const res = await post('/trips', registerBody(newRoute, CREATED + 30 * 60_000), ctx.env);
    expect(res.status).toBe(200);
    const { progress } = await fetchCells(ctx.env, TOKEN);
    expect(names(progress?.waypoints)).toEqual(['성수', '잠실']);
    expect(progress?.session.createdAt).toBe(CREATED + 30 * 60_000);
  });
});

