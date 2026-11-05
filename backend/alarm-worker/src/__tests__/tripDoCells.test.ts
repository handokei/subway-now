import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTrip } from '../trips';
import {
  CellUnavailableError,
  fetchCells,
  overlayTripCells,
  readCellStage,
  resetCellStageCache,
  runLaOp,
  runLockOp,
  seedCells,
} from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';

/** #3300 PR-3a — 셀 클라이언트: flag 판정(캐시) / 시드 규칙 / overlay fail-closed. */
const NOW = 1_800_000_000_000;
const TOKEN = 'cells-unit';

const trip = (overrides: Partial<Trip> = {}): Trip =>
  ({
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 1 },
    destination: '성수',
    waypoints: [{ stationName: '성수', line: '2', kind: 'destination' }],
    expiresAt: NOW + 3_600_000,
    createdAt: NOW - 600_000,
    alarmAtEpochMs: NOW,
    ...overrides,
  }) as unknown as Trip;

const lockMeta = (trainCode = '3334') => ({
  trainCode,
  line: '2',
  subwayId: '1002',
  selectedDepartureTime: NOW,
  segmentStations: ['뚝섬', '성수'],
  expiresAt: NOW + 3_600_000,
});

function makeEnv(flag?: string) {
  const kv = new InMemoryKV();
  const doNs = makeFakeTripDoNamespace();
  const env = { TRIPS: kv as unknown as KVNamespace, TRIP_DO: doNs.ns } as Env;
  return { kv, env, doNs, setFlag: (value: string) => setTripDoFlag(env.TRIPS, value), flag };
}

describe('readCellStage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('TRIP_DO 미바인딩이면 flag를 읽지도 않고 null', async () => {
    const kv = new InMemoryKV();
    const getSpy = vi.spyOn(kv, 'get');
    expect(await readCellStage({ TRIPS: kv as unknown as KVNamespace })).toBeNull();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('off / 미설정은 null, lock@N 이상은 flag', async () => {
    const { env, setFlag } = makeEnv();
    expect(await readCellStage(env)).toBeNull();
    await setFlag('lock@3');
    resetCellStageCache(env.TRIPS);
    expect(await readCellStage(env)).toEqual({ stage: 'lock', epoch: 3 });
    await setFlag('full@4');
    resetCellStageCache(env.TRIPS);
    expect(await readCellStage(env)).toEqual({ stage: 'full', epoch: 4 });
  });

  it('5초 안에는 KV를 다시 읽지 않고, 지나면 롤백(off)이 반영된다', async () => {
    const { env, kv, setFlag } = makeEnv();
    await setFlag('lock@1');
    expect(await readCellStage(env)).toEqual({ stage: 'lock', epoch: 1 });
    await setFlag('off');
    const getSpy = vi.spyOn(kv, 'get');
    expect(await readCellStage(env)).toEqual({ stage: 'lock', epoch: 1 });
    expect(getSpy).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 6_000);
    expect(await readCellStage(env)).toBeNull();
  });

  it('flag 읽기 실패는 off(fail-closed)', async () => {
    const { env, kv } = makeEnv();
    vi.spyOn(kv, 'get').mockRejectedValue(new Error('kv down'));
    expect(await readCellStage(env)).toBeNull();
  });
});

describe('seedCells / overlayTripCells', () => {
  const flag = { stage: 'lock', epoch: 1 } as const;

  it('최초 overlay: KV 값으로 두 셀을 시드하고 trip에 반영 + __lockRev', async () => {
    const { env } = makeEnv();
    const seen = await overlayTripCells(
      env,
      trip({ boardingLock: lockMeta(), activityPushToken: 'LA', activityState: 'live', consecutiveEtaMissing: 2 }),
      flag,
    );
    expect(seen).toMatchObject({
      boardingLock: { trainCode: '3334' },
      activityPushToken: 'LA',
      activityState: 'live',
      consecutiveEtaMissing: 2,
      lockEverAttached: true,
    });
    expect(seen.__lockRev).toBe(1);
  });

  it('KV 시야가 셀 세션보다 오래됐으면(낡은 읽기) 셀을 덮지 않는다', async () => {
    const { env } = makeEnv();
    await overlayTripCells(env, trip({ boardingLock: lockMeta('A') }), flag);
    const staleOlderSession = trip({ createdAt: NOW - 900_000, boardingLock: undefined });
    const seen = await overlayTripCells(env, staleOlderSession, flag);
    expect(seen.boardingLock?.trainCode).toBe('A');
  });

  it('KV 시야가 더 새 세션이면 재시드한다', async () => {
    const { env } = makeEnv();
    await overlayTripCells(env, trip({ boardingLock: lockMeta('A') }), flag);
    const newerSession = trip({ createdAt: NOW - 300_000, boardingLock: undefined });
    const seen = await overlayTripCells(env, newerSession, flag);
    expect(seen.boardingLock).toBeUndefined();
  });

  it('flag epoch가 바뀌면 KV로 재시드한다(off 기간 변화 반영)', async () => {
    const { env } = makeEnv();
    await overlayTripCells(env, trip({ boardingLock: lockMeta('A') }), flag);
    const seen = await overlayTripCells(env, trip({ boardingLock: lockMeta('B') }), { stage: 'lock', epoch: 2 });
    expect(seen.boardingLock?.trainCode).toBe('B');
  });

  it('DO 실패는 KV 값 그대로 + __lockRev undefined (fail-closed)', async () => {
    const { env, doNs } = makeEnv();
    vi.spyOn(doNs.ns, 'get').mockImplementation(() => {
      throw new Error('down');
    });
    const kvTrip = trip({ boardingLock: lockMeta() });
    const seen = await overlayTripCells(env, kvTrip, flag);
    expect(seen.boardingLock?.trainCode).toBe('3334');
    expect(seen.__lockRev).toBeUndefined();
  });

  it('셀 호출 실패는 CellUnavailableError(stage 포함)로 승격된다', async () => {
    const { env, doNs } = makeEnv();
    const bad = {
      idFromName: doNs.ns.idFromName.bind(doNs.ns),
      get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }),
    } as unknown as DurableObjectNamespace;
    const broken = { ...env, TRIP_DO: bad };
    await expect(fetchCells(broken, TOKEN)).rejects.toBeInstanceOf(CellUnavailableError);
    await expect(
      runLockOp(broken, TOKEN, { type: 'endSession', source: 't' }, NOW),
    ).rejects.toMatchObject({ stage: 'lock:endSession' });
    await expect(
      runLaOp(broken, TOKEN, { type: 'setLaState', source: 't', state: 'live' }, NOW),
    ).rejects.toMatchObject({ stage: 'la:setLaState' });
    await expect(
      seedCells({ TRIPS: env.TRIPS }, trip(), flag, NOW),
    ).rejects.toMatchObject({ stage: 'cells' });
  });

  it('getTrip(env): TRIP_DO가 있어도 flag off면 KV 단독 읽기(셀 미생성)', async () => {
    const { env, kv, doNs } = makeEnv();
    await kv.put(`trip:${TOKEN}`, JSON.stringify(trip({ boardingLock: lockMeta() })));
    const getSpy = vi.spyOn(doNs.ns, 'get');
    const seen = await getTrip(env, TOKEN);
    expect(seen?.boardingLock?.trainCode).toBe('3334');
    expect(seen?.__lockRev).toBeUndefined();
    expect(getSpy).not.toHaveBeenCalled();
  });
});
