/**
 * #3055 / #3300 옵션 D PR-4b — claim-then-fire: `completeWaypointAdvance`·`advanceBoardingLockWaypoint`(destination)·`catchUpToLockTrain`은
 * 진행 셀에서 head를 **먼저 선점**하고 applied일 때만 발사한다(plan §4 PR-4a/4b "순서 변경").
 *
 * 재소비 재현: 같은 환승 waypoint를 낡은 스냅샷(KV 60s 캐시 / 다른 경로가 이미 소비)으로 다시 완료 평가하면, flag가 lock@N(셀이 진행을 모름)에서는
 * 환승 해제 silent push가 또 나간다(control — 이 테스트가 결함을 실제로 보는지 증명). progress@N에서는 head 선점이 noop이라 발사 0이다.
 * revert-red: `completeWaypointAdvance`의 claim을 제거하면 progress@N 케이스가 control과 같이 push가 늘어 실패한다.
 */
import { describe, expect, it } from 'vitest';
import { advanceBoardingLockWaypoint, completeWaypointAdvance, createEmptyScheduledStats, type ScheduledDeps } from '../scheduled';
import { getTrip, putTrip } from '../trips';
import { fetchCells, resetCellStageCache, CellUnavailableError } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';
import {
  APNS_HOSTS,
  captureFetch,
  getApnsConfig,
  makeEnv,
  makeLock,
  NOW,
  seoulWith,
  TOKEN,
  useApnsHarness,
  wp,
} from './helpers/sleepAlarmHarness';

useApnsHarness();

/** leg-1(2호선) lock — 환승 waypoint(건대입구) 통과가 이 lock을 해제한다. */
const leg1Lock = (): BoardingLockMeta => ({
  trainCode: '3334',
  line: '2',
  subwayId: '1002',
  selectedDepartureTime: NOW,
  segmentStations: ['뚝섬', '성수', '건대입구'],
  expiresAt: NOW + 3 * 60 * 60_000,
});

const TRANSFER_ROUTE = [wp('건대입구', 'transfer', '2'), wp('어린이대공원', 'intermediate', '7'), wp('군자', 'destination', '7')];

function tripOf(waypoints = TRANSFER_ROUTE): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: waypoints.length },
    destination: waypoints[waypoints.length - 1].stationName,
    waypoints,
    routeWaypoints: waypoints,
    expiresAt: NOW + 3 * 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW - 60_000,
    boardingLock: leg1Lock(),
  } as Trip;
}

async function setup(flag: string, trip: Trip = tripOf()) {
  const kv = new InMemoryKV(() => NOW);
  const doNs = makeFakeTripDoNamespace();
  const env = { ...makeEnv(kv), TRIP_DO: doNs.ns } as Env;
  await setTripDoFlag(env.TRIPS, flag);
  resetCellStageCache(kv);
  await putTrip(kv as unknown as KVNamespace, trip);
  const fetched = captureFetch();
  const deps = {
    seoul: seoulWith('건대입구', 1),
    apnsConfig: getApnsConfig(),
    apnsHosts: APNS_HOSTS,
    fetchImpl: fetched.fetchImpl,
    now: () => NOW,
  } as ScheduledDeps;
  return { kv, env, doNs, fetched, deps };
}

/** 낡은 스냅샷 = KV에서 막 읽은 trip(overlay 전) 모양을 흉내 — 셀이 앞서 있어도 이 객체는 옛 head를 들고 있다. */
const staleSnapshot = (): Trip => tripOf();

const complete = (c: Awaited<ReturnType<typeof setup>>, trip: Trip) =>
  completeWaypointAdvance(trip, trip.waypoints[0], c.env, c.deps, createEmptyScheduledStats(NOW), NOW, () => undefined, () => 'p', 'lock-active-waypoints-exhausted');

