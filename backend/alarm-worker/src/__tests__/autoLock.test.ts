import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_LOCK_CONFIDENCE_THRESHOLD,
  AUTO_LOCK_TTL_MS,
  attemptAutoLock,
  POSITION_RECPTN_MAX_AGE_MS,
  recordAutoLockConfidence,
} from '../autoLock';
import { METRIC_KIND } from '../metrics';
import { SWAP_LOCK_TTL_MS } from '../lockSwap';
import { type ArrivalEntry, type PositionEntry } from '../seoul';
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

// PositionEntry 기본값 fixture — recptnMs=0 (age 가드 skip), isUp=true 기본.
// `selfPollPositions` 입력으로 PositionEntry 전체 타입을 받아 `synthesizeArrivalsFromPositions`
// 등 새 fallback 분기와 기존 strongCB/recptnMs 가드 모두 일관되게 호출된다.
function position(overrides: Partial<PositionEntry> & { trainCode: string }): PositionEntry {
  return {
    stationName: '',
    trainSttus: 0,
    isUp: true,
    recptnMs: 0,
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

  it('chosen arrival subwayNm 이 line 과 불일치 → null (2단 cross-check, #1626 follow-up)', async () => {
    // 2026-06-22 trip B 회귀 재현 — 2호선 trip 에 trainCode=3222 push 5건 발사.
    // pickAutoTrainCode 가 matchLine 우회로 chosen 후 subwayNm 이 빈 문자열인 entry 시뮬.
    // 2단 cross-check 가 lock 합성을 차단해야 한다 (wrong-line trainCode 30분 TTL 지속 봉쇄).
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1, subwayNm: '' })]),
      now: NOW,
    });
    expect(lock).toBeNull();
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

describe('attemptAutoLock allowedLines gate (#1439 ADR-015 §9)', () => {
  it('targetWaypoint.line이 allowedLines 안 → lock 합성 허용', async () => {
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
      allowedLines: new Set(['2', '5']),
    });
    expect(lock?.line).toBe('2');
  });

  it('targetWaypoint.line이 allowedLines 밖 → null (cross-line 매핑 reject)', async () => {
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target, // line=2
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
      allowedLines: new Set(['5', '6']),
    });
    expect(lock).toBeNull();
  });

  it('allowedLines 미전달 → 구 호출자 호환 (검증 skip)', async () => {
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
    });
    expect(lock).not.toBeNull();
  });
});

function passingGateOutcome(): Parameters<typeof attemptAutoLock>[0]['gateOutcome'] {
  return {
    pass: true as const,
    metrics: {
      count: 3,
      gpsAvgKmh: 20,
      avgAccuracyMeters: 10,
      motion: 'automotive',
      start: { lat: 0, lng: 0 },
      end: { lat: 0, lng: 0.001 },
      mapMatchedKmh: null,
    },
    fusedSpeedKmh: 20,
  };
}
function failingGateOutcome(): Parameters<typeof attemptAutoLock>[0]['gateOutcome'] {
  return { pass: false as const, reason: 'window-too-small' as const };
}

/**
 * #1536 환경 분기 테스트 공통 fixture — `arrivalEntry` 와 옵션만 받아 attemptAutoLock 호출.
 * 중복 호출 패턴 제거(SonarCloud duplication < 3% 충족).
 */
function callEnvAutoLock(
  arrivalEntry: ArrivalEntry,
  opts: {
    environment?: Parameters<typeof attemptAutoLock>[0]['environment'];
    gateOutcome?: Parameters<typeof attemptAutoLock>[0]['gateOutcome'];
  } = {},
) {
  return attemptAutoLock({
    trip: makeTrip(),
    targetWaypoint: target,
    originStation: '강남',
    direction: 'up',
    seoul: makeSeoul([arrivalEntry]),
    now: NOW,
    environment: opts.environment,
    gateOutcome: opts.gateOutcome,
  });
}

