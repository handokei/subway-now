/**
 * #3055 / #3300 옵션 D PR-5 후속 — `/boarding-lock/sync`의 claim(`advanceHead`, index.ts)이 applied인 발사도 "retry once"를 받는다.
 *
 * sync 순수 intermediate 분기는 진행 셀에서 구간을 선점한 뒤 건너뛴 역 알림(`fireSyncSkippedStationPasses`)과 소비 구간 취침 알람
 * (`fireSyncConsumedPrecedingAlarms`)을 waitUntil 체인에서 발사한다. 선점 뒤 전송이 5xx로 실패하면 구간은 이미 셀에서 소비돼 cron이 다시 만들 수 없다.
 * 5가지 계약(재시도 성공 / 성공 시 0 / 재시도 실패 시 3번째 0 / 400 0 / lock@N control)을 고정한다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { sleepAlarmCollapseId, stationNotifCollapseId } from '../collapseId';
import { resetCellStageCache } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import type { Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';
import { fakeD1, makeEnv, useApnsHarness, wp } from './helpers/sleepAlarmHarness';
import { SYNC_TOKEN, lockActiveTrip } from './helpers/sleepAlarmSyncHttp';

useApnsHarness();

afterEach(() => vi.unstubAllGlobals());

const SETTLE_MS = 150;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

interface Push {
  pushType?: string;
  collapseId?: string;
  data?: { kind?: string };
}

interface Site {
  name: string;
  trip: () => Trip;
  observed: string;
  isTarget: (push: Push) => boolean;
}

const LEG: Waypoint[] = [wp('상봉', 'intermediate'), wp('면목', 'intermediate'), wp('건대입구', 'destination')];

const MIXED_DESTINATION: Waypoint[] = [wp('면목', 'intermediate'), wp('건대입구', 'destination')];
const MIXED_TRANSFER: Waypoint[] = [wp('면목', 'intermediate'), wp('건대입구', 'transfer'), wp('어린이대공원', 'intermediate'), wp('군자', 'destination')];
const stationAlertOf = (station: string) => (p: Push) => p.pushType === 'alert' && p.collapseId === stationNotifCollapseId(SYNC_TOKEN, station);

const SITES: Site[] = [
  {
    name: 'sync 순수 intermediate -> 건너뛴 역 매역 alert (fireSyncSkippedStationPasses)',
    trip: () => lockActiveTrip(LEG, { sleepModeEnabled: false }),
    observed: '면목',
    isTarget: (p) => p.pushType === 'alert' && p.collapseId === stationNotifCollapseId(SYNC_TOKEN, '상봉'),
  },
  {
    name: 'sync 순수 intermediate -> 소비 구간 취침 알람 alert (fireSyncConsumedPrecedingAlarms)',
    trip: () => lockActiveTrip(LEG),
    observed: '면목',
    isTarget: (p) => p.pushType === 'alert' && p.collapseId === sleepAlarmCollapseId(SYNC_TOKEN, '건대입구'),
  },
  {
    name: 'sync 순수 intermediate -> 소비 구간 취침 알람 companion',
    trip: () => lockActiveTrip(LEG),
    observed: '면목',
    isTarget: (p) => p.data?.kind === 'sleep-alarm-companion',
  },
  {
    name: 'sync 혼합(목적지 소비) -> 관측 목적지 도착 alert (fireSyncObservedTransferDestination)',
    trip: () => lockActiveTrip(MIXED_DESTINATION, { sleepModeEnabled: false }),
    observed: '건대입구',
    isTarget: stationAlertOf('건대입구'),
  },
  {
    name: 'sync 혼합(환승 소비) -> 관측 환승 도착 alert (fireSyncObservedTransferDestination)',
    trip: () => lockActiveTrip(MIXED_TRANSFER, { sleepModeEnabled: false }),
    observed: '건대입구',
    isTarget: stationAlertOf('건대입구'),
  },
];

async function exercise(site: Site, flag: string, statuses: number[]) {
  const kv = new InMemoryKV();
  const doNs = makeFakeTripDoNamespace();
  const env = { ...makeEnv(kv, fakeD1().db), TRIP_DO: doNs.ns } as Env;
  await setTripDoFlag(env.TRIPS, flag);
  resetCellStageCache(kv);
  const trip = site.trip();
  await kv.put(`trip:${trip.token}`, JSON.stringify(trip));
  let attempts = 0;
  vi.stubGlobal('fetch', (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const headers = init?.headers ?? {};
    const body = JSON.parse(String(init?.body ?? '{}')) as { data?: { kind?: string } };
    const push: Push = { pushType: headers['apns-push-type'], collapseId: headers['apns-collapse-id'], data: body.data };
    if (!site.isTarget(push)) return new Response('', { status: 200 });
    const status = statuses[attempts++] ?? 200;
    return status === 200 ? new Response('', { status }) : new Response(`{"reason":"${status >= 500 ? 'InternalServerError' : 'BadRequest'}"}`, { status });
  }) as unknown as typeof fetch);
  const res = await app.fetch(
    new Request('http://example.com/boarding-lock/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: trip.token, observedAtMs: Date.now(), accuracy: 20, observedStationName: site.observed }),
    }),
    env,
  );
  await settle();
  return { status: res.status, attempts };
}

describe.each(SITES)('#3055 PR-5 후속 retry once — $name', (site) => {
  it('progress@1: 첫 전송 500 -> 같은 tick 재전송 1회 (총 2회)', async () => {
    const r = await exercise(site, 'progress@1', [500, 200]);
    expect(r).toEqual({ status: 200, attempts: 2 });
  });

  it('progress@1: 첫 전송 성공 -> 재전송 0 (1회)', async () => {
    const r = await exercise(site, 'progress@1', [200]);
    expect(r).toEqual({ status: 200, attempts: 1 });
  });

  it('progress@1: 재전송도 500 -> 3번째 시도 없음 (2회)', async () => {
    const r = await exercise(site, 'progress@1', [500, 500, 500, 500]);
    expect(r).toEqual({ status: 200, attempts: 2 });
  });

  it('progress@1: 영구 오류(400)는 재시도하지 않는다 (1회)', async () => {
    const r = await exercise(site, 'progress@1', [400, 200]);
    expect(r).toEqual({ status: 200, attempts: 1 });
  });

  it('control(lock@1, legacy): 첫 전송 500이어도 같은 요청 안 재전송 없음 (1회)', async () => {
    const r = await exercise(site, 'lock@1', [500, 200]);
    expect(r).toEqual({ status: 200, attempts: 1 });
  });
});
