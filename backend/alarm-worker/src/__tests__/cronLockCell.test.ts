/**
 * #3055 / #3300 옵션 D PR-3b — cron 쪽 lock/LA 셀 클라이언트(`cronLockCell.ts`) 단위.
 *
 * 계약(plan §2 실패 정책, §9 cron subrequest 예산):
 *  - flag off / TRIP_DO 미바인딩이면 tick은 `null` — 호출자는 현행(legacy) 경로를 그대로 탄다(DO 호출 0).
 *  - overlay는 tick 안의 DO 호출 수를 세고, 예산에 닿으면 남은 trip의 overlay를 생략한다(fail-closed: 그 trip의 lock 변경 skip).
 *  - op는 최신 셀에 대해 적용되고 결과가 같은 trip 객체에 in-place로 반영된다(scheduled.ts in-place mutate 계약).
 *  - op 실패(DO 오류) / rev 없음 / 예산 초과는 `skipped` — trip의 lock은 그대로이고 DO 호출이 늘지 않는다.
 *  - 해제(applied releaseAuto)와 conflict에만 D1 이벤트(`lock-released` / `lock-op-conflict`)를 남긴다.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  beginCronCellTick,
  clearLaTokenViaCell,
  commitCronLockOp,
  endLockSession,
  freshLockActive,
  overlayCronTrips,
} from '../cronLockCell';
import { fetchCells, resetCellStageCache, runLaOp, runLockOp } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';
import { interceptTripDo } from './helpers/lockCellReplayEnv';
import { makeTripEventSink } from './helpers/replay20261019';

const NOW = Date.parse('2026-11-04T09:00:00+09:00');
const HOUR_MS = 60 * 60_000;

const lockOf = (trainCode: string, line = '7'): BoardingLockMeta => ({
  trainCode,
  line,
  subwayId: '1007',
  selectedDepartureTime: NOW,
  segmentStations: ['용마산', '중곡', '군자(능동)'],
  expiresAt: NOW + HOUR_MS,
});

const tripOf = (token: string, overrides: Partial<Trip> = {}): Trip =>
  ({
    token,
    route: { type: 'direct', line: '7', stops: 2 },
    destination: '군자(능동)',
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '군자(능동)', line: '7', kind: 'destination' },
    ],
    expiresAt: NOW + 3 * HOUR_MS,
    createdAt: NOW - 10 * 60_000,
    alarmAtEpochMs: NOW,
    boardingLock: lockOf('7001'),
    ...overrides,
  }) as Trip;

async function makeCtx(flag: string = 'lock@1') {
  const kv = new InMemoryKV();
  const doNs = makeFakeTripDoNamespace();
  const calls: string[] = [];
  const counted = interceptTripDo(doNs.ns, {
    before: async ({ method, path }) => {
      calls.push(`${method} ${path}`);
    },
  });
  const { db, events } = makeTripEventSink();
  const env = { TRIPS: kv as unknown as KVNamespace, TRIP_DO: counted, DB: db } as unknown as Env;
  await setTripDoFlag(env.TRIPS, flag);
  resetCellStageCache(kv);
  const raw = { TRIPS: env.TRIPS, TRIP_DO: doNs.ns };
  return { env, raw, calls, events, kv };
}

describe('beginCronCellTick', () => {
  it('flag off이면 null이고 DO를 호출하지 않는다', async () => {
    const { env, calls } = await makeCtx('off');
    expect(await beginCronCellTick(env)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('TRIP_DO 미바인딩이면 null', async () => {
    const { env } = await makeCtx();
    expect(await beginCronCellTick({ ...env, TRIP_DO: undefined } as Env)).toBeNull();
  });

  it('lock@N이면 tick을 돌려준다', async () => {
    const { env } = await makeCtx();
    expect(await beginCronCellTick(env)).not.toBeNull();
  });
});

describe('overlayCronTrips / commitCronLockOp', () => {
  it('overlay는 셀 lock과 __lockRev를 trip에 싣는다(KV lock으로 셀 시드)', async () => {
    const { env } = await makeCtx();
    const tick = await beginCronCellTick(env);
    const [trip] = await overlayCronTrips(tick!, [tripOf('t-a')], NOW);
    expect(trip.boardingLock?.trainCode).toBe('7001');
    expect(typeof trip.__lockRev).toBe('number');
  });

  it('추적되지 않은 trip(HTTP 사본 등)은 legacy — DO 호출 0', async () => {
    const { env, calls } = await makeCtx();
    const loose = tripOf('t-loose');
    const commit = await commitCronLockOp(loose, { type: 'releaseAuto', source: 'cron', reason: 'vanish' }, NOW);
    expect(commit).toEqual({ mode: 'legacy' });
    expect(calls).toEqual([]);
    expect(loose.boardingLock?.trainCode).toBe('7001');
    void env;
  });

  it('applied: 같은 trip 객체에 in-place 반영되고 같은 객체로 다음 op가 성공한다(rev 갱신)', async () => {
    const { env, raw } = await makeCtx();
    const tick = await beginCronCellTick(env);
    const [trip] = await overlayCronTrips(tick!, [tripOf('t-b', { consecutiveEtaMissing: 2 })], NOW);
    const swap = await commitCronLockOp(
      trip,
      { type: 'swapAuto', source: 'cron-vanish-swap', trainCode: '7002', expiresAt: NOW + 2 * HOUR_MS, appendHistory: true },
      NOW,
    );
    expect(swap).toEqual({ mode: 'cell', outcome: 'applied' });
    expect(trip.boardingLock?.trainCode).toBe('7002');
    expect(trip.consecutiveEtaMissing).toBe(0);
    const release = await commitCronLockOp(trip, { type: 'releaseAuto', source: 'cron', reason: 'vanish' }, NOW);
    expect(release).toEqual({ mode: 'cell', outcome: 'applied' });
    expect(trip.boardingLock).toBeUndefined();
    expect((await fetchCells(raw, 't-b')).lock?.lock).toBeUndefined();
  });

  it('applied releaseAuto는 lock-released{reason,source,rev} 1행을 남긴다', async () => {
    const { env, events } = await makeCtx();
    const tick = await beginCronCellTick(env);
    const [trip] = await overlayCronTrips(tick!, [tripOf('t-c')], NOW);
    await commitCronLockOp(trip, { type: 'releaseAuto', source: 'cron', reason: 'demote' }, NOW);
    const released = events.filter((e) => e.kind === 'lock-released');
    expect(released).toHaveLength(1);
    expect(released[0].meta).toMatchObject({ reason: 'demote', source: 'cron' });
    expect(typeof released[0].meta.rev).toBe('number');
  });

  it('swap/setEtaMissing 같은 비해제 applied는 이벤트를 남기지 않는다(D1 쿼터)', async () => {
    const { env, events } = await makeCtx();
    const tick = await beginCronCellTick(env);
    const [trip] = await overlayCronTrips(tick!, [tripOf('t-d')], NOW);
    await commitCronLockOp(trip, { type: 'setEtaMissing', source: 'cron', value: 3 }, NOW);
    expect(trip.consecutiveEtaMissing).toBe(3);
    expect(events).toEqual([]);
  });

  it('conflict: 낡은 rev는 셀을 바꾸지 못하고 trip은 셀 lock을 따라가며 lock-op-conflict가 남는다', async () => {
    const { env, raw, events } = await makeCtx();
    const tick = await beginCronCellTick(env);
    const [trip] = await overlayCronTrips(tick!, [tripOf('t-e')], NOW);
    const { lock: cell } = await fetchCells(raw, 't-e');
    await runLockOp(
      raw,
      't-e',
      { type: 'userBoarded', source: 'confirm', expectedRev: cell!.rev, releaseFirst: true, lock: lockOf('7777') },
      NOW,
    );
    const commit = await commitCronLockOp(trip, { type: 'releaseAuto', source: 'cron', reason: 'vanish' }, NOW);
    expect(commit).toEqual({ mode: 'cell', outcome: 'conflict' });
    expect(trip.boardingLock?.trainCode).toBe('7777');
    expect(events.filter((e) => e.kind === 'lock-op-conflict').map((e) => e.meta)).toEqual([
      { op: 'releaseAuto', source: 'cron' },
    ]);
    expect(events.filter((e) => e.kind === 'lock-released')).toEqual([]);
  });

  it('DO 오류: skipped — trip lock 불변, 예외 없음', async () => {
    const { env, raw } = await makeCtx();
    const tick = await beginCronCellTick(env);
    const [trip] = await overlayCronTrips(tick!, [tripOf('t-f')], NOW);
    const failing = vi.spyOn(env.TRIP_DO as DurableObjectNamespace, 'get').mockImplementation(() => {
      throw new Error('do down');
    });
    const commit = await commitCronLockOp(trip, { type: 'releaseAuto', source: 'cron', reason: 'vanish' }, NOW);
    failing.mockRestore();
    expect(commit).toEqual({ mode: 'cell', outcome: 'skipped' });
    expect(trip.boardingLock?.trainCode).toBe('7001');
    expect((await fetchCells(raw, 't-f')).lock?.lock?.trainCode).toBe('7001');
  });

  it('예산: 한도에 닿으면 남은 trip의 overlay를 생략하고(rev 없음) 그 trip의 op는 skipped이며 DO 호출이 늘지 않는다', async () => {
    const { env, calls } = await makeCtx();
    const tick = await beginCronCellTick(env, { budget: 3 });
    const trips = await overlayCronTrips(
      tick!,
      ['t-1', 't-2', 't-3', 't-4', 't-5'].map((token) => tripOf(token)),
      NOW,
    );
    // 첫 trip의 overlay가 예산을 쓴다(fetch + seed op들). 남은 trip은 overlay 생략.
    expect(calls.length).toBeLessThanOrEqual(3);
    const omitted = trips.filter((trip) => trip.__lockRev === undefined);
    expect(omitted.length).toBeGreaterThan(0);
    const before = calls.length;
    const commit = await commitCronLockOp(omitted[0], { type: 'releaseAuto', source: 'cron', reason: 'vanish' }, NOW);
    expect(commit).toEqual({ mode: 'cell', outcome: 'skipped' });
    expect(omitted[0].boardingLock?.trainCode).toBe('7001');
    expect(calls.length).toBe(before);
  });
});

describe('freshLockActive (발사 직전 GET /lock 1회)', () => {
  it('overlay 이후 사용자가 붙인 활성 lock을 본다 — GET /lock 1회, 추적 안 된 trip은 false(DO 호출 0)', async () => {
    const { env, raw, calls } = await makeCtx();
    const tick = await beginCronCellTick(env);
    const [trip] = await overlayCronTrips(tick!, [tripOf('t-g', { boardingLock: undefined })], NOW);
    expect(trip.boardingLock).toBeUndefined();
    await runLockOp(
      raw,
      't-g',
      { type: 'attachIfNone', source: 'confirm', authority: 'user', expectedRev: 0, lock: lockOf('7555') },
      NOW,
    );
    const before = calls.length;
    expect(await freshLockActive(trip, NOW)).toBe(true);
    expect(calls.slice(before)).toEqual(['GET /lock']);
    expect(trip.boardingLock?.trainCode).toBe('7555');
    expect(await freshLockActive(tripOf('t-loose'), NOW)).toBe(false);
  });

  it('셀 lock이 없거나 만료면 false, DO 오류는 fail-closed(true: 발사 보류)', async () => {
    const { env } = await makeCtx();
    const tick = await beginCronCellTick(env);
    const [trip] = await overlayCronTrips(tick!, [tripOf('t-h', { boardingLock: undefined })], NOW);
    expect(await freshLockActive(trip, NOW)).toBe(false);
    const failing = vi.spyOn(env.TRIP_DO as DurableObjectNamespace, 'get').mockImplementation(() => {
      throw new Error('do down');
    });
    expect(await freshLockActive(trip, NOW)).toBe(true);
    failing.mockRestore();
  });
});

describe('endLockSession (cleanupTripWithLa)', () => {
  it('flag on이면 셀 lock을 비운다 / flag off이면 DO 호출 0', async () => {
    const on = await makeCtx();
    const tick = await beginCronCellTick(on.env);
    const [trip] = await overlayCronTrips(tick!, [tripOf('t-i')], NOW);
    await endLockSession(on.env, trip, 'cleanup', NOW);
    expect((await fetchCells(on.raw, 't-i')).lock?.lock).toBeUndefined();

    const off = await makeCtx('off');
    await endLockSession(off.env, tripOf('t-j'), 'cleanup', NOW);
    expect(off.calls).toEqual([]);
  });

  it('DO 오류는 삼킨다(trip 정리 흐름을 막지 않는다)', async () => {
    const { env } = await makeCtx();
    vi.spyOn(env.TRIP_DO as DurableObjectNamespace, 'get').mockImplementation(() => {
      throw new Error('do down');
    });
    await expect(endLockSession(env, tripOf('t-k'), 'cleanup', NOW)).resolves.toBeUndefined();
  });
});

describe('clearLaTokenViaCell (§10 cron token-invalid)', () => {
  it('셀 토큰이 expectedToken이면 비우고(ended), 그 사이 새 토큰이 등록됐으면 셀 값을 trip에 되돌린다', async () => {
    const { env, raw } = await makeCtx();
    const tick = await beginCronCellTick(env);
    const [trip] = await overlayCronTrips(
      tick!,
      [tripOf('t-l', { activityPushToken: 'tok-old', activityState: 'live' })],
      NOW,
    );
    await runLaOp(raw, 't-l', { type: 'registerLaToken', source: 'la-register', token: 'tok-new' }, NOW);
    trip.activityPushToken = undefined;
    trip.activityState = 'ended';
    await clearLaTokenViaCell(trip, 'tok-old', 'token-invalid', NOW);
    expect(trip.activityPushToken).toBe('tok-new');
    expect(trip.activityState).toBe('live');
    expect((await fetchCells(raw, 't-l')).la?.activityPushToken).toBe('tok-new');

    trip.activityPushToken = undefined;
    trip.activityState = 'ended';
    await clearLaTokenViaCell(trip, 'tok-new', 'token-invalid', NOW);
    expect((await fetchCells(raw, 't-l')).la?.activityPushToken).toBeUndefined();
    expect((await fetchCells(raw, 't-l')).la?.activityState).toBe('ended');
  });

  it('추적 안 된 trip은 no-op(legacy)', async () => {
    const { calls } = await makeCtx();
    await clearLaTokenViaCell(tripOf('t-m'), 'x', 'token-invalid', NOW);
    expect(calls).toEqual([]);
  });
});