describe('#3055 PR-4b — completeWaypointAdvance claim-then-fire (환승 waypoint 재소비)', () => {
  it('control(lock@1): 낡은 스냅샷으로 같은 환승을 다시 완료 평가하면 환승 해제 push가 또 나간다 (재소비 결함 재현)', async () => {
    const c = await setup('lock@1');
    const first = (await getTrip(c.env, TOKEN)) as Trip;
    await complete(c, first);
    const afterFirst = c.fetched.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    await complete(c, staleSnapshot());
    expect(c.fetched.calls.length).toBeGreaterThan(afterFirst);
  });

  it('progress@1: 첫 소비는 셀 head를 한 칸 전진하고 lock을 같은 op로 풀며 push가 나간다', async () => {
    const c = await setup('progress@1');
    const first = (await getTrip(c.env, TOKEN)) as Trip;
    const result = await complete(c, first);
    expect(result).toEqual({ tripEnded: false, consumed: true });
    const { progress, lock } = await fetchCells(c.env, TOKEN);
    expect(progress?.waypoints.map((w) => w.stationName)).toEqual(['어린이대공원', '군자']);
    expect(lock?.lock).toBeUndefined();
    expect(c.fetched.calls.length).toBeGreaterThan(0);
    // 메모리 trip도 셀 결과(전진 + 해제)를 반영한다.
    expect(first.waypoints.map((w) => w.stationName)).toEqual(['어린이대공원', '군자']);
    expect(first.boardingLock).toBeUndefined();
  });

  it('progress@1: 낡은 스냅샷 재소비는 noop — 발사 0, 셀·lock 불변 (consumed:false)', async () => {
    const c = await setup('progress@1');
    await complete(c, (await getTrip(c.env, TOKEN)) as Trip);
    const afterFirst = c.fetched.calls.length;
    const before = await fetchCells(c.env, TOKEN);
    const stale = staleSnapshot();
    const again = await complete(c, stale);
    expect(again).toEqual({ tripEnded: false, consumed: false });
    expect(c.fetched.calls.length).toBe(afterFirst);
    expect(await fetchCells(c.env, TOKEN)).toEqual(before);
    // 낡은 객체는 변경되지 않는다(되감기·부분 반영 없음).
    expect(stale.waypoints).toHaveLength(3);
  });

  it('progress@1: DO 오류는 발사 전에 throw — push 0 (HTTP 호출자는 503으로 매핑)', async () => {
    const c = await setup('progress@1');
    const first = (await getTrip(c.env, TOKEN)) as Trip;
    c.doNs.ns.get = () => {
      throw new Error('do down');
    };
    await expect(complete(c, first)).rejects.toBeInstanceOf(CellUnavailableError);
    expect(c.fetched.calls).toEqual([]);
  });

  it('progress@1: 환승 해제 rev가 낡으면(그 사이 사용자 부착) 전진은 하되 lock은 유지된다', async () => {
    const c = await setup('progress@1');
    const first = (await getTrip(c.env, TOKEN)) as Trip;
    // 사용자가 그 사이 lock을 바꿔 rev가 올랐다(셀 lock은 새 번호).
    await c.doNs.ns.get(c.doNs.ns.idFromName(TOKEN)).fetch(
      new Request('https://trip-do/lock/op', {
        method: 'POST',
        body: JSON.stringify({
          op: { type: 'userBoarded', source: 'confirm', expectedRev: first.__lockRev, releaseFirst: true, lock: makeLock(['뚝섬', '성수', '건대입구']) },
          now: NOW,
        }),
      }),
    );
    await complete(c, first);
    const { progress, lock } = await fetchCells(c.env, TOKEN);
    expect(progress?.waypoints.map((w) => w.stationName)).toEqual(['어린이대공원', '군자']);
    expect(lock?.lock?.trainCode).toBe('7246');
  });
});

describe('#3055 PR-4b — advanceBoardingLockWaypoint destination: 종료 전 claim', () => {
  const DEST_ROUTE = [wp('군자', 'destination', '7')];
  const destTrip = (): Trip => ({ ...tripOf(DEST_ROUTE), boardingLock: makeLock(['건대입구', '군자']) }) as Trip;

  async function arrive(c: Awaited<ReturnType<typeof setup>>, trip: Trip, hook: () => Promise<void>) {
    return advanceBoardingLockWaypoint(trip, trip.waypoints[0], c.env, c.deps, createEmptyScheduledStats(NOW), NOW, () => undefined, undefined, () => 'p', hook);
  }

  it('progress@1: 첫 도착은 claim 후 도착 alert 훅을 1회 호출하고 종료한다. 낡은 스냅샷 재도착은 훅·종료 없이 consumed:false', async () => {
    const c = await setup('progress@1', destTrip());
    let hooks = 0;
    const hook = async () => {
      hooks += 1;
    };
    const first = await arrive(c, (await getTrip(c.env, TOKEN)) as Trip, hook);
    expect(first).toEqual({ consumed: true, tripEnded: true });
    expect(hooks).toBe(1);
    const again = await arrive(c, destTrip(), hook);
    expect(again).toEqual({ consumed: false, tripEnded: false });
    expect(hooks).toBe(1);
  });

  it('lock@1(legacy): 같은 낡은 재도착도 종료 경로를 다시 탄다 — control', async () => {
    const c = await setup('lock@1', destTrip());
    let hooks = 0;
    const hook = async () => {
      hooks += 1;
    };
    await arrive(c, (await getTrip(c.env, TOKEN)) as Trip, hook);
    await putTrip(c.kv as unknown as KVNamespace, destTrip());
    await arrive(c, destTrip(), hook);
    expect(hooks).toBe(2);
  });
});
