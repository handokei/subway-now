/**
 * #3055 / #3300 옵션 D PR-5 후속 — claim 선점이 applied인 **모든** 발사에 "retry once"를 적용한다 (사용자 결정 2026-11-09, ADR-055).
 *
 * #3348은 매역 station-passed push에만 같은 tick 1회 재전송(`sendWithClaimRetry`)을 넣었다. 그러나 claim-then-fire(#3338)는 `progress@N`에서
 * 환승 해제 push·취침 알람(alert+companion)·"하차했나요?" 프롬프트·종료 alert에도 똑같이 걸려 있고, 선점 뒤 전송이 transient(429/5xx)로 실패하면
 * head가 이미 전진해 다음 tick이 같은 발사를 다시 만들 수 없다(= 유실). 이 파일은 발사 지점마다 같은 5가지 계약을 고정한다:
 *   1. 선점 applied + 첫 전송 5xx  -> 같은 tick에 정확히 1회 재전송, 성공
 *   2. 첫 전송 성공               -> 재전송 0
 *   3. 재전송도 실패              -> 3번째 시도 0 (기존 fallback 큐는 그대로)
 *   4. 영구 오류(400)             -> 재전송 0
 *   5. control(lock@1, legacy)    -> 현행 유지(재전송 0)
 */