describe('attemptAutoLock #1536 (S3) 환경 분기 consensusGate', () => {
  // it.each: (env, gate pass/fail, expected) 매트릭스로 surface + mixed 의 base-gate 의존성 일괄 검증.
  // surface = base gate pass-through, mixed = base gate + 합의 동시 강제 (둘 다 base fail 시 null).
  // underground 는 base gate 무관 — 별도 it 로 분리.
  it.each([
    ['surface', 'pass', 'lock'] as const,
    ['surface', 'fail', 'null'] as const,
    ['mixed', 'pass', 'lock'] as const,
    ['mixed', 'fail', 'null'] as const,
  ])('%s + base gate %s → %s', async (env, gate, expected) => {
    const { lock } = await callEnvAutoLock(arrival({ trainCode: 'T1', arvlCd: 1 }), {
      environment: env,
      gateOutcome: gate === 'pass' ? passingGateOutcome() : failingGateOutcome(),
    });
    if (expected === 'lock') {
      expect(lock?.trainCode).toBe('T1');
    } else {
      expect(lock).toBeNull();
    }
  });

  it('underground: base gate fail 도 arrival+lockAttachable 만 있으면 통과 (GPS 무관)', async () => {
    // underground 분기는 base gate 결과 무관하게 arrival + lockAttachable 2-of-2
    // (consensusGate.ts:149-158).
    const { lock } = await callEnvAutoLock(arrival({ trainCode: 'T1', arvlCd: 1 }), {
      environment: 'underground',
      gateOutcome: failingGateOutcome(),
    });
    expect(lock?.trainCode).toBe('T1');
  });

  it('underground + arrival arvlCd 범위 밖 (=5) → arrival signal 미존재 → null', async () => {
    // arvlCd=5 (PREV_ARRIVED) 는 0~3 범위 밖 → arrivalSignalPresent=false → 합의 미달.
    const { lock } = await callEnvAutoLock(arrival({ trainCode: 'T1', arvlCd: 5 }), {
      environment: 'underground',
      gateOutcome: passingGateOutcome(),
    });
    expect(lock).toBeNull();
  });

  // env / gateOutcome 미전달 시 모두 consensusGate skip (구 호출자 호환). 매트릭스로 한번에.
  it.each([
    ['env 미전달', {} as const],
    ['gateOutcome 미전달', { environment: 'underground' as const }],
  ])('%s → consensusGate skip', async (_label, opts) => {
    const { lock } = await callEnvAutoLock(arrival({ trainCode: 'T1', arvlCd: 1 }), opts);
    expect(lock).not.toBeNull();
  });
});

/**
 * #1614 Phase B — backend self-poll positionTrainAgreement wire (S4 #1537).
 *
 * selfPollPositions list forward 시 trainCode cross-match → consensusGate strongCB 통과 path
 * 활성화. underground 환경에서 base gate fail + arrival 부재라도 strongCB로 통과.
 */
function callAutoLockWithSelfPoll(
  arrivalEntry: ArrivalEntry,
  selfPollPositions: readonly PositionEntry[] | undefined,
  opts: {
    environment?: Parameters<typeof attemptAutoLock>[0]['environment'];
    gateOutcome?: Parameters<typeof attemptAutoLock>[0]['gateOutcome'];
  } = {},
) {
  return attemptAutoLock({
    trip: makeTrip(),
    targetWaypoint: target,
    originStation: '강남',
    direction: 'up',
    seoul: makeSeoul([arrivalEntry]),
    now: NOW,
    environment: opts.environment,
    gateOutcome: opts.gateOutcome,
    selfPollPositions,
  });
}

