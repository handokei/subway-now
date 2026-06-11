import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_LOCK_CONFIDENCE_THRESHOLD,
  AUTO_LOCK_TTL_MS,
  attemptAutoLock,
  recordAutoLockConfidence,
} from '../autoLock';
import { METRIC_KIND } from '../metrics';
import { SWAP_LOCK_TTL_MS } from '../lockSwap';
import { type ArrivalEntry } from '../seoul';
import type { Waypoint } from '../types';
import {
  FIXTURE_NOW as NOW,
  makeSeoulFixture as makeSeoul,
  makeSeoulFixtureByStation,
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
    // 기본값 arvlCd=1(도착) — confidence gate(#1018)를 의도치 않게 트리거하지 않도록.
    // arvlCd=2(출발)를 테스트하려면 명시 지정한다.
    arvlCd: 1,
    ...overrides,
  };
}

describe('attemptAutoLock (#916 A1)', () => {
  it('단일 후보 → lock 합성 성공, origin이 segmentStations 첫 원소', async () => {
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
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
    const { lock } = await attemptAutoLock({
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
    const { lock } = await attemptAutoLock({
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
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: { stationName: '역삼', line: 'XX', kind: 'intermediate' },
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('legStations 비어있음(waypoints 모두 다른 line) → null', async () => {
    const { lock } = await attemptAutoLock({
      trip: makeTrip({
        waypoints: [{ stationName: '역삼', line: '3', kind: 'destination' }],
      }),
      targetWaypoint: target, // target.line='2'와 waypoints line='3' 불일치
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('direction=down → 하행 trainCode만 매칭', async () => {
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'down',
      seoul: makeSeoul([
        arrival({ trainCode: 'TU', arvlCd: 1, isUp: true }),
        arrival({ trainCode: 'TD', arvlCd: 1, isUp: false }),
      ]),
      now: NOW,
    });
    expect(lock?.trainCode).toBe('TD');
  });

  it('direction=null → 양방향 허용 (단일 후보)', async () => {
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: null,
      seoul: makeSeoul([arrival({ trainCode: 'TD', arvlCd: 1, isUp: false })]),
      now: NOW,
    });
    expect(lock?.trainCode).toBe('TD');
  });

  it('origin이 legStations 첫 원소와 같으면 dedup (중복 prepend 방지)', async () => {
    // waypoints[0].stationName === originStation인 (방어적) 케이스. 정상 운영에서는 발생하지 않지만
    // 클라가 origin name과 waypoints를 어긋나게 보낸 회귀에 대해 segmentStations에 중복이 없어야 한다.
    const { lock } = await attemptAutoLock({
      trip: makeTrip({
        waypoints: [
          { stationName: '강남', line: '2', kind: 'intermediate' },
          { stationName: '역삼', line: '2', kind: 'destination' },
        ],
      }),
      targetWaypoint: { stationName: '강남', line: '2', kind: 'intermediate' },
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
    });
    expect(lock?.segmentStations).toEqual(['강남', '역삼']);
  });
});

describe('attemptAutoLock RC1 confidence gate (#1018)', () => {
  // 공통 헬퍼: 역삼에 T1(arvlCd=2), 강남에 지정된 arrivals를 반환하는 seoul fixture.
  function makeDepartedSeoul(originArrivals: ArrivalEntry[] = []) {
    return makeSeoulFixtureByStation({
      역삼: [arrival({ trainCode: 'T1', arvlCd: 2 })],
      강남: originArrivals,
    });
  }

  // 공통 헬퍼: 기본 confidence gate 테스트 입력 + 선택적 override.
  function callGate(
    seoul: ReturnType<typeof makeSeoulFixtureByStation>,
    extra: Partial<Parameters<typeof attemptAutoLock>[0]> = {},
  ) {
    return attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul,
      now: NOW,
      ...extra,
    });
  }

  it('AUTO_LOCK_CONFIDENCE_THRESHOLD는 2', () => {
    expect(AUTO_LOCK_CONFIDENCE_THRESHOLD).toBe(2);
  });

  it('arvlCd=2 + origin에 동일 trainCode 있음 → confidence=2 → 통과', async () => {
    // next-waypoint: T1이 arvlCd=2 (출발), origin: T1도 보임 → score=2, threshold=2 → pass
    const { lock } = await callGate(makeDepartedSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]));
    expect(lock).not.toBeNull();
    expect(lock?.trainCode).toBe('T1');
  });

  it('arvlCd=2 + origin에 없음 + 신호 없음 → confidence=0 → null', async () => {
    // next-waypoint: T1이 arvlCd=2, origin: 빈 배열 → score=0 < threshold=2 → null
    const { lock } = await callGate(makeDepartedSeoul());
    expect(lock).toBeNull();
  });

  it('arvlCd=2 + origin 없음 + boardingPromptState.fired + 최근 motion → confidence=2 → 통과', async () => {
    // origin 미확인(0) + fired(+1) + lastMotionAt within 3min(+1) = 2 → pass
    const { lock } = await callGate(makeDepartedSeoul(), {
      boardingPromptState: { fired: true, lastFiredAt: NOW - 60_000 },
      lastMotionAt: NOW - 60_000, // 1분 전 — 3분 이내
    });
    expect(lock).not.toBeNull();
    expect(lock?.trainCode).toBe('T1');
  });

  it('arvlCd=2 + origin 없음 + fired만 있음 → confidence=1 → null', async () => {
    // origin(0) + fired(+1) = 1 < threshold=2 → null
    const { lock } = await callGate(makeDepartedSeoul(), {
      boardingPromptState: { fired: true, lastFiredAt: NOW - 60_000 },
      // lastMotionAt 미전달
    });
    expect(lock).toBeNull();
  });

  it('arvlCd=2 + origin 없음 + 최근 motion만 있음 → confidence=1 → null', async () => {
    // origin(0) + lastMotionAt(+1) = 1 < threshold=2 → null
    const { lock } = await callGate(makeDepartedSeoul(), { lastMotionAt: NOW - 60_000 });
    expect(lock).toBeNull();
  });

  it('arvlCd=2 + origin 없음 + motion이 너무 오래됨(>3min) → confidence=0 → null', async () => {
    const { lock } = await callGate(makeDepartedSeoul(), {
      boardingPromptState: { fired: false },
      lastMotionAt: NOW - 4 * 60_000, // 4분 전 — 3분 초과
    });
    expect(lock).toBeNull();
  });

  it('arvlCd=1(도착) — confidence gate 미적용, origin fetch 없이 정상 통과', async () => {
    // arvlCd=2가 아니므로 confidence 체크 자체를 하지 않음 → 기존 경로 유지
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
    });
    expect(lock).not.toBeNull();
    expect(lock?.trainCode).toBe('T1');
  });

  it('arvlCd=0(진입) — confidence gate 미적용, 정상 통과', async () => {
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 0 })]),
      now: NOW,
    });
    expect(lock).not.toBeNull();
  });

  it('arvlCd=2 + origin에 다른 trainCode만 있음 → confidence=0 → null', async () => {
    // origin arrivals에는 T2만 있고 T1은 없음 → origin 미확인(0) + 소프트 신호 없음 → null
    const { lock } = await callGate(
      makeDepartedSeoul([arrival({ trainCode: 'T2', arvlCd: 1 })]),
    );
    expect(lock).toBeNull();
  });
});

