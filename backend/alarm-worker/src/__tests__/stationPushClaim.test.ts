/**
 * #3055 / #3300 옵션 D PR-5 (#3338 잔여 1) — 매역 station-passed push도 **claim-first**.
 *
 * #3338은 `completeWaypointAdvance`·destination·catch-up·lockless·sync에 claim-then-fire를 넣었지만, `runTrainCodeTracking`의 도착 분기는
 * 매역 push(`tryAdvanceAndFireArvlcd` -> `fireArvlCdStationPush`)가 `advanceBoardingLockWaypoint`(head claim)보다 **앞에서** 나가 KV fire-once dedup
 * (`station-passed-fired:`)만으로 막혔다. 그 마커는 성공 후에 stamp되고 읽기는 엣지 캐시(기본 60s)라, 두 소비자(arvlCd 도착 경로 + vanish-fallback /
 * 낡은 스냅샷 재소비)가 같은 tick에 같은 역을 보면 둘 다 마커를 못 보고 각각 발사한다(#2615 주석이 스스로 인정한 "1회 초과 발사" race).
 * `progress@N`에서는 진행 셀의 `claimStationPush{expectedHeadKey}`(역당 1회 선점)가 이를 구조적으로 막는다. `off`/`lock@N`은 현행 유지(control).
 *
 * 마커 지연은 `CacheLagKV`로 모델링한다(실 KV 기본 읽기 동작). 판정 대상은 같은 역의 매역 alert 수(collapse-id = 역 단위).
 */
import { describe, expect, it } from 'vitest';
import { stationNotifCollapseId } from '../collapseId';
import {
  createEmptyScheduledStats,
  fireVanishFallbackStationPush,
  runTrainCodeTracking,
  STATION_PASSED_FIRED_KEY_PREFIX,
  type ScheduledDeps,
} from '../scheduled';
import { getTrip, putTrip } from '../trips';
import { fetchCells, resetCellStageCache } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import type { Env, Trip } from '../types';
import { CacheLagKV } from './helpers/cacheLagKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';
import {
  APNS_HOSTS,
  captureFetch,
  fakeD1,
  getApnsConfig,
  makeEnv,
  makeLock,
  makeTrip,
  NOW,
  seoulWith,
  TOKEN,
  useApnsHarness,
  wp,
} from './helpers/sleepAlarmHarness';

useApnsHarness();

const ROUTE = [wp('강남구청', 'intermediate'), wp('학동', 'intermediate'), wp('논현', 'destination')];
const [HEAD] = ROUTE;
const tripOf = (): Trip => makeTrip(ROUTE, { sleepModeEnabled: false, boardingLock: makeLock(['청담', ...ROUTE.map((w) => w.stationName)]) });
const noop = () => undefined;

