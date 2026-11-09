/**
 * #3055 / #3300 옵션 D PR-5 (#3338 잔여 2) — claim 선점 후 발사 실패는 같은 tick에 **정확히 1회** 재전송한다 (사용자 결정 2026-11-09 "retry once").
 *
 * 배경: claim-then-fire는 선점이 applied인 뒤 APNs 전송이 실패하면 그 역의 push가 유실된다(선점은 되돌리지 않고 다음 tick은 noop).
 * 종전(legacy)에는 실패 시 마커가 안 찍혀 다음 tick이 자연 재시도했다. 재시도는 transient(429/5xx)에만 — BadDeviceToken 같은 영구 오류는
 * 같은 요청을 한 번 더 보내도 소용없다. 성공 시 재전송 0, 실패해도 3번째 시도 0. D1 `cron-fire-attempt` meta `retry:true`로 재시도 여부를 남긴다.
 * `off`/`lock@N`은 현행 유지(재시도 없음 — 다음 tick 자연 재시도).
 *
 * 선택: **같은 tick 재전송**(셀에 pending-retry stamp를 두지 않는다) — 다음 tick 재시도는 새 op·stamp·소진 규칙이 필요하고, 그 tick의 head는 이미 전진했을 수 있어
 * (도착 직후 다음 역 소비) "이 역의 낡은 push"를 따로 판정해야 한다. 같은 tick 재전송은 상태가 없고 상한(1회)이 코드 구조로 보장된다.
 */
import { describe, expect, it } from 'vitest';
import { stationNotifCollapseId } from '../collapseId';
import { createEmptyScheduledStats, runTrainCodeTracking, type ScheduledDeps } from '../scheduled';
import { getTrip, putTrip } from '../trips';
import { resetCellStageCache } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';
import {
  APNS_HOSTS,
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
const noop = () => undefined;
const isStationAlert = (collapseId?: string) => collapseId === stationNotifCollapseId(TOKEN, HEAD.stationName);

/** 매역 alert(collapse-id 역 단위)에만 `statuses`를 순서대로 적용하는 fetch — 나머지 push(LA·hop-end 등)는 항상 200. */
function sequencedFetch(statuses: number[]) {
  const stationAttempts: number[] = [];
  const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    const h = init?.headers ?? {};
    if (h['apns-push-type'] !== 'alert' || !isStationAlert(h['apns-collapse-id'])) return new Response('', { status: 200 });
    const status = statuses[stationAttempts.length] ?? 200;
    stationAttempts.push(status);
    return new Response(status === 200 ? '' : '{"reason":"InternalServerError"}', { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, stationAttempts };
}

async function setup(flag: string, statuses: number[]) {
  const kv = new InMemoryKV(() => NOW);
  const doNs = makeFakeTripDoNamespace();
  const d1 = fakeD1();
  const env = { ...makeEnv(kv, d1.db), TRIP_DO: doNs.ns } as Env;
  await setTripDoFlag(env.TRIPS, flag);
  resetCellStageCache(kv);
  const trip = makeTrip(ROUTE, { sleepModeEnabled: false, boardingLock: makeLock(['청담', ...ROUTE.map((w) => w.stationName)]) });
  await putTrip(kv as unknown as KVNamespace, trip);
  const { fetchImpl, stationAttempts } = sequencedFetch(statuses);
  const deps = {
    seoul: seoulWith(HEAD.stationName, 1),
    apnsConfig: getApnsConfig(),
    apnsHosts: APNS_HOSTS,
    fetchImpl,
    now: () => NOW,
  } as ScheduledDeps;
  const t = (await getTrip(env, TOKEN)) as Trip;
  await runTrainCodeTracking(t, t.waypoints[0], t.boardingLock!, env, deps, createEmptyScheduledStats(NOW), NOW, noop, () => 'p1');
  const attempts = d1.rows.filter((r) => r.kind === 'cron-fire-attempt' && (r.meta?.outcome === 'sent' || r.meta?.outcome === 'failed'));
  return { stationAttempts, attempts, kv };
}

describe('#3055 PR-5 — claim 선점 후 발사 실패: 같은 tick 1회 재전송', () => {
  it('progress@1: 첫 전송 500 -> 재시도 1회로 성공 — 총 2회 전송, D1 sent + retry:true', async () => {
    const r = await setup('progress@1', [500, 200]);
    expect(r.stationAttempts).toEqual([500, 200]);
    expect(r.attempts.map((a) => ({ outcome: a.meta?.outcome, retry: a.meta?.retry }))).toEqual([{ outcome: 'sent', retry: true }]);
  });

  it('progress@1: 첫 전송 500 + 재시도 500 -> 3번째 시도 없음(2회), D1 failed(사유 포함) + retry:true', async () => {
    const r = await setup('progress@1', [500, 500, 500, 500]);
    expect(r.stationAttempts).toEqual([500, 500]);
    expect(r.attempts.map((a) => ({ outcome: a.meta?.outcome, retry: a.meta?.retry, reason: a.meta?.reason }))).toEqual([
      { outcome: 'failed', retry: true, reason: expect.stringContaining('InternalServerError') },
    ]);
  });

  it('progress@1: 첫 전송 성공 -> 재시도 0 (1회 전송), D1 sent에 retry 필드 없음', async () => {
    const r = await setup('progress@1', [200]);
    expect(r.stationAttempts).toEqual([200]);
    expect(r.attempts.map((a) => ({ outcome: a.meta?.outcome, retry: a.meta?.retry }))).toEqual([{ outcome: 'sent', retry: undefined }]);
  });

  it('progress@1: 영구 오류(400)는 재시도하지 않는다 (1회 전송, D1 failed, retry 없음)', async () => {
    const r = await setup('progress@1', [400, 200]);
    expect(r.stationAttempts).toEqual([400]);
    expect(r.attempts.map((a) => ({ outcome: a.meta?.outcome, retry: a.meta?.retry }))).toEqual([{ outcome: 'failed', retry: undefined }]);
  });

  it('control(lock@1, legacy): 첫 전송 500이면 같은 tick 재전송 없이 1회 — 다음 tick 자연 재시도(마커 미stamp)', async () => {
    const r = await setup('lock@1', [500, 200]);
    expect(r.stationAttempts).toEqual([500]);
    expect(r.attempts.map((a) => ({ outcome: a.meta?.outcome, retry: a.meta?.retry }))).toEqual([{ outcome: 'failed', retry: undefined }]);
  });
});