describe('attemptAutoLock #1614 Phase B selfPollPositions wire (S4)', () => {
  it.each([
    {
      label: 'trainCode 일치 + arvlCd 0~3 → strongCB pass (underground, base gate fail)',
      positions: [position({ trainCode: 'T1', stationName: '강남' })],
      arvlCd: 1,
      expected: 'lock' as const,
    },
    {
      label: 'trainCode 불일치 + arvlCd 1 → strongCB undefined, strongBE pass (lockAttachable + arrival)',
      positions: [position({ trainCode: 'OTHER', stationName: '강남' })],
      arvlCd: 1,
      expected: 'lock' as const,
    },
    {
      label: 'trainCode 불일치 + arvlCd 5(범위 밖) → strongCB false + strongBE false → null',
      positions: [position({ trainCode: 'OTHER', stationName: '강남' })],
      arvlCd: 5,
      expected: 'null' as const,
    },
    {
      label: 'trainCode 일치 + arvlCd 5(범위 밖) → strongCB false (arrival missing) + strongBE false → null',
      positions: [position({ trainCode: 'T1', stationName: '강남' })],
      arvlCd: 5,
      expected: 'null' as const,
    },
    {
      label: '빈 list + arvlCd 1 → positionTrainAgreement false, strongBE pass',
      positions: [] as readonly PositionEntry[],
      arvlCd: 1,
      expected: 'lock' as const,
    },
  ])('underground + $label', async ({ positions, arvlCd, expected }) => {
    const { lock } = await callAutoLockWithSelfPoll(
      arrival({ trainCode: 'T1', arvlCd }),
      positions,
      {
        environment: 'underground',
        gateOutcome: failingGateOutcome(),
      },
    );
    if (expected === 'lock') {
      expect(lock?.trainCode).toBe('T1');
    } else {
      expect(lock).toBeNull();
    }
  });

  it('selfPollPositions undefined → 기존 동작 (구 호출자 호환)', async () => {
    const { lock } = await callAutoLockWithSelfPoll(
      arrival({ trainCode: 'T1', arvlCd: 1 }),
      undefined,
      {
        environment: 'underground',
        gateOutcome: passingGateOutcome(),
      },
    );
    expect(lock?.trainCode).toBe('T1');
  });

  it('surface: selfPollPositions 무관 — base gate pass면 통과 (positionTrainAgreement 평가 X)', async () => {
    const { lock } = await callAutoLockWithSelfPoll(
      arrival({ trainCode: 'T1', arvlCd: 1 }),
      [position({ trainCode: 'OTHER', stationName: '강남' })],
      {
        environment: 'surface',
        gateOutcome: passingGateOutcome(),
      },
    );
    expect(lock?.trainCode).toBe('T1');
  });
});

/**
 * #1667 (ADR-015 strongDB wire) — wifiSsidStationName → wifiSsidMatch forward.
 *
 * targetWaypoint.stationName = '역삼'. wifiSsidStationName이 '역삼'이면 wifiSsidMatch=true → strongDB.
 * 다른 역명 / undefined → wifiSsidMatch false/undefined → strongDB 비활성.
 */
function callAutoLockWithWifi(
  arrivalEntry: ArrivalEntry,
  wifiSsidStationName: string | undefined,
  opts: {
    environment?: Parameters<typeof attemptAutoLock>[0]['environment'];
    gateOutcome?: Parameters<typeof attemptAutoLock>[0]['gateOutcome'];
  } = {},
) {
  return attemptAutoLock({
    trip: makeTrip(),
    targetWaypoint: target, // stationName='역삼'
    originStation: '강남',
    direction: 'up',
    seoul: makeSeoul([arrivalEntry]),
    now: NOW,
    environment: opts.environment,
    gateOutcome: opts.gateOutcome,
    wifiSsidStationName,
  });
}

