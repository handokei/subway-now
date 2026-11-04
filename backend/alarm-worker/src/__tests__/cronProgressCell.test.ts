/**
 * #3055 / #3300 옵션 D PR-4b — 진행 셀 쪽 cron·HTTP 공용 클라이언트(`cronProgressCell.ts`) 단위.
 *
 * 계약:
 *  - `progress@N` 미만(off / lock@N)이면 항상 `legacy` — DO 진행 경로(/progress)를 한 번도 호출하지 않는다(롤백 경로 보존).
 *  - op는 같은 trip 객체에 in-place로 반영된다(`apply:false`면 호출자가 발사 후 직접 반영 — claim-then-fire).
 *  - cron 추적 trip의 DO 오류 / 셀 시야(`__progressRev`) 없음 / 예산 초과는 `skipped`(fail-closed), HTTP trip의 DO 오류는 throw(503).
 *  - 진행 스탬프는 메모리 즉시 반영 + tick 버퍼 -> tick 끝 trip당 op로 flush(같은 head로 이어진 변경은 합침, head가 전진했으면 셀이 버림).
 */
import { describe, expect, it, vi } from 'vitest';
import { beginCronCellTick, overlayCronTrips } from '../cronLockCell';
import { commitProgressOp, flushProgressStamps, persistProgressStamps, stampProgressFields } from '../cronProgressCell';
import { fetchCells, resetCellStageCache } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import { waypointSignatureKey } from '../trips';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';
import { interceptTripDo } from './helpers/lockCellReplayEnv';
import { makeTripEventSink } from './helpers/replay20261019';

const NOW = Date.parse('2026-11-04T09:00:00+09:00');
const HOUR_MS = 60 * 60_000;

const lockOf = (trainCode: string): BoardingLockMeta => ({
  trainCode,
  line: '2',
  subwayId: '1002',
  selectedDepartureTime: NOW,
  segmentStations: ['뚝섬', '성수', '건대입구'],
  expiresAt: NOW + HOUR_MS,
});

const WAYPOINTS: Trip['waypoints'] = [
  { stationName: '성수', line: '2', kind: 'intermediate' },
  { stationName: '건대입구', line: '2', kind: 'transfer' },
  { stationName: '어린이대공원', line: '7', kind: 'destination' },
];
const key = waypointSignatureKey;

const tripOf = (token: string, overrides: Partial<Trip> = {}): Trip =>
  ({
    token,
    route: { type: 'direct', line: '2', stops: 3 },
    destination: '어린이대공원',
    waypoints: WAYPOINTS,
    routeWaypoints: WAYPOINTS,
    expiresAt: NOW + 3 * HOUR_MS,
    createdAt: NOW - 10 * 60_000,
    alarmAtEpochMs: NOW,
    boardingLock: lockOf('3334'),
    ...overrides,
  }) as Trip;

async function makeCtx(flag: string) {
  const kv = new InMemoryKV();
  const doNs = makeFakeTripDoNamespace();
  const calls: string[] = [];
  const counted = interceptTripDo(doNs.ns, {
    before: async ({ method, path, body }) => {
      calls.push(`${method} ${path}${body?.op?.type ? `:${body.op.type}` : ''}`);
    },
  });
  const { db, events } = makeTripEventSink();
  const env = { TRIPS: kv as unknown as KVNamespace, TRIP_DO: counted, DB: db } as unknown as Env;
  await setTripDoFlag(env.TRIPS, flag);
  resetCellStageCache(kv);
  const raw = { TRIPS: env.TRIPS, TRIP_DO: doNs.ns };
  return { env, raw, calls, events, kv, doNs };
}

const progressCalls = (calls: string[]): string[] => calls.filter((c) => c.includes('/progress'));

async function trackedTrip(flag: string, token: string, overrides: Partial<Trip> = {}, budget?: number) {
  const ctx = await makeCtx(flag);
  const tick = await beginCronCellTick(ctx.env, budget === undefined ? undefined : { budget });
  const [trip] = await overlayCronTrips(tick!, [tripOf(token, overrides)], NOW);
  return { ...ctx, tick: tick!, trip };
}

