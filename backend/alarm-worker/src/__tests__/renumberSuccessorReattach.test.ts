/**
 * #3158 — `attemptTimetableSuccessorReattach` 통합: 옛 번호 arrival이 stale로 계속 매칭돼 vanish-swap이
 * 시도조차 안 되는 프로덕션 173 경로(lock이 3009로 머무름)에서 후속(3045) 관측 시 lock 이동.
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import { attemptTimetableSuccessorReattach } from '../scheduled';
import { writeSelfPollPosition } from '../selfPollPosition';
import { makeTripEventSink } from './helpers/replay20261019';
import type { PositionEntry } from '../seoul';
import type { BoardingLockMeta, Env, Trip, Waypoint } from '../types';

const NOW = Date.UTC(2026, 9, 21, 6 - 9, 33, 46); // 2026-10-21(수) 06:33:46 KST
const WAYPOINT: Waypoint = { stationName: '뚝섬', line: '2', kind: 'destination' } as Waypoint;

function lockOf(trainCode: string, line = '2'): BoardingLockMeta {
  return { trainCode, line, subwayId: '1002', selectedDepartureTime: NOW - 180_000, segmentStations: ['성수', '뚝섬'], expiresAt: NOW + 600_000 };
}
function row(trainCode: string, over: Partial<PositionEntry> = {}): PositionEntry {
  return { trainCode, stationName: '성수', trainSttus: 2, isUp: false, recptnMs: NOW - 20_000, terminus: '성수종착', ...over };
}

async function setup(positions: PositionEntry[] | null) {
  const kv = new InMemoryKV(() => NOW);
  if (positions) await writeSelfPollPosition(kv as unknown as KVNamespace, '2', positions, NOW - 5_000);
  const { db, events } = makeTripEventSink();
  const getSpy = vi.spyOn(kv, 'get');
  const env = { TRIPS: kv, DB: db } as unknown as Env;
  const trip = { token: 'tok-3158-reattach', waypoints: [WAYPOINT], consecutiveEtaMissing: 3 } as unknown as Trip;
  return { env, trip, events, getSpy };
}

describe('attemptTimetableSuccessorReattach', () => {
  it('lock이 3009로 머문 채 후속 3045가 외선으로 관측되면 3045로 이동 + D1 timetable-successor 1행', async () => {
    const { env, trip, events } = await setup([row('3045')]);
    const next = await attemptTimetableSuccessorReattach(trip, WAYPOINT, lockOf('3009'), env, NOW, vi.fn());
    expect(next?.trainCode).toBe('3045');
    expect(trip.boardingLock?.trainCode).toBe('3045');
    expect(trip.consecutiveEtaMissing).toBe(0);
    expect(events).toEqual([
      { kind: 'lock-reattach', station: '뚝섬', line: '2', meta: { source: 'timetable-successor', from: '3009', to: '3045', timetableFrom: '3009' } },
    ]);
  });

  it('vanish-swap이 먼저 옮긴 lock(1509)은 표식의 원 열차(3009)로 조회해 3045로 정정, 표식 소거', async () => {
    const { env, trip } = await setup([row('3045')]);
    trip.renumberSuccessor = { from: '3009', swappedTo: '1509', armedAt: NOW - 30_000 };
    const next = await attemptTimetableSuccessorReattach(trip, WAYPOINT, lockOf('1509'), env, NOW, vi.fn());
    expect(next?.trainCode).toBe('3045');
    expect(trip.renumberSuccessor).toBeUndefined();
  });

  it('거부: 후속 미관측 -> null, trip/이벤트 불변 (기존 동작)', async () => {
    const { env, trip, events } = await setup([row('3047')]);
    expect(await attemptTimetableSuccessorReattach(trip, WAYPOINT, lockOf('3009'), env, NOW, vi.fn())).toBeNull();
    expect(trip.boardingLock).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('거부: self-poll 피드가 없으면 null', async () => {
    const { env, trip } = await setup(null);
    expect(await attemptTimetableSuccessorReattach(trip, WAYPOINT, lockOf('3009'), env, NOW, vi.fn())).toBeNull();
  });

  it('거부: 타 노선(7호선)/시간표 항목 없는 번호는 KV를 읽지도 않는다', async () => {
    const { env, trip, getSpy } = await setup([row('3045')]);
    expect(await attemptTimetableSuccessorReattach(trip, WAYPOINT, lockOf('3009', '7'), env, NOW, vi.fn())).toBeNull();
    expect(await attemptTimetableSuccessorReattach(trip, WAYPOINT, lockOf('2999'), env, NOW, vi.fn())).toBeNull();
    getSpy.mockClear();
    expect(await attemptTimetableSuccessorReattach(trip, WAYPOINT, lockOf('2999'), env, NOW, vi.fn())).toBeNull();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('거부: lock이 이미 후속 번호면 no-op', async () => {
    const { env, trip } = await setup([row('3045')]);
    trip.renumberSuccessor = { from: '3045', swappedTo: '3045', armedAt: NOW - 1_000 };
    expect(await attemptTimetableSuccessorReattach(trip, WAYPOINT, lockOf('3045'), env, NOW, vi.fn())).toBeNull();
  });
});
