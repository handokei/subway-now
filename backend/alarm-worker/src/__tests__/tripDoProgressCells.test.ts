import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressCell } from '../progressOps';
import { waypointSignatureKey } from '../trips';
import {
  applyProgressResult,
  fetchCells,
  isProgressStage,
  overlayTripCells,
  readCellStage,
  resetCellStageCache,
  runProgressOp,
} from '../tripDoCells';
import { parseTripDoFlag, setTripDoFlag } from '../tripDoFlag';
import type { Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';

/**
 * #3055 / #3300 PR-4a — 진행 셀 클라이언트(flag 단계 판정 / 시드 / overlay / op).
 * 노선은 10/31 storm(용마산 -> 논현 7호선) 실측 순서.
 */
const NOW = 1_793_408_140_000;
const TOKEN = 'progress-cells-unit';
const wp = (stationName: string, kind: Waypoint['kind'] = 'intermediate'): Waypoint =>
  ({ stationName, line: '7', kind }) as Waypoint;
const ROUTE = [wp('강남구청'), wp('학동'), wp('논현', 'destination')];

const trip = (overrides: Partial<Trip> = {}): Trip =>
  ({
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '논현',
    waypoints: ROUTE,
    routeWaypoints: ROUTE,
    expiresAt: NOW + 3_600_000,
    createdAt: NOW - 600_000,
    alarmAtEpochMs: NOW,
    ...overrides,
  }) as unknown as Trip;

async function makeEnv(flag?: string) {
  const kv = new InMemoryKV();
  const doNs = makeFakeTripDoNamespace();
  const env = { TRIPS: kv as unknown as KVNamespace, TRIP_DO: doNs.ns } as Env;
  if (flag) await setTripDoFlag(env.TRIPS, flag);
  resetCellStageCache(kv);
  return { kv, env, doNs };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('isProgressStage', () => {
  it.each([
    ['off', false],
    ['lock@1', false],
    ['progress@1', true],
    ['full@1', true],
  ])('%s -> %s', (raw, expected) => {
    expect(isProgressStage(parseTripDoFlag(raw))).toBe(expected);
  });
  it('flag null(셀 권위 꺼짐)이면 false', () => {
    expect(isProgressStage(null)).toBe(false);
  });
});

describe('overlayTripCells — 단계별', () => {
  it('lock@N: 진행 셀을 읽지도 시드하지도 않는다(동작·DO 호출 불변) — KV waypoints 그대로', async () => {
    const { env, doNs } = await makeEnv('lock@1');
    const flag = (await readCellStage(env))!;
    const overlaid = await overlayTripCells(env, trip(), flag);
    expect(overlaid.waypoints).toEqual(ROUTE);
    expect(overlaid.__progressRev).toBeUndefined();
    const storage = [...doNs.storages.values()][0];
    expect(storage.map.has('progress')).toBe(false);
  });

  it('progress@N: 진행 셀을 시드해 덮고 __progressRev를 설정한다', async () => {
    const { env, doNs } = await makeEnv('progress@1');
    const flag = (await readCellStage(env))!;
    const overlaid = await overlayTripCells(env, trip(), flag);
    expect(overlaid.waypoints).toEqual(ROUTE);
    expect(overlaid.__progressRev).toBeDefined();
    expect([...doNs.storages.values()][0].map.has('progress')).toBe(true);
  });

  it('progress@N: 셀이 앞서 있으면 낡은 KV trip(head 강남구청)을 셀 진행(학동)으로 되돌려 덮는다 — 되감기 차단', async () => {
    const { env } = await makeEnv('progress@1');
    const flag = (await readCellStage(env))!;
    const first = await overlayTripCells(env, trip(), flag);
    await runProgressOp(
      env,
      TOKEN,
      { type: 'advanceHead', source: 'test', expectedHeadKey: waypointSignatureKey(ROUTE[0]), count: 1 },
      NOW,
    );
    const stale = trip(); // 60s 캐시의 낡은 KV 사본(head 강남구청)
    const overlaid = await overlayTripCells(env, stale, flag);
    expect(first.waypoints).toHaveLength(3);
    expect(overlaid.waypoints.map((w) => w.stationName)).toEqual(['학동', '논현']);
    expect(overlaid.__progressRev).toBeGreaterThan(first.__progressRev ?? 0);
  });

  it('progress@N: 셀 오류는 KV 값 그대로 + __progressRev/__lockRev undefined(fail-closed)', async () => {
    const { env, doNs } = await makeEnv('progress@1');
    const flag = (await readCellStage(env))!;
    vi.spyOn(doNs.ns, 'get').mockImplementation(() => {
      throw new Error('do down');
    });
    const overlaid = await overlayTripCells(env, trip(), flag);
    expect(overlaid.waypoints).toEqual(ROUTE);
    expect(overlaid.__progressRev).toBeUndefined();
    expect(overlaid.__lockRev).toBeUndefined();
  });
});

describe('runProgressOp / fetchCells / applyProgressResult', () => {
  it('fetchCells는 progress 셀을 함께 돌려준다(없으면 null)', async () => {
    const { env } = await makeEnv('progress@1');
    expect((await fetchCells(env, TOKEN)).progress).toBeNull();
    await runProgressOp(env, TOKEN, { type: 'seedProgressFromKv', source: 't', epoch: 1, snapshot: { createdAt: 1, waypoints: ROUTE } }, NOW);
    expect(((await fetchCells(env, TOKEN)).progress as ProgressCell).waypoints).toEqual(ROUTE);
  });

  it('DO 응답이 비정상이면 CellUnavailableError(stage에 op 이름)', async () => {
    const { env, doNs } = await makeEnv('progress@1');
    vi.spyOn(doNs.ns, 'get').mockReturnValue({ fetch: async () => new Response('x', { status: 500 }) } as unknown as DurableObjectStub);
    await expect(
      runProgressOp(env, TOKEN, { type: 'advanceHead', source: 't', expectedHeadKey: 'k', count: 1 }, NOW),
    ).rejects.toMatchObject({ name: 'CellUnavailableError', stage: 'progress:advanceHead' });
  });

  it('applyProgressResult는 셀 진행을 trip에 반영하고 __progressRev를 갱신하며 lock 결과도 반영한다', async () => {
    const { env } = await makeEnv('progress@1');
    await runProgressOp(env, TOKEN, { type: 'seedProgressFromKv', source: 't', epoch: 1, snapshot: { createdAt: 1, waypoints: ROUTE } }, NOW);
    const result = await runProgressOp(
      env,
      TOKEN,
      { type: 'advanceHead', source: 't', expectedHeadKey: waypointSignatureKey(ROUTE[0]), count: 1 },
      NOW,
    );
    const next = applyProgressResult(trip(), result);
    expect(next.waypoints.map((w) => w.stationName)).toEqual(['학동', '논현']);
    expect(next.__progressRev).toBe(result.cell.rev);
  });
});