import { describe, expect, it } from 'vitest';
import {
  advanceBoardingLockWaypoint,
  completeWaypointAdvance,
  createEmptyScheduledStats,
  runLocklessIntermediate,
  type ScheduledDeps,
} from '../scheduled';
import { getTrip, putTrip } from '../trips';
import { resetCellStageCache } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import type { BoardingLockMeta, Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';
import { SeoulArrivalClient } from '../seoul';
import { APNS_HOSTS, fakeD1, getApnsConfig, makeEnv, makeLock, makeTrip, NOW, TOKEN, useApnsHarness, wp } from './helpers/sleepAlarmHarness';

useApnsHarness();

type PushKind = 'sleep-alert' | 'sleep-companion' | 'trip-ended' | 'hop-end' | 'transfer-release' | 'other';
type Plan = Partial<Record<PushKind, number[]>>;

const kindOf = (headers: Record<string, string>, rawBody: string): PushKind => {
  if (headers['apns-push-type'] === 'alert' && (headers['apns-collapse-id'] ?? '').startsWith('alarm-')) return 'sleep-alert';
  if (rawBody.includes('"sleep-alarm-companion"')) return 'sleep-companion';
  if (rawBody.includes('"trip-ended"')) return 'trip-ended';
  if (rawBody.includes('hopEndKind')) return 'hop-end';
  if (rawBody.includes('lockReleasedReason')) return 'transfer-release';
  return 'other';
};

/** 종류별로 시도 순서대로 status를 돌려주는 APNs fetch. plan에 없거나 소진되면 200. */
function scriptedFetch(plan: Plan) {
  const attempts: Partial<Record<PushKind, number[]>> = {};
  const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const kind = kindOf(init?.headers ?? {}, String(init?.body ?? ''));
    const seen = (attempts[kind] ??= []);
    const status = plan[kind]?.[seen.length] ?? 200;
    seen.push(status);
    return new Response(status === 200 ? '' : `{"reason":"${status >= 500 ? 'InternalServerError' : 'BadRequest'}"}`, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, attempts };
}

const leg1Lock = (): BoardingLockMeta => ({
  trainCode: '3334',
  line: '2',
  subwayId: '1002',
  selectedDepartureTime: NOW,
  segmentStations: ['뚝섬', '성수', '건대입구'],
  expiresAt: NOW + 3 * 60 * 60_000,
});

const withRoute = (trip: Trip): Trip => ({ ...trip, routeWaypoints: trip.waypoints });

interface SiteCtx {
  env: Env;
  deps: ScheduledDeps;
  pending: InMemoryKV;
  fired: Partial<Record<PushKind, number[]>>;
  stats: ReturnType<typeof createEmptyScheduledStats>;
}

interface Site {
  name: string;
  kind: PushKind;
  /** 재시도가 끝내 실패하면 기존 fallback 큐(PENDING_PUSHES)에 적재되는 발사인지. */
  queuedOnFinalFailure: boolean;
  trip: () => Trip;
  run: (trip: Trip, ctx: SiteCtx) => Promise<unknown>;
  seed?: (kv: InMemoryKV) => Promise<void>;
}

const noop = () => undefined;
const complete = (trip: Trip, c: SiteCtx) =>
  completeWaypointAdvance(trip, trip.waypoints[0], c.env, c.deps, c.stats, NOW, noop, () => 'p', 'lock-active-waypoints-exhausted');

const TRANSFER_ROUTE: Waypoint[] = [wp('건대입구', 'transfer', '2'), wp('어린이대공원', 'intermediate', '7'), wp('군자', 'destination', '7')];
const transferTrip = (overrides: Partial<Trip> = {}): Trip =>
  withRoute(makeTrip(TRANSFER_ROUTE, { sleepModeEnabled: false, boardingLock: leg1Lock(), ...overrides }));
const SLEEP_ROUTE: Waypoint[] = [wp('군자', 'intermediate'), wp('건대입구', 'transfer'), wp('어린이대공원', 'destination')];
const LAST_ROUTE: Waypoint[] = [wp('군자', 'intermediate')];
const DEST_ROUTE: Waypoint[] = [wp('군자', 'destination')];

const SITES: Site[] = [
  {
    name: 'completeWaypointAdvance — 환승 해제 silent push (transfer-release)',
    kind: 'transfer-release',
    queuedOnFinalFailure: true,
    trip: () => transferTrip(),
    run: (trip, c) => complete(trip, c),
  },
  {
    name: 'completeWaypointAdvance -> maybeFireHopEndPrompt ("하차했나요?")',
    kind: 'hop-end',
    queuedOnFinalFailure: false,
    trip: () => transferTrip({ promptOptIn: true }),
    run: (trip, c) => complete(trip, c),
  },
  {
    name: 'completeWaypointAdvance -> maybeFireSleepAlarm 주 채널 alert',
    kind: 'sleep-alert',
    queuedOnFinalFailure: true,
    trip: () => withRoute(makeTrip(SLEEP_ROUTE)),
    run: (trip, c) => complete(trip, c),
  },
  {
    name: 'completeWaypointAdvance -> maybeFireSleepAlarm companion silent',
    kind: 'sleep-companion',
    queuedOnFinalFailure: true,
    trip: () => withRoute(makeTrip(SLEEP_ROUTE)),
    run: (trip, c) => complete(trip, c),
  },
  {
    name: 'completeWaypointAdvance waypoints 소진 -> cleanupTripWithLa 종료 alert',
    kind: 'trip-ended',
    queuedOnFinalFailure: false,
    trip: () => withRoute(makeTrip(LAST_ROUTE, { sleepModeEnabled: false })),
    run: (trip, c) => complete(trip, c),
  },
  {
    name: 'advanceBoardingLockWaypoint destination(lock 활성) -> cleanupTripWithLa 종료 alert',
    kind: 'trip-ended',
    queuedOnFinalFailure: false,
    trip: () => withRoute(makeTrip(DEST_ROUTE, { sleepModeEnabled: false, boardingLock: makeLock(['건대입구', '군자']) })),
    run: (trip, c) =>
      advanceBoardingLockWaypoint(trip, trip.waypoints[0], c.env, c.deps, c.stats, NOW, noop, undefined, () => 'p', async () => undefined),
  },
  {
    name: 'runLocklessIntermediate 마지막 역 통과(lockless-shift-empty) -> cleanupTripWithLa 종료 alert',
    kind: 'trip-ended',
    queuedOnFinalFailure: false,
    trip: () => withRoute(makeTrip(LAST_ROUTE, { sleepModeEnabled: false, boardingLock: undefined, infoModeEnabled: true, originStationName: '건대입구' })),
    run: (trip, c) => runLocklessIntermediate(trip, trip.waypoints[0], c.env, c.deps, c.stats, NOW, noop, () => 'p'),
    seed: async (kv) => {
      const point = (ts: number, lng: number) => ({ lat: 0, lng, accuracy: 10, ts, motion: 'automotive' });
      await kv.put(`pos:${TOKEN}`, JSON.stringify([point(NOW - 40_000, 0), point(NOW - 20_000, 0.0002), point(NOW, 0.0004)]));
    },
  },
];

/** 해당 역 도착(arvlCd=1) + ETA 30초 — lockless 경로가 발사 신호로 인정하려면 ETA가 알려져 있어야 한다(#3132). */
const arrivingSeoul = (station: string) =>
  new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('/realtimePosition/')
            ? { realtimePositionList: [] }
            : { realtimeArrivalList: [{ barvlDt: '30', recptnDt: '', updnLine: '상행', trainLineNm: station, btrainNo: '7246', subwayNm: '지하철7호선', arvlCd: '1' }] },
        ),
        { status: 200 },
      )) as unknown as typeof fetch,
  });