describe('attemptAutoLock #1667 wifiSsidStationName → strongDB wire', () => {
  it.each([
    {
      label: 'wifiSsidStationName 일치(역삼) + arvlCd 1 → strongDB pass (underground, base gate fail)',
      wifi: '역삼',
      arvlCd: 1,
      expected: 'lock' as const,
    },
    {
      label: 'wifiSsidStationName 불일치(강남) + arvlCd 1 → strongDB false, strongBE pass (lockAttachable + arrival)',
      wifi: '강남',
      arvlCd: 1,
      expected: 'lock' as const,
    },
    {
      label: 'wifiSsidStationName 불일치(강남) + arvlCd 5(범위 밖) → strongDB false + strongBE false → null',
      wifi: '강남',
      arvlCd: 5,
      expected: 'null' as const,
    },
    {
      label: 'wifiSsidStationName 일치(역삼) + arvlCd 5(범위 밖) → wifiSsidMatch true but arrivalSignalPresent false → null',
      wifi: '역삼',
      arvlCd: 5,
      expected: 'null' as const,
    },
    {
      label: 'wifiSsidStationName undefined + arvlCd 1 → wifiSsidMatch undefined, strongBE pass',
      wifi: undefined,
      arvlCd: 1,
      expected: 'lock' as const,
    },
  ])('underground + $label', async ({ wifi, arvlCd, expected }) => {
    const { lock } = await callAutoLockWithWifi(
      arrival({ trainCode: 'T1', arvlCd }),
      wifi,
      {
        environment: 'underground',
        gateOutcome: failingGateOutcome(),
      },
    );
    if (expected === 'lock') {
      expect(lock?.trainCode).toBe('T1');
    } else {
      expect(lock).toBeNull();
    }
  });

  it('wifiSsidStationName undefined → 기존 동작 (구 호출자 호환, consensusGate skip)', async () => {
    const { lock } = await callAutoLockWithWifi(
      arrival({ trainCode: 'T1', arvlCd: 1 }),
      undefined,
      {
        environment: 'underground',
        gateOutcome: passingGateOutcome(),
      },
    );
    expect(lock?.trainCode).toBe('T1');
  });

  it('surface: wifiSsidStationName 무관 — base gate pass면 통과 (wifiSsidMatch 평가 X)', async () => {
    const { lock } = await callAutoLockWithWifi(
      arrival({ trainCode: 'T1', arvlCd: 1 }),
      '강남', // 불일치지만 surface는 base gate만
      {
        environment: 'surface',
        gateOutcome: passingGateOutcome(),
      },
    );
    expect(lock?.trainCode).toBe('T1');
  });
});

/**
 * #1676 — selfPollPositions recptnMs age 가드 테스트.
 *
 * positionTrainAgreement 산출 시 recptnMs > 0 이면 POSITION_RECPTN_MAX_AGE_MS(30s) 이내만
 * 신선 데이터로 인정. stale snapshot으로 strongCB false positive 차단.
 */
describe('attemptAutoLock #1676 recptnMs age 가드', () => {
  it('POSITION_RECPTN_MAX_AGE_MS는 30000ms', () => {
    expect(POSITION_RECPTN_MAX_AGE_MS).toBe(30_000);
  });

  it.each([
    {
      label: 'recptnMs 신선 (now - recptnMs = 10s) → positionTrainAgreement true, strongCB pass',
      recptnMs: NOW - 10_000,
      expected: 'lock' as const,
    },
    {
      label: 'recptnMs 경계 (now - recptnMs = 30s 정확히) → 신선 포함, strongCB pass',
      recptnMs: NOW - 30_000,
      expected: 'lock' as const,
    },
    {
      label: 'recptnMs stale (now - recptnMs = 31s) → positionTrainAgreement false, strongBE 의존',
      recptnMs: NOW - 31_000,
      // underground + lockAttachable=true + arrival 있으면 strongBE pass (lockAttachable=true는 pickAutoTrainCode 단일 수렴으로 보장)
      expected: 'lock' as const,
    },
  ])('underground + $label', async ({ recptnMs, expected }) => {
    // trainCode 일치 + recptnMs 조건 → strongCB pass/fail. strongBE는 arrival+lockAttachable 있으면 항상 통과.
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
      environment: 'underground',
      gateOutcome: failingGateOutcome(),
      selfPollPositions: [position({ trainCode: 'T1', stationName: '강남', recptnMs })],
    });
    if (expected === 'lock') {
      expect(lock?.trainCode).toBe('T1');
    } else {
      expect(lock).toBeNull();
    }
  });

  it('underground + trainCode 불일치 + arrival 없음(arvlCd=5) + recptnMs stale → strongCB false + strongBE false → null', async () => {
    // trainCode 불일치 → positionTrainAgreement false. arvlCd=5(범위 밖) → arrivalSignalPresent false.
    // strongBE = lockAttachable && arrivalSignalPresent = true && false = false. → null.
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 5 })]),
      now: NOW,
      environment: 'underground',
      gateOutcome: failingGateOutcome(),
      selfPollPositions: [position({ trainCode: 'T1', stationName: '강남', recptnMs: NOW - 31_000 })],
    });
    expect(lock).toBeNull();
  });

  it('recptnMs=0 → age 가드 skip (backward-compat), trainCode 일치 → positionTrainAgreement true', async () => {
    // recptnMs=0는 미포함 entry의 기본값 — age 가드 skip해 기존 동작 유지.
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
      environment: 'underground',
      gateOutcome: failingGateOutcome(),
      selfPollPositions: [position({ trainCode: 'T1', stationName: '강남', recptnMs: 0 })],
    });
    expect(lock?.trainCode).toBe('T1');
  });

  it('recptnMs undefined → age 가드 skip (backward-compat), trainCode 일치 → positionTrainAgreement true', async () => {
    // recptnMs 필드 없음 — 기존 { trainCode, stationName } 구조 호환.
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1 })]),
      now: NOW,
      environment: 'underground',
      gateOutcome: failingGateOutcome(),
      selfPollPositions: [position({ trainCode: 'T1', stationName: '강남' })],
    });
    expect(lock?.trainCode).toBe('T1');
  });
});