async function setup(flag: string) {
  // station-passed 마커 읽기만 60s 지연(다른 키는 즉시) — 두 소비자가 서로의 마커를 못 보는 실 KV 창.
  const kv = new CacheLagKV(0, { byCacheTtl: { defaultTtlSec: 60, laggedPrefixes: [STATION_PASSED_FIRED_KEY_PREFIX] }, now: () => Date.now() });
  const doNs = makeFakeTripDoNamespace();
  const d1 = fakeD1();
  const env = { ...makeEnv(kv, d1.db), TRIP_DO: doNs.ns } as Env;
  await setTripDoFlag(env.TRIPS, flag);
  resetCellStageCache(kv);
  await putTrip(kv as unknown as KVNamespace, tripOf());
  const fetched = captureFetch();
  const deps = {
    seoul: seoulWith(HEAD.stationName, 1),
    apnsConfig: getApnsConfig(),
    apnsHosts: APNS_HOSTS,
    fetchImpl: fetched.fetchImpl,
    now: () => NOW,
  } as ScheduledDeps;
  return { kv, env, doNs, fetched, deps, d1 };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const stationAlerts = (c: Ctx) =>
  c.fetched.calls.filter((call) => call.pushType === 'alert' && call.collapseId === stationNotifCollapseId(TOKEN, HEAD.stationName));

/** 소비자 1 — arvlCd 도착 경로(`runTrainCodeTracking`). cron 소비자처럼 셀 overlay된 최신 trip을 받는다. */
async function arvlCdConsumer(c: Ctx, trip?: Trip, now = NOW) {
  const t = trip ?? ((await getTrip(c.env, TOKEN)) as Trip);
  await runTrainCodeTracking(t, t.waypoints[0], t.boardingLock!, c.env, c.deps, createEmptyScheduledStats(now), now, noop, () => 'p1');
}
/** 소비자 2 — 같은 역을 보는 다른 경로(낡은 스냅샷을 든 vanish-fallback). */
async function vanishConsumer(c: Ctx) {
  const stale = tripOf();
  await fireVanishFallbackStationPush({
    trip: stale,
    waypoint: HEAD,
    lock: stale.boardingLock!,
    env: c.env,
    deps: c.deps,
    stats: createEmptyScheduledStats(NOW),
    now: NOW,
    log: noop,
    generatePushId: () => 'p2',
    origin: 'vanish-fallback',
  });
}

describe('#3055 PR-5 — 매역 push claim-first: 두 소비자가 같은 역을 보아도 정확히 1번', () => {
  it('control(lock@1): 마커가 지연되는 창에서 arvlCd + vanish-fallback이 같은 역을 2번 발사한다 (결함 재현)', async () => {
    const c = await setup('lock@1');
    await arvlCdConsumer(c);
    await vanishConsumer(c);
    expect(stationAlerts(c)).toHaveLength(2);
  });

  it('progress@1: arvlCd가 먼저 선점하면 vanish-fallback은 발사하지 않는다 (1건) — 선점 거절은 D1에 남는다', async () => {
    const c = await setup('progress@1');
    await arvlCdConsumer(c);
    await vanishConsumer(c);
    expect(stationAlerts(c)).toHaveLength(1);
    const denied = c.d1.rows.filter((r) => r.kind === 'cron-fire-attempt' && r.meta?.outcome === 'skipped-reason');
    expect(denied.map((r) => ({ station: r.station, reason: r.meta?.reason }))).toEqual([
      { station: HEAD.stationName, reason: 'station-push-claim-noop' },
    ]);
  });

  it('progress@1: 순서가 반대여도(vanish-fallback 먼저) arvlCd 경로는 발사하지 않는다 (1건)', async () => {
    const c = await setup('progress@1');
    await vanishConsumer(c);
    await arvlCdConsumer(c);
    expect(stationAlerts(c)).toHaveLength(1);
  });

  it('progress@1: 낡은 스냅샷으로 arvlCd 경로를 다시 태워도 같은 역은 1건이다', async () => {
    const c = await setup('progress@1');
    await arvlCdConsumer(c);
    await arvlCdConsumer(c, tripOf());
    expect(stationAlerts(c)).toHaveLength(1);
  });

  it('progress@1: 선점은 head 전진을 막지 않는다 — 같은 tick에 매역 push 1건 + 셀 head는 다음 역으로 전진', async () => {
    const c = await setup('progress@1');
    await arvlCdConsumer(c);
    expect(stationAlerts(c)).toHaveLength(1);
    const { progress } = await fetchCells(c.env, TOKEN);
    expect(progress?.waypoints.map((w) => w.stationName)).toEqual(['학동', '논현']);
  });

  it('progress@1: 다음 역은 새로 선점할 수 있다 (head가 바뀌면 선점 표식은 무효)', async () => {
    const c = await setup('progress@1');
    await arvlCdConsumer(c);
    c.deps = { ...c.deps, seoul: seoulWith('학동', 1) } as ScheduledDeps;
    // 다른 역 연속 발사 억제 창(cross-station dedup)을 지난 뒤의 tick.
    await arvlCdConsumer(c, undefined, NOW + 30 * 60_000);
    const next = c.fetched.calls.filter((call) => call.pushType === 'alert' && call.collapseId === stationNotifCollapseId(TOKEN, '학동'));
    expect(next).toHaveLength(1);
  });
});