describe('attemptAutoLock confidence trace (#1171)', () => {
  // 공통 헬퍼 재사용 — 본 describe는 result.confidenceTrace 분포 적재용 노출 검증.
  function makeDepartedSeoul(originArrivals: ArrivalEntry[] = []) {
    return makeSeoulFixtureByStation({
      역삼: [arrival({ trainCode: 'T1', arvlCd: 2 })],
      강남: originArrivals,
    });
  }

  it('arvlCd=2 + origin match → trace.score=2, passed=true', async () => {
    const result = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeDepartedSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
    });
    expect(result.lock).not.toBeNull();
    expect(result.confidenceTrace).toEqual({ score: 2, passed: true });
  });

  it('arvlCd=2 + 모든 신호 충족 → trace.score=4, passed=true', async () => {
    // origin(+2) + fired(+1) + recent motion(+1) = 4
    const result = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeDepartedSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
      boardingPromptState: { fired: true, lastFiredAt: NOW - 60_000 },
      lastMotionAt: NOW - 60_000,
    });
    expect(result.lock).not.toBeNull();
    expect(result.confidenceTrace).toEqual({ score: 4, passed: true });
  });

  it('arvlCd=2 + 신호 부족 → trace.score=0, passed=false, lock=null', async () => {
    const result = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeDepartedSeoul(),
      now: NOW,
    });
    expect(result.lock).toBeNull();
    expect(result.confidenceTrace).toEqual({ score: 0, passed: false });
  });

  it('arvlCd=1 → confidence gate 미평가, trace undefined', async () => {
    const result = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
    });
    expect(result.lock).not.toBeNull();
    expect(result.confidenceTrace).toBeUndefined();
  });

  it('subwayId 매핑 실패 → trace undefined (gate 미도달)', async () => {
    const result = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: { stationName: '역삼', line: 'XX', kind: 'intermediate' },
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 2 })]),
      now: NOW,
    });
    expect(result.lock).toBeNull();
    expect(result.confidenceTrace).toBeUndefined();
  });
});

describe('recordAutoLockConfidence (#1171)', () => {
  it('histogram point를 AE writer에 적재 (kind=AUTO_LOCK_CONFIDENCE_BREAKDOWN)', () => {
    const writeDataPoint = vi.fn();
    recordAutoLockConfidence({ writeDataPoint }, 'tok-1234-rest', { score: 3, passed: true });
    // count=1, mean=3, p95=3 세 point (writeMetricDataPoints schema). 0 sample은 없으므로 모두 적재.
    expect(writeDataPoint).toHaveBeenCalledTimes(3);
    const labels = writeDataPoint.mock.calls.map((c) => c[0].blobs[0]);
    expect(labels).toContain(`phase3:${METRIC_KIND.AUTO_LOCK_CONFIDENCE_BREAKDOWN}:count`);
    expect(labels).toContain(`phase3:${METRIC_KIND.AUTO_LOCK_CONFIDENCE_BREAKDOWN}:mean`);
    expect(labels).toContain(`phase3:${METRIC_KIND.AUTO_LOCK_CONFIDENCE_BREAKDOWN}:p95`);
  });

  it('score=0 sample → 0값 skip 동작 (count point는 적재, mean/p95는 0 skip)', () => {
    const writeDataPoint = vi.fn();
    recordAutoLockConfidence({ writeDataPoint }, 'tok-0000', { score: 0, passed: false });
    // count=1 한 건만 적재 (mean=0, p95=0은 writeMetricDataPoints 0 skip).
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe(
      `phase3:${METRIC_KIND.AUTO_LOCK_CONFIDENCE_BREAKDOWN}:count`,
    );
  });
});