/**
 * #1702 (B2-A) — Seoul OpenAPI 단방향/0건 시 realtimePosition fallback.
 *
 * 사용자 6/23 trip evidence: `fetchArrivals(합정 6호선)` 한 방향만 반환 → 사용자 의도 방향
 * candidate 0건 → wrong-direction lock. 본 describe 는 fallback 분기가 segmentStations 기반
 * positions 합성으로 올바른 방향 lock 을 만들어내는지 검증.
 *
 * 사용 fixture: target=역삼(2호선), origin=강남, waypoints=[역삼, 선릉] → segmentStations=[강남, 역삼, 선릉].
 */
describe('attemptAutoLock #1702 positions fallback', () => {
  it('arrivals=[] + positions=[T1@강남 up] + direction=up → 합성 lock (T1)', async () => {
    // 가장 단순 시나리오: 실제 arrivals 가 비어 있고 positions 에 사용자 방향 train 이 있는 경우.
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([]), // 빈 arrivals
      now: NOW,
      selfPollPositions: [position({ trainCode: 'T1', stationName: '강남', isUp: true })],
    });
    expect(lock?.trainCode).toBe('T1');
    // 합성 entry 의 subwayNm 은 canonical('2호선') 이라 matchLine cross-check 통과.
    expect(lock?.line).toBe('2');
  });

  it('arrivals=[] + positions=[T_UP, T_DOWN] + direction=down → DOWN candidate 선택', async () => {
    // 사용자 6/23 evidence 와 동형: positions 양방향 train 다 있을 때 user direction 만 채택.
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'down',
      seoul: makeSeoul([]),
      now: NOW,
      selfPollPositions: [
        position({ trainCode: 'TU', stationName: '강남', isUp: true }), // 반대 방향 — 제외
        position({ trainCode: 'TD', stationName: '강남', isUp: false }), // 사용자 방향 — 채택
      ],
    });
    expect(lock?.trainCode).toBe('TD');
  });

  it('arrivals=[UP only] + positions=[DOWN train] + direction=down → 합성 DOWN candidate 보강', async () => {
    // 핵심 evidence 시나리오: 실제 arrivals 가 잘못된 방향만 반환 + user direction 으로 합성 retry.
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'down',
      seoul: makeSeoul([arrival({ trainCode: 'UP_TRAIN', isUp: true })]), // UP only — direction 불일치
      now: NOW,
      selfPollPositions: [
        position({ trainCode: 'DOWN_TRAIN', stationName: '강남', isUp: false }), // DOWN candidate
      ],
    });
    expect(lock?.trainCode).toBe('DOWN_TRAIN');
  });

  it('arrivals=[] + positions=[] → 기존 schedule-based fallback (lock null)', async () => {
    // positions 도 비어있으면 합성 불가 → 기존 null 동작 유지 (caller boarding-prompt fallback).
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([]),
      now: NOW,
      selfPollPositions: [],
    });
    expect(lock).toBeNull();
  });

  it('arrivals=[] + positions undefined → lock null (구 호출자 호환)', async () => {
    // selfPollPositions 미전달 시 fallback 자체가 비활성 → 기존 동작 보존.
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

  it('arrivals 통과 candidate 있음 → fallback 진입 X (real arrivals 우선)', async () => {
    // real arrivals 가 single candidate 를 가지면 positions 는 무시 — 합성보다 신뢰도 높음.
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'REAL', isUp: true })]),
      now: NOW,
      selfPollPositions: [
        position({ trainCode: 'SYNTH', stationName: '강남', isUp: true }),
      ],
    });
    expect(lock?.trainCode).toBe('REAL');
  });

  it('merge dedup — 같은 trainCode 는 real 만 보존, 합성 동일 trainCode 제거', async () => {
    // real arrivals: T1 wrong direction (UP) — pickAutoTrainCode(down) null → fallback 진입.
    // positions: T1 (real 과 같은 code) + T2 (다른 code) → dedup 으로 T1 제외, T2 만 합성.
    // 결과: merged = [T1 UP (real)] + [T2 DOWN (synth)] → pickAutoTrainCode(down) → T2.
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'down',
      seoul: makeSeoul([arrival({ trainCode: 'T1', arvlCd: 1, isUp: true })]),
      now: NOW,
      selfPollPositions: [
        position({ trainCode: 'T1', stationName: '강남', isUp: false }), // dedup 제외
        position({ trainCode: 'T2', stationName: '강남', isUp: false }), // 합성 채택
      ],
    });
    // T2 만 user direction 합성 candidate 로 남아 lock.
    // (T1 이 dedup 안 되면 T1+T2 → ambiguity → null 이 되어 본 test 가 fail 했을 것)
    expect(lock?.trainCode).toBe('T2');
  });

  it('합성 candidate ambiguity (DOWN train 2개) → null (boarding-prompt fallback)', async () => {
    // 같은 priority tier 에 2개 이상이면 pickAutoTrainCode 가 null 반환 — 합성 분기도 동일.
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'down',
      seoul: makeSeoul([]),
      now: NOW,
      selfPollPositions: [
        position({ trainCode: 'TD1', stationName: '강남', isUp: false }),
        position({ trainCode: 'TD2', stationName: '강남', isUp: false }),
      ],
    });
    expect(lock).toBeNull();
  });

  it('positions train 이미 target 지남 → 합성 제외 → null', async () => {
    // target=역삼(idx=1), train@선릉(idx=2) — currentIdx>targetIdx → synthesize 에서 제외.
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([]),
      now: NOW,
      selfPollPositions: [
        position({ trainCode: 'PASSED', stationName: '선릉', isUp: true }),
      ],
    });
    expect(lock).toBeNull();
  });
});

