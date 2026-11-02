/**
 * #2629 PR-3 — 위치 따라잡기 계획 단계의 실패는 fail-open(현행 1 tick 1 waypoint)이다.
 * positions 조회가 던지면 따라잡기만 건너뛰고 로그를 남긴다(이후 estimate의 예외 처리는 기존 호출자 책임).
 */
import { describe, expect, it, vi } from 'vitest';
import { createEmptyScheduledStats, runTrainCodeTracking, type ScheduledDeps } from '../scheduled';
import type { BoardingLockMeta, Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = 1_800_000_000_000;
const wp = (stationName: string, kind: Waypoint['kind']): Waypoint => ({ stationName, line: '7', kind });

describe('positions 조회 실패', () => {
  it('따라잡기를 건너뛰고(trip.waypoints 불변) fail-open 로그를 남긴다', async () => {
    const waypoints = [wp('강남구청', 'intermediate'), wp('학동', 'intermediate'), wp('논현', 'destination')];
    const lock: BoardingLockMeta = {
      trainCode: '7077',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: NOW,
      segmentStations: ['청담', '강남구청', '학동', '논현'],
      expiresAt: NOW + 3_600_000,
    };
    const trip = {
      token: 'tok-2629-failopen',
      route: { type: 'direct', line: '7', stops: 3 },
      destination: '논현',
      waypoints,
      boardingLock: lock,
      expiresAt: NOW + 3_600_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW,
    } as Trip;
    const fetchPositions = vi.fn().mockRejectedValue(new Error('seoul down'));
    const deps = { seoul: { fetchArrivals: vi.fn().mockResolvedValue([]), fetchPositions } } as unknown as ScheduledDeps;
    const env = { TRIPS: new InMemoryKV() as unknown as KVNamespace } as Env;
    const log = vi.fn();

    await expect(
      runTrainCodeTracking(trip, waypoints[0], lock, env, deps, createEmptyScheduledStats(NOW), NOW, log, () => 'id'),
    ).rejects.toThrow('seoul down');

    expect(log).toHaveBeenCalledWith(
      'position-catchup: plan error (fail-open)',
      expect.objectContaining({ error: 'Error: seoul down' }),
    );
    expect(trip.waypoints).toEqual(waypoints);
  });
});
