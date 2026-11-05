/**
 * #3055 / #3300 옵션 D PR-3b — scheduled.ts lock 변경 지점(plan §3 #10~#18)을 셀 op에 연결한 효과.
 * 첫 지점: `attemptTimetableSuccessorReattach`(#14 swapAuto). flag off 동작은 `renumberSuccessorReattach.test.ts`가 그대로 보호한다.
 */
import { describe, expect, it, vi } from 'vitest';
import { beginCronCellTick, overlayCronTrips } from '../cronLockCell';
import { attemptTimetableSuccessorReattach } from '../scheduled';
import { writeSelfPollPosition } from '../selfPollPosition';
import type { PositionEntry } from '../seoul';
import { fetchCells, resetCellStageCache, runLockOp } from '../tripDoCells';
import { setTripDoFlag } from '../tripDoFlag';
import type { BoardingLockMeta, Env, Trip, Waypoint } from '../types';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';
import { makeTripEventSink } from './helpers/replay20261019';
import { InMemoryKV } from './inMemoryKv';

const NOW = Date.UTC(2026, 9, 21, 6 - 9, 33, 46); // 2026-10-21(수) 06:33:46 KST
const WAYPOINT: Waypoint = { stationName: '뚝섬', line: '2', kind: 'destination' } as Waypoint;
const TOKEN = 'tok-3055-sites';

const lockOf = (trainCode: string): BoardingLockMeta => ({
  trainCode,
  line: '2',
  subwayId: '1002',
  selectedDepartureTime: NOW - 180_000,
  segmentStations: ['성수', '뚝섬'],
  expiresAt: NOW + 600_000,
});
const row = (trainCode: string): PositionEntry => ({
  trainCode,
  stationName: '성수',
  trainSttus: 2,
  isUp: false,
  recptnMs: NOW - 20_000,
  terminus: '성수종착',
});

async function setup() {
  const kv = new InMemoryKV(() => NOW);
  await writeSelfPollPosition(kv as unknown as KVNamespace, '2', [row('3045')], NOW - 5_000);
  const doNs = makeFakeTripDoNamespace();
  const { db, events } = makeTripEventSink();
  const env = { TRIPS: kv as unknown as KVNamespace, TRIP_DO: doNs.ns, DB: db } as unknown as Env;
  await setTripDoFlag(env.TRIPS, 'lock@1');
  resetCellStageCache(kv);
  const trip = {
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 1 },
    destination: '뚝섬',
    waypoints: [WAYPOINT],
    expiresAt: NOW + 3_600_000,
    createdAt: NOW - 600_000,
    alarmAtEpochMs: NOW,
    boardingLock: lockOf('3009'),
    consecutiveEtaMissing: 3,
  } as unknown as Trip;
  const tick = await beginCronCellTick(env);
  const [tracked] = await overlayCronTrips(tick!, [trip], NOW);
  return { env, events, trip: tracked };
}

describe('#14 attemptTimetableSuccessorReattach — swapAuto', () => {
  it('lock@1 applied: 셀 lock이 후속 3045로 옮겨지고 카운터가 0이며 lock-reattach 1행', async () => {
    const { env, trip, events } = await setup();
    const next = await attemptTimetableSuccessorReattach(trip, WAYPOINT, lockOf('3009'), env, NOW, vi.fn());
    expect(next?.trainCode).toBe('3045');
    expect(trip.boardingLock?.trainCode).toBe('3045');
    expect(trip.consecutiveEtaMissing).toBe(0);
    const { lock } = await fetchCells(env, TOKEN);
    expect(lock?.lock?.trainCode).toBe('3045');
    expect(lock?.lockCodeHistory).toEqual(['3009']);
    expect(events.filter((e) => e.kind === 'lock-reattach')).toHaveLength(1);
  });

  it('lock@1 conflict: 사이에 사용자가 다른 lock을 붙였으면 이동하지 않고(null) lock-reattach도 남기지 않는다', async () => {
    const { env, trip, events } = await setup();
    const { lock: cell } = await fetchCells(env, TOKEN);
    await runLockOp(
      env,
      TOKEN,
      { type: 'userBoarded', source: 'confirm', expectedRev: cell!.rev, releaseFirst: true, lock: lockOf('3777') },
      NOW,
    );
    const next = await attemptTimetableSuccessorReattach(trip, WAYPOINT, lockOf('3009'), env, NOW, vi.fn());
    expect(next).toBeNull();
    expect(trip.boardingLock?.trainCode).toBe('3777');
    expect(events.filter((e) => e.kind === 'lock-reattach')).toEqual([]);
    expect(events.filter((e) => e.kind === 'lock-op-conflict').map((e) => e.meta)).toEqual([
      { op: 'swapAuto', source: 'cron-timetable-successor' },
    ]);
  });
});