describe('commitProgressOp', () => {
  it('lock@N tick: legacy — /progress를 호출하지 않는다', async () => {
    const { env, trip, calls } = await trackedTrip('lock@1', 't-lock');
    const commit = await commitProgressOp(env, trip, { type: 'advanceHead', source: 't', expectedHeadKey: key(WAYPOINTS[0]), count: 1 }, NOW);
    expect(commit).toEqual({ mode: 'legacy' });
    expect(progressCalls(calls)).toEqual([]);
    expect(trip.waypoints).toHaveLength(3);
  });

  it('flag off HTTP trip: legacy — DO 호출 0', async () => {
    const { env, calls } = await makeCtx('off');
    const commit = await commitProgressOp(env, tripOf('t-off'), { type: 'advanceHead', source: 't', expectedHeadKey: key(WAYPOINTS[0]), count: 1 }, NOW);
    expect(commit).toEqual({ mode: 'legacy' });
    expect(calls).toEqual([]);
  });

  it('progress@N tick: applied는 같은 trip 객체에 in-place 반영된다', async () => {
    const { env, trip } = await trackedTrip('progress@1', 't-a');
    const commit = await commitProgressOp(env, trip, { type: 'advanceHead', source: 't', expectedHeadKey: key(WAYPOINTS[0]), count: 1 }, NOW);
    expect(commit).toMatchObject({ mode: 'cell', outcome: 'applied' });
    expect(trip.waypoints.map((w) => w.stationName)).toEqual(['건대입구', '어린이대공원']);
  });

  it('apply:false는 trip을 바꾸지 않고 결과만 돌려준다(claim-then-fire)', async () => {
    const { env, trip, raw } = await trackedTrip('progress@1', 't-b');
    const commit = await commitProgressOp(
      env,
      trip,
      { type: 'advanceHead', source: 't', expectedHeadKey: key(WAYPOINTS[0]), count: 1 },
      NOW,
      { apply: false },
    );
    expect(commit).toMatchObject({ mode: 'cell', outcome: 'applied' });
    expect(trip.waypoints).toHaveLength(3);
    expect((await fetchCells(raw, 't-b')).progress?.waypoints).toHaveLength(2);
  });

  it('이미 지나간 head는 noop(재소비 금지 신호)', async () => {
    const { env, trip } = await trackedTrip('progress@1', 't-c');
    const op = { type: 'advanceHead', source: 't', expectedHeadKey: key(WAYPOINTS[0]), count: 1 } as const;
    await commitProgressOp(env, trip, op, NOW);
    const stale = { ...trip, waypoints: WAYPOINTS } as Trip;
    // 같은 tick 객체로 추적되지 않는 사본 — HTTP 경로처럼 flag를 직접 읽는다.
    const again = await commitProgressOp(env, stale, op, NOW);
    expect(again).toMatchObject({ mode: 'cell', outcome: 'noop' });
    expect(stale.waypoints.map((w) => w.stationName)).toEqual(['건대입구', '어린이대공원']);
  });

  it('cron 추적 trip: 셀 시야(__progressRev)가 없으면 skipped이고 DO를 부르지 않는다(fail-closed)', async () => {
    const { env, trip, calls } = await trackedTrip('progress@1', 't-d');
    trip.__progressRev = undefined;
    const before = calls.length;
    const commit = await commitProgressOp(env, trip, { type: 'advanceHead', source: 't', expectedHeadKey: key(WAYPOINTS[0]), count: 1 }, NOW);
    expect(commit).toEqual({ mode: 'cell', outcome: 'skipped' });
    expect(calls.length).toBe(before);
  });

  it('cron 추적 trip: DO 오류는 skipped, HTTP trip: DO 오류는 throw', async () => {
    const { env, trip, doNs } = await trackedTrip('progress@1', 't-e');
    vi.spyOn(doNs.ns, 'get').mockImplementation(() => {
      throw new Error('do down');
    });
    const op = { type: 'advanceHead', source: 't', expectedHeadKey: key(WAYPOINTS[0]), count: 1 } as const;
    expect(await commitProgressOp(env, trip, op, NOW)).toEqual({ mode: 'cell', outcome: 'skipped' });
    await expect(commitProgressOp(env, { ...trip, token: 't-e2' } as Trip, op, NOW)).rejects.toMatchObject({ name: 'CellUnavailableError' });
  });

  it('예산이 소진되면 skipped이고 건너뛴 호출 수가 계측된다(overlay가 예산 4를 모두 쓴 tick)', async () => {
    // overlay = /cells 1회 + 셀 시드(lock·la·progress) 3회 = 4 -> 이후 DO 호출은 예산 초과.
    const { env, trip, tick, raw } = await trackedTrip('progress@1', 't-f', {}, 4);
    expect(trip.__progressRev).toBeDefined();
    const op = { type: 'advanceHead', source: 't', expectedHeadKey: key(WAYPOINTS[0]), count: 1 } as const;
    expect(await commitProgressOp(env, trip, op, NOW)).toEqual({ mode: 'cell', outcome: 'skipped' });
    expect(tick.skipped).toBe(1);
    expect(trip.waypoints).toHaveLength(3);
    expect((await fetchCells(raw, 't-f')).progress?.waypoints).toHaveLength(3);
  });

  it('releaseLock applied: lock-released{reason,source,rev}를 남기고 lock 셀이 풀린다', async () => {
    const { env, trip, events, raw } = await trackedTrip('progress@1', 't-g', { waypoints: WAYPOINTS.slice(1), routeWaypoints: WAYPOINTS });
    const commit = await commitProgressOp(
      env,
      trip,
      {
        type: 'advanceHead',
        source: 'complete-advance',
        expectedHeadKey: key(WAYPOINTS[1]),
        count: 1,
        releaseLock: { expectedRev: trip.__lockRev ?? -1, reason: 'transfer' },
      },
      NOW,
    );
    expect(commit).toMatchObject({ mode: 'cell', outcome: 'applied' });
    expect(trip.boardingLock).toBeUndefined();
    expect((await fetchCells(raw, 't-g')).lock?.lock).toBeUndefined();
    const released = events.filter((e) => e.kind === 'lock-released');
    expect(released).toHaveLength(1);
    expect(released[0].meta).toMatchObject({ reason: 'transfer', source: 'complete-advance' });
  });

  it('releaseLock rev가 낡으면 전진만 applied이고 lock은 유지 + lock-op-conflict', async () => {
    const { env, trip, events } = await trackedTrip('progress@1', 't-h', { waypoints: WAYPOINTS.slice(1), routeWaypoints: WAYPOINTS });
    const commit = await commitProgressOp(
      env,
      trip,
      {
        type: 'advanceHead',
        source: 'complete-advance',
        expectedHeadKey: key(WAYPOINTS[1]),
        count: 1,
        releaseLock: { expectedRev: (trip.__lockRev ?? 0) + 7, reason: 'transfer' },
      },
      NOW,
    );
    expect(commit).toMatchObject({ mode: 'cell', outcome: 'applied' });
    expect(trip.boardingLock?.trainCode).toBe('3334');
    expect(events.filter((e) => e.kind === 'lock-op-conflict')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'lock-released')).toEqual([]);
  });
});