/**
 * #1720 — 합성 ArrivalEntry(arvlCd=0, synthesized=true)가 consensusGate strongBE 통과 자격을 잃는다.
 *
 * positions-derived 합성 entry는 ADR-015 §3 signal C(position) 자격만 있고 signal B(arrival) 자격이
 * 없다. underground 환경 + failing gateOutcome 시 strongBE=arrival+lockAttachable 2-of-2 가 fix 전에는
 * 합성 entry로 통과되던 false positive를 차단.
 *
 * 대조군: real ArrivalEntry(arvlCd=1)는 동일 environment + gateOutcome 에서 strongBE 통과 → lock 채택.
 */
describe('attemptAutoLock #1720 합성 entry consensusGate 차단', () => {
  it('underground + failing gate + arrivals=[] + positions 합성 → strongBE 차단 → null', async () => {
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([]),
      now: NOW,
      selfPollPositions: [position({ trainCode: 'SYNTH', stationName: '강남', isUp: true })],
      environment: 'underground',
      gateOutcome: failingGateOutcome(),
    });
    expect(lock).toBeNull();
  });

  it('대조군: underground + failing gate + real arrivals(arvlCd=1) → strongBE pass → lock', async () => {
    const { lock } = await attemptAutoLock({
      trip: makeTrip(),
      targetWaypoint: target,
      originStation: '강남',
      direction: 'up',
      seoul: makeSeoul([arrival({ trainCode: 'REAL', arvlCd: 1, isUp: true })]),
      now: NOW,
      environment: 'underground',
      gateOutcome: failingGateOutcome(),
    });
    expect(lock?.trainCode).toBe('REAL');
  });
});
