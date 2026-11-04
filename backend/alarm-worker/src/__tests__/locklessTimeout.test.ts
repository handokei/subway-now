/**
 * K5 #2926 PR-B — lock 없는 trip 시한 종료 판정(순수). 10/21 사용자 결정: "예상 소요 x1.5 + 15분".
 * 기대값은 스펙 수식에서 직접 계산한다(구현 상수를 import해 거울로 맞추지 않는다).
 */
import { describe, expect, it } from 'vitest';
import { getTransferSeconds } from '../../../../src/shared/utils/transferTimes';
import {
  estimateTripDurationSec,
  evaluateLocklessTimeout,
  locklessTimeoutDeadline,
} from '../locklessTimeout';
import type { Trip, Waypoint } from '../types';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const wp = (stationName: string, kind: Waypoint['kind'], line = '7', extra: Partial<Waypoint> = {}): Waypoint => ({
  stationName,
  line,
  kind,
  ...extra,
});

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  const waypoints = [wp('a', 'intermediate'), wp('b', 'intermediate'), wp('c', 'intermediate'), wp('d', 'destination')];
  return {
    token: 't',
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '용마산',
    waypoints,
    routeWaypoints: waypoints,
    expiresAt: T0 + 9 * 60 * MIN,
    createdAt: T0,
    alarmAtEpochMs: T0,
    ...overrides,
  } as Trip;
}

const lockWith = (expiresAt: number) =>
  ({
    trainCode: '1',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: 0,
    segmentStations: [],
    expiresAt,
  }) as Trip['boardingLock'];

describe('estimateTripDurationSec', () => {
  it('첫 waypoint의 remainingSecToDest가 있으면 그것을 쓴다', () => {
    const trip = makeTrip({
      routeWaypoints: [wp('a', 'intermediate', '7', { remainingSecToDest: 1000 }), wp('d', 'destination')],
    });
    expect(estimateTripDurationSec(trip)).toBe(1000);
  });

  it('remainingSecToDest가 없으면 routeWaypoints 남은 hop x 90s', () => {
    const trip = makeTrip({
      routeWaypoints: [wp('a', 'intermediate'), wp('b', 'intermediate'), wp('c', 'intermediate'), wp('d', 'destination')],
      waypoints: [wp('d', 'destination')], // 진행분은 원본이 아니다 — routeWaypoints 우선
    });
    expect(estimateTripDurationSec(trip)).toBe(3 * 90);
  });

  it('환승 waypoint마다 getTransferSeconds를 더한다(환승 횟수 무관 순회)', () => {
    const trip = makeTrip({
      routeWaypoints: [
        wp('a', 'intermediate', '7'),
        wp('건대입구', 'transfer', '7'),
        wp('b', 'intermediate', '2'),
        wp('교대', 'transfer', '2'),
        wp('c', 'destination', '3'),
      ],
    });
    expect(estimateTripDurationSec(trip)).toBe(
      4 * 90 + getTransferSeconds('7', '2', '건대입구') + getTransferSeconds('2', '3', '교대'),
    );
  });

  it('routeWaypoints가 비어 있으면 0', () => {
    expect(estimateTripDurationSec(makeTrip({ routeWaypoints: [], waypoints: [] }))).toBe(0);
  });

  it('routeWaypoints가 없으면 추정 불가(undefined) — 진행분 waypoints로 대신하지 않는다(전진할수록 시한이 줄어 정상 trip 오종료)', () => {
    expect(estimateTripDurationSec(makeTrip({ routeWaypoints: undefined }))).toBeUndefined();
    expect(locklessTimeoutDeadline(makeTrip({ routeWaypoints: undefined }))).toBeUndefined();
    expect(evaluateLocklessTimeout(makeTrip({ routeWaypoints: undefined }), T0 + 999 * 60 * MIN)).toBe('none');
  });

  it('remainingSecToDest가 유한 비음수가 아니면(음수) 무시하고 fallback', () => {
    const bad = makeTrip({
      routeWaypoints: [wp('a', 'intermediate', '7', { remainingSecToDest: -5 }), wp('d', 'destination')],
    });
    expect(estimateTripDurationSec(bad)).toBe(90);
  });
});

describe('locklessTimeoutDeadline — 시작 시각 = max(createdAt, lock 해제, boardingResponse.at)', () => {
  const window = 270 * 1.5 * 1000 + 15 * MIN;

  it('createdAt 기준(lock 이력 없음)', () => {
    expect(locklessTimeoutDeadline(makeTrip())).toBe(T0 + window);
  });

  it('boardingResponse.at이 더 늦으면 그 시각 기준', () => {
    const trip = makeTrip({ boardingResponse: { legKey: 'k', at: T0 + 10 * MIN } });
    expect(locklessTimeoutDeadline(trip)).toBe(T0 + 10 * MIN + window);
  });

  it('lock 해제 후(locklessSince)면 해제 시각 기준', () => {
    const trip = makeTrip({ lockEverAttached: true, locklessSince: T0 + 30 * MIN });
    expect(locklessTimeoutDeadline(trip)).toBe(T0 + 30 * MIN + window);
  });

  it('만료됐지만 남아 있는 lock은 expiresAt이 해제 시각', () => {
    const trip = makeTrip({ lockEverAttached: true, boardingLock: lockWith(T0 + 20 * MIN) });
    expect(locklessTimeoutDeadline(trip)).toBe(T0 + 20 * MIN + window);
  });

  it('lock 이력이 있는데 해제 시각을 모르면(구 레코드) 판정 불가 -> undefined', () => {
    expect(locklessTimeoutDeadline(makeTrip({ lockEverAttached: true }))).toBeUndefined();
  });
});

describe('evaluateLocklessTimeout', () => {
  const deadline = T0 + 270 * 1.5 * 1000 + 15 * MIN;

  it('기한 직전은 none, 기한 초과는 end', () => {
    expect(evaluateLocklessTimeout(makeTrip(), deadline)).toBe('none');
    expect(evaluateLocklessTimeout(makeTrip(), deadline + 1)).toBe('end');
  });

  it('lock 활성이면 아무리 오래돼도 none', () => {
    const active = makeTrip({ boardingLock: lockWith(T0 + 999 * MIN) });
    expect(evaluateLocklessTimeout(active, deadline + 60 * MIN, )).toBe('none');
  });

  it('lock 해제 후에는 해제 시각부터 다시 센다', () => {
    const trip = makeTrip({ lockEverAttached: true, locklessSince: deadline });
    expect(evaluateLocklessTimeout(trip, deadline + 1)).toBe('none');
    expect(evaluateLocklessTimeout(trip, deadline + 270 * 1.5 * 1000 + 15 * MIN + 1)).toBe('end');
  });

  it('해제 시각 미상(구 레코드)이면 none — 배포 직후 진행 중 환승 trip 오종료 방지', () => {
    expect(evaluateLocklessTimeout(makeTrip({ lockEverAttached: true }), deadline + 600 * MIN)).toBe('none');
  });
});