describe('stampProgressFields / flushProgressStamps', () => {
  it('추적되지 않은 trip: 메모리에만 반영(clear는 undefined, lockEpochKey는 비영속 __progressLockEpoch)', async () => {
    const { calls } = await makeCtx('progress@1');
    const loose = tripOf('t-loose', { lastLaPushAt: 5, lastTrackedArrivalEpoch: 9 });
    stampProgressFields(loose, { set: { lastLaPushEpoch: 7, lockEpochKey: 'k' }, clear: ['lastTrackedArrivalEpoch'] });
    expect(loose).toMatchObject({ lastLaPushEpoch: 7, lastLaPushAt: 5, __progressLockEpoch: 'k' });
    expect(loose.lastTrackedArrivalEpoch).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('lock@N tick: 메모리 반영만, 버퍼링·DO 호출 없음', async () => {
    const { trip, tick } = await trackedTrip('lock@1', 't-lk');
    stampProgressFields(trip, { set: { lastLaPushAt: NOW } });
    expect(trip.lastLaPushAt).toBe(NOW);
    expect(tick.stamps.size).toBe(0);
  });

  it('progress@N tick: 메모리 즉시 반영 + tick 끝 flush에서 trip당 stampProgress 1회로 합쳐 영속', async () => {
    const { trip, calls, raw } = await trackedTrip('progress@1', 't-s');
    const before = progressCalls(calls).length;
    stampProgressFields(trip, { set: { lastLaPushEpoch: 11 } });
    stampProgressFields(trip, { set: { lastLaPushAt: NOW } });
    stampProgressFields(trip, { set: { lastTrackedArrivalEpoch: 12 } });
    expect(trip).toMatchObject({ lastLaPushEpoch: 11, lastLaPushAt: NOW, lastTrackedArrivalEpoch: 12 });
    expect(progressCalls(calls).length).toBe(before);
    await flushProgressStamps([trip], undefined, NOW);
    expect(progressCalls(calls).slice(before)).toEqual(['POST /progress/op:stampProgress']);
    expect((await fetchCells(raw, 't-s')).progress).toMatchObject({ lastLaPushEpoch: 11, lastLaPushAt: NOW, lastTrackedArrivalEpoch: 12 });
  });

  it('같은 키의 뒤 변경이 앞을 덮고, set 뒤 clear는 clear가 이긴다', async () => {
    const { trip, raw } = await trackedTrip('progress@1', 't-m');
    stampProgressFields(trip, { set: { lastLaPushAt: 1 } });
    stampProgressFields(trip, { set: { lastLaPushAt: 2, lastLaPushEpoch: 3 } });
    stampProgressFields(trip, { clear: ['lastLaPushEpoch'] });
    stampProgressFields(trip, { clear: ['lastTrackedArrivalEpoch'] });
    stampProgressFields(trip, { set: { lastTrackedArrivalEpoch: 4 } });
    await flushProgressStamps([trip], undefined, NOW);
    expect((await fetchCells(raw, 't-m')).progress).toMatchObject({ lastLaPushAt: 2, lastTrackedArrivalEpoch: 4 });
    expect((await fetchCells(raw, 't-m')).progress?.lastLaPushEpoch).toBeUndefined();
  });

  it('head가 전진한 뒤의 낡은 head 스탬프는 셀이 버린다(전진이 기준값을 리셋했다)', async () => {
    const { env, trip, raw } = await trackedTrip('progress@1', 't-h');
    stampProgressFields(trip, { set: { lastLaPushAt: NOW } }); // head 성수 기준
    await commitProgressOp(env, trip, { type: 'advanceHead', source: 't', expectedHeadKey: key(WAYPOINTS[0]), count: 1 }, NOW);
    await flushProgressStamps([trip], undefined, NOW);
    expect((await fetchCells(raw, 't-h')).progress?.lastLaPushAt).toBeUndefined();
  });

  it('이번 tick에 종료된 trip / 셀 시야 없는 trip은 flush하지 않는다', async () => {
    const ended = await trackedTrip('progress@1', 't-end');
    stampProgressFields(ended.trip, { set: { lastLaPushAt: NOW } });
    const callsBefore = ended.calls.length;
    await flushProgressStamps([ended.trip], new Set(['t-end']), NOW);
    expect(ended.calls.length).toBe(callsBefore);

    const noRev = await trackedTrip('progress@1', 't-norev');
    stampProgressFields(noRev.trip, { set: { lastLaPushAt: NOW } });
    noRev.trip.__progressRev = undefined;
    const before = noRev.calls.length;
    await flushProgressStamps([noRev.trip], undefined, NOW);
    expect(noRev.calls.length).toBe(before);
  });

  it('flush 중 DO 오류는 삼킨다(스탬프는 최적화 기준값 — 다음 tick 복구)', async () => {
    const { trip, doNs } = await trackedTrip('progress@1', 't-err');
    stampProgressFields(trip, { set: { lastLaPushAt: NOW } });
    vi.spyOn(doNs.ns, 'get').mockImplementation(() => {
      throw new Error('do down');
    });
    await expect(flushProgressStamps([trip], undefined, NOW)).resolves.toBeUndefined();
  });
});

describe('persistProgressStamps (HTTP)', () => {
  it('progress@N 미만이면 trip을 그대로 돌려주고 DO를 호출하지 않는다', async () => {
    const { env, calls } = await makeCtx('lock@1');
    const trip = tripOf('t-p0');
    expect(await persistProgressStamps(env, trip, 'confirm', { clear: ['lastLaPushAt'] }, NOW)).toBe(trip);
    expect(progressCalls(calls)).toEqual([]);
  });

  it('progress@N이면 op로 영속하고 최신 셀 값을 반영한 trip을 돌려준다(head 스코프는 현재 head를 전제)', async () => {
    const { env, raw } = await makeCtx('progress@1');
    const first = await persistProgressStamps(env, tripOf('t-p1'), 'confirm', { set: { transferObservedAt: { stationName: '건대입구', line: '2', atMs: NOW } } }, NOW);
    expect(first.transferObservedAt?.atMs).toBe(NOW);
    const second = await persistProgressStamps(env, first, 'confirm', { set: { lastLaPushAt: NOW } }, NOW);
    expect(second.lastLaPushAt).toBe(NOW);
    expect((await fetchCells(raw, 't-p1')).progress?.lastLaPushAt).toBe(NOW);
  });
});