async function exercise(site: Site, flag: string, plan: Plan) {
  const kv = new InMemoryKV(() => NOW);
  const pending = new InMemoryKV(() => NOW);
  const doNs = makeFakeTripDoNamespace();
  const env = { ...makeEnv(kv, fakeD1().db, pending), TRIP_DO: doNs.ns } as Env;
  await setTripDoFlag(env.TRIPS, flag);
  resetCellStageCache(kv);
  await putTrip(kv as unknown as KVNamespace, site.trip());
  await site.seed?.(kv);
  const { fetchImpl, attempts } = scriptedFetch(plan);
  const deps = { seoul: arrivingSeoul(site.trip().waypoints[0].stationName), apnsConfig: getApnsConfig(), apnsHosts: APNS_HOSTS, fetchImpl, now: () => NOW } as ScheduledDeps;
  const ctx: SiteCtx = { env, deps, pending, fired: attempts, stats: createEmptyScheduledStats(NOW) };
  const trip = (await getTrip(env, TOKEN)) as Trip;
  await site.run(trip, ctx);
  return { attempts: attempts[site.kind] ?? [], queued: pending.store.size };
}

describe.each(SITES)('#3055 PR-5 후속 retry once — $name', (site) => {
  it('progress@1: 첫 전송 500 -> 같은 tick 재전송 1회로 성공 (총 2회)', async () => {
    const r = await exercise(site, 'progress@1', { [site.kind]: [500, 200] });
    expect(r.attempts).toEqual([500, 200]);
  });

  it('progress@1: 첫 전송 성공 -> 재전송 0 (1회)', async () => {
    const r = await exercise(site, 'progress@1', { [site.kind]: [200] });
    expect(r.attempts).toEqual([200]);
  });

  it('progress@1: 재전송도 500 -> 3번째 시도 없음(2회), 기존 fallback 큐 동작 유지', async () => {
    const r = await exercise(site, 'progress@1', { [site.kind]: [500, 500, 500, 500] });
    expect(r.attempts).toEqual([500, 500]);
    expect(r.queued > 0).toBe(site.queuedOnFinalFailure);
  });

  it('progress@1: 영구 오류(400)는 재시도하지 않는다 (1회)', async () => {
    const r = await exercise(site, 'progress@1', { [site.kind]: [400, 200] });
    expect(r.attempts).toEqual([400]);
  });

  it('control(lock@1, legacy): 첫 전송 500이어도 같은 tick 재전송 없음 (1회)', async () => {
    const r = await exercise(site, 'lock@1', { [site.kind]: [500, 200] });
    expect(r.attempts).toEqual([500]);
  });
});
