import { describe, expect, it } from 'vitest';
import { AUTO_LOCK_TTL_MS, attemptAutoLock } from '../autoLock';
import { SWAP_LOCK_TTL_MS } from '../lockSwap';
import { type ArrivalEntry } from '../seoul';
import type { Waypoint } from '../types';
import {
  FIXTURE_NOW as NOW,
  makeSeoulFixture as makeSeoul,
  makeTripFixture as makeTrip,
} from './helpers/testFixtures';

const target: Waypoint = { stationName: '역삼', line: '2', kind: 'intermediate' };

function arrival(overrides: Partial<ArrivalEntry>): ArrivalEntry {
  return {
    destination: 'X',
    arrivalSeconds: 0,
    trainCode: 'T1',
    isUp: true,
    subwayNm: '2호선',
    arvlCd: 2,
    ...overrides,
  };
}

describe('attemptAutoLock (#916 A1)', () => {
  it('단일 후보 → lock 합성 성공, origin이 segmentStations 첫 원소', async () => {
    const lock = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 2 })]),
      now: NOW,
    });
    expect(lock).not.toBeNull();
    expect(lock?.trainCode).toBe('T1');
    expect(lock?.line).toBe('2');
    expect(lock?.subwayId).toBe('1002');
    expect(lock?.segmentStations).toEqual(['강남', '역삼', '선릉']);
    expect(lock?.expiresAt).toBe(NOW + AUTO_LOCK_TTL_MS);
    expect(lock?.selectedDepartureTime).toBe(NOW);
    // #916 follow-up A — server-set 마커. POST /trips 재등록 시 보존 분기의 키.
    expect(lock?.autoLockedAt).toBe(NOW);
  });

  it('AUTO_LOCK_TTL_MS는 SWAP_LOCK_TTL_MS와 동일 (단일 정책)', () => {
    expect(AUTO_LOCK_TTL_MS).toBe(SWAP_LOCK_TTL_MS);
  });

  it('ambiguity(같은 arvlCd 우선순위 후보 2+) → null', async () => {
    const lock = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([
        arrival({ trainCode: 'T1', arvlCd: 2 }),
        arrival({ trainCode: 'T2', arvlCd: 2 }),
      ]),
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('arrivals 비어있음 → null', async () => {
    const lock = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([]),
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('subwayId 매핑 불가 line → null', async () => {
    const lock = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: { stationName: '역삼', line: 'XX', kind: 'intermediate' },
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 2 })]),
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('legStations 비어있음(waypoints 모두 다른 line) → null', async () => {
    const lock = await attemptAutoLock({
      trip: makeTrip({
        waypoints: [{ stationName: '역삼', line: '3', kind: 'destination' }],
      }),
      targetWaypoint: target, // target.line='2'와 waypoints line='3' 불일치
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 2 })]),
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('direction=down → 하행 trainCode만 매칭', async () => {
    const lock = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'down',
      seoul: makeSeoul([
        arrival({ trainCode: 'TU', arvlCd: 2, isUp: true }),
        arrival({ trainCode: 'TD', arvlCd: 2, isUp: false }),
      ]),
      now: NOW,
    });
    expect(lock?.trainCode).toBe('TD');
  });

  it('direction=null → 양방향 허용 (단일 후보)', async () => {
    const lock = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: null,
      seoul: makeSeoul([arrival({ trainCode: 'TD', arvlCd: 2, isUp: false })]),
      now: NOW,
    });
    expect(lock?.trainCode).toBe('TD');
  });

  it('origin이 legStations 첫 원소와 같으면 dedup (중복 prepend 방지)', async () => {
    // waypoints[0].stationName === originStation인 (방어적) 케이스. 정상 운영에서는 발생하지 않지만
    // 클라가 origin name과 waypoints를 어긋나게 보낸 회귀에 대해 segmentStations에 중복이 없어야 한다.
    const lock = await attemptAutoLock({
      trip: makeTrip({
        waypoints: [
          { stationName: '강남', line: '2', kind: 'intermediate' },
          { stationName: '역삼', line: '2', kind: 'destination' },
        ],
      }),
      targetWaypoint: { stationName: '강남', line: '2', kind: 'intermediate' },
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 2 })]),
      now: NOW,
    });
    expect(lock?.segmentStations).toEqual(['강남', '역삼']);
  });
});
