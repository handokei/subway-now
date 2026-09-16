/**
 * lockSwap.ts (#902 Seam F) — 환승/사라짐 자동 trainCode swap 단위 테스트.
 *
 * 통합 동작(advanceBoardingLockWaypoint / runTrainCodeTracking 진입점)은 scheduled.test.ts에서
 * 별도 커버. 본 파일은 pure pipeline (KV/네트워크 의존 없음)에 한정.
 */

import { describe, expect, it } from 'vitest';
import { SeoulArrivalClient, type ArrivalEntry, type PositionEntry } from '../seoul';
import {
  SWAP_LOCK_TTL_MS,
  attachTrainCodeForLeg,
  buildLegSegmentStations,
} from '../lockSwap';
import type { Trip, Waypoint } from '../types';

const NOW = 1_700_000_000_000;

function makeArrivalsFetch(arrivals: ArrivalEntry[]): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        realtimeArrivalList: arrivals.map((a) => ({
          barvlDt: String(a.arrivalSeconds),
          recptnDt: '',
          updnLine: a.isUp ? '상행' : '하행',
          trainLineNm: a.destination,
          btrainNo: a.trainCode,
          subwayNm: a.subwayNm,
          arvlCd: a.arvlCd,
        })),
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

function makeSeoul(arrivals: ArrivalEntry[]): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: makeArrivalsFetch(arrivals),
  });
}

function makeTrip(waypoints: Waypoint[]): Trip {
  return {
    token: 'tok',
    route: { type: 'direct', line: '7', stops: 3 },
    destination: 'dst',
    waypoints,
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000,
  };
}

// #1719 — leg(중곡→어린이대공원 / 중곡→군자, 7호선) direction=down 인 fixture 가 다수이므로
// `isUp` 을 5번째 옵션 인자로 노출. 기본값 false 로 down direction 정합(test가 명시 안 하면
// down). single-waypoint leg(direction=null) test 는 어느 값이든 통과.
function makeArrival(
  trainCode: string,
  arvlCd: number | null,
  arrivalSeconds = 60,
  subwayNm = '지하철7호선',
  isUp = false,
): ArrivalEntry {
  return {
    destination: '도봉산',
    arrivalSeconds,
    trainCode,
    isUp,
    subwayNm,
    arvlCd,
  };
}

describe('buildLegSegmentStations', () => {
  it('returns single station for a destination waypoint', () => {
    const result = buildLegSegmentStations(
      [{ stationName: '강남', line: '2', kind: 'destination' }],
      '2',
    );
    expect(result).toEqual(['강남']);
  });

  it('collects consecutive same-line intermediate stations up to destination', () => {
    const result = buildLegSegmentStations(
      [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '군자', line: '7', kind: 'intermediate' },
        { stationName: '어린이대공원', line: '7', kind: 'destination' },
      ],
      '7',
    );
    expect(result).toEqual(['중곡', '군자', '어린이대공원']);
  });

  it('stops at the next transfer waypoint (inclusive) — leg ends there', () => {
    // line=7 leg는 transfer waypoint(건대입구)까지 포함. 그 다음 line=2 segment는 별도 leg.
    const result = buildLegSegmentStations(
      [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '건대입구', line: '7', kind: 'transfer' },
        { stationName: '성수', line: '2', kind: 'destination' },
      ],
      '7',
    );
    expect(result).toEqual(['중곡', '건대입구']);
  });

  it('stops on line change (no transfer kind) — defensive against malformed waypoint sequences', () => {
    // 정상 sequence는 line 전환 시 transfer kind가 있어야 하지만, defensive하게 line만으로도 break.
    const result = buildLegSegmentStations(
      [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '성수', line: '2', kind: 'destination' },
      ],
      '7',
    );
    expect(result).toEqual(['중곡']);
  });

  it('returns empty array when first waypoint line does not match', () => {
    const result = buildLegSegmentStations(
      [{ stationName: '성수', line: '2', kind: 'destination' }],
      '7',
    );
    expect(result).toEqual([]);
  });

  it('returns empty array for empty waypoints', () => {
    expect(buildLegSegmentStations([], '7')).toEqual([]);
  });
});

describe('attachTrainCodeForLeg', () => {
  const targetWaypoint: Waypoint = {
    stationName: '어린이대공원',
    line: '7',
    kind: 'destination',
  };

  it('attaches single direction-matched candidate (arvlCd priority 1 ARRIVED)', async () => {
    const seoul = makeSeoul([makeArrival('7246', 1, 60)]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip([targetWaypoint]),
      targetWaypoint,
      seoul,
      now: NOW,
    });
    expect(lock).toEqual({
      trainCode: '7246',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: NOW,
      segmentStations: ['어린이대공원'],
      expiresAt: NOW + SWAP_LOCK_TTL_MS,
    });
  });

  it('returns null when arrivals are empty (Seoul API returned nothing)', async () => {
    const seoul = makeSeoul([]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip([targetWaypoint]),
      targetWaypoint,
      seoul,
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('returns null for unmapped line (subwayIdForLine miss)', async () => {
    const unmapped: Waypoint = { stationName: '어디', line: 'unmapped', kind: 'destination' };
    const seoul = makeSeoul([makeArrival('X', 1, 60)]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip([unmapped]),
      targetWaypoint: unmapped,
      seoul,
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('returns null on ambiguous candidates (multiple arvlCd=1) — boarding-prompt fallback expected', async () => {
    // 두 train 모두 ARRIVED → pickAutoTrainCode가 ambiguity로 null
    const seoul = makeSeoul([makeArrival('A', 1, 60), makeArrival('B', 1, 90)]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip([targetWaypoint]),
      targetWaypoint,
      seoul,
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('picks arvlCd=2 (DEPARTED) over arvlCd=1 (ARRIVED)', async () => {
    const seoul = makeSeoul([makeArrival('ARR', 1, 60), makeArrival('DEP', 2, 30)]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip([targetWaypoint]),
      targetWaypoint,
      seoul,
      now: NOW,
    });
    expect(lock?.trainCode).toBe('DEP');
  });

  it('returns null when no candidate matches the line (different subwayNm)', async () => {
    // arrivals exist but all are for line 2, while target is line 7 → matchLine filters all out.
    const seoul = makeSeoul([makeArrival('2HOST', 1, 60, '지하철2호선')]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip([targetWaypoint]),
      targetWaypoint,
      seoul,
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('returns null when buildLegSegmentStations is empty (target line not first waypoint)', async () => {
    // targetWaypoint.line=7이지만 trip.waypoints[0]는 line=2 → buildLegSegmentStations=[].
    const seoul = makeSeoul([makeArrival('7246', 1, 60)]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip([{ stationName: '성수', line: '2', kind: 'destination' }]),
      targetWaypoint,
      seoul,
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('populates segmentStations from trip.waypoints same-line chain', async () => {
    const seoul = makeSeoul([makeArrival('7246', 1, 60)]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip([
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '군자', line: '7', kind: 'intermediate' },
        { stationName: '어린이대공원', line: '7', kind: 'destination' },
      ]),
      // targetWaypoint는 leg의 첫 waypoint와 동치여야 정상 (호출자 책임).
      targetWaypoint: {
        stationName: '중곡',
        line: '7',
        kind: 'intermediate',
      },
      seoul,
      now: NOW,
    });
    expect(lock?.segmentStations).toEqual(['중곡', '군자', '어린이대공원']);
  });

  it('allowedLines 안 line → swap 허용 (#1439 §9)', async () => {
    const seoul = makeSeoul([makeArrival('T1', 1)]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip([{ stationName: '중곡', line: '7', kind: 'destination' }]),
      targetWaypoint: { stationName: '중곡', line: '7', kind: 'intermediate' },
      seoul,
      now: NOW,
      allowedLines: new Set(['7']),
    });
    expect(lock).not.toBeNull();
  });

  it('allowedLines 밖 line → null (cross-line 매핑 reject, #1439 §9)', async () => {
    const seoul = makeSeoul([makeArrival('T1', 1)]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip([{ stationName: '중곡', line: '7', kind: 'destination' }]),
      targetWaypoint: { stationName: '중곡', line: '7', kind: 'intermediate' },
      seoul,
      now: NOW,
      allowedLines: new Set(['2', '5']),
    });
    expect(lock).toBeNull();
  });

  it('chosen arrival subwayNm 이 line 과 불일치 → null (2단 cross-check, #1626 follow-up)', async () => {
    // pickAutoTrainCode 가 matchLine 우회로 cross-line train을 선택했다고 가정한 회귀 시뮬레이션:
    // arrivals 단일 후보로 ambiguity 없이 통과하지만 subwayNm 이 빈 문자열이라 matchLine=false 발동.
    // chosen subwayNm 의 line cross-check 가 lock 합성을 차단해야 한다 (wrong-line trainCode lock
    // 30분 TTL 지속 회귀 봉쇄).
    const seoul = makeSeoul([makeArrival('T1', 1, 60, '')]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip([{ stationName: '중곡', line: '7', kind: 'destination' }]),
      targetWaypoint: { stationName: '중곡', line: '7', kind: 'intermediate' },
      seoul,
      now: NOW,
    });
    expect(lock).toBeNull();
  });
});

/**
 * #1702 (B2-A) — Seoul OpenAPI 단방향/0건 시 realtimePosition fallback.
 *
 * `attachTrainCodeForLeg` 는 direction=null 로 호출 (swap 흐름은 양방향 허용) 이지만
 * segmentStations 기반 필터로 진행 방향 외 train (이미 target 지남) 은 자연 제외된다.
 * 합성 path 가 transfer-swap + vanish-swap 모두에서 작동하는지 검증.
 *
 * 사용 fixture: line=7, segmentStations=[중곡, 군자, 어린이대공원], target=중곡.
 */

// #1719 — leg(중곡→어린이대공원, 7호선) direction=down 정합 — default isUp=false.
function position(overrides: Partial<PositionEntry> & { trainCode: string }): PositionEntry {
  return {
    stationName: '',
    trainSttus: 0,
    isUp: false,
    recptnMs: 0,
    ...overrides,
  };
}

describe('attachTrainCodeForLeg #1702 positions fallback', () => {
  const swapTarget: Waypoint = { stationName: '중곡', line: '7', kind: 'intermediate' };
  const swapWaypoints: Waypoint[] = [
    swapTarget,
    { stationName: '군자', line: '7', kind: 'intermediate' },
    { stationName: '어린이대공원', line: '7', kind: 'destination' },
  ];

  it('arrivals=[] + positions=[T1@중곡] → 합성 swap candidate', async () => {
    const seoul = makeSeoul([]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip(swapWaypoints),
      targetWaypoint: swapTarget,
      seoul,
      now: NOW,
      selfPollPositions: [position({ trainCode: 'T1', stationName: '중곡' })],
    });
    expect(lock?.trainCode).toBe('T1');
    expect(lock?.line).toBe('7');
  });

  it('arrivals=[] + positions=[] → null (구 schedule fallback 유지)', async () => {
    const seoul = makeSeoul([]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip(swapWaypoints),
      targetWaypoint: swapTarget,
      seoul,
      now: NOW,
      selfPollPositions: [],
    });
    expect(lock).toBeNull();
  });

  it('arrivals=[] + positions undefined → null (구 호출자 호환)', async () => {
    const seoul = makeSeoul([]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip(swapWaypoints),
      targetWaypoint: swapTarget,
      seoul,
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('real arrivals 통과 → fallback 진입 X', async () => {
    // real arrivals 가 candidate 를 가지면 positions 무시 — real 우선.
    const seoul = makeSeoul([makeArrival('REAL', 1, 60)]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip(swapWaypoints),
      targetWaypoint: swapTarget,
      seoul,
      now: NOW,
      selfPollPositions: [position({ trainCode: 'SYNTH', stationName: '중곡' })],
    });
    expect(lock?.trainCode).toBe('REAL');
  });

  it('positions train 이미 target 지남 → 합성 제외 → null', async () => {
    // target=중곡(idx=0), train@군자(idx=1) — currentIdx>targetIdx → 제외.
    const seoul = makeSeoul([]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip(swapWaypoints),
      targetWaypoint: swapTarget,
      seoul,
      now: NOW,
      selfPollPositions: [position({ trainCode: 'PASSED', stationName: '군자' })],
    });
    expect(lock).toBeNull();
  });

  it('합성 candidate ambiguity → null (boarding-prompt fallback)', async () => {
    const seoul = makeSeoul([]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip(swapWaypoints),
      targetWaypoint: swapTarget,
      seoul,
      now: NOW,
      selfPollPositions: [
        position({ trainCode: 'T1', stationName: '중곡' }),
        position({ trainCode: 'T2', stationName: '중곡' }),
      ],
    });
    expect(lock).toBeNull();
  });

  it('arrivals=[UP only] + positions=[DOWN train] → DOWN train 합성 보강', async () => {
    // direction=null swap 분기지만, positions 의 다른 stationName/방향 train 이 segmentStations
    // 인덱스로 자연 필터링. arrivals 가 wrong-line (matchLine 우회로 null) 인 경우 fallback.
    const seoul = makeSeoul([
      // 빈 subwayNm — matchLine 통과 X. pickAutoTrainCode null 반환.
      makeArrival('UP_TRAIN', 1, 60, ''),
    ]);
    const lock = await attachTrainCodeForLeg({
      trip: makeTrip(swapWaypoints),
      targetWaypoint: swapTarget,
      seoul,
      now: NOW,
      selfPollPositions: [position({ trainCode: 'POSITIONS_TRAIN', stationName: '중곡' })],
    });
    expect(lock?.trainCode).toBe('POSITIONS_TRAIN');
  });
});

/**
 * #1719 — direction=null fallthrough 차단. lockSwap 이 inferLegDirection 으로 leg 진행 방향을
 * 추론하므로, 양방향 trains 가 같은 station 에 있어도 wrong-direction train 은 candidate pool 에
 * 들어가지 않는다. 사용자 6/23 trip evidence(6호선 응암 방향 6184) 시나리오 + 2호선 양방향
 * 시나리오 + 추론 불가 노선의 기존 동작(both directions ambiguity → null) 보존 검증.
 */

// 6호선 합정 → 광흥창 → 대흥 → 공덕 (사용자 6/23 trip evidence segment).
function makeLine6Trip(): Trip {
  return {
    token: 'tok',
    route: { type: 'direct', line: '6', stops: 3 },
    destination: 'dst',
    waypoints: [
      { stationName: '합정', line: '6', kind: 'intermediate' },
      { stationName: '광흥창', line: '6', kind: 'intermediate' },
      { stationName: '대흥', line: '6', kind: 'intermediate' },
      { stationName: '공덕', line: '6', kind: 'destination' },
    ],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000,
  };
}

function line6Arrival(
  trainCode: string,
  isUp: boolean,
  arvlCd: number | null = 1,
  arrivalSeconds = 60,
): ArrivalEntry {
  return {
    destination: isUp ? '응암' : '봉화산',
    arrivalSeconds,
    trainCode,
    isUp,
    subwayNm: '지하철6호선',
    arvlCd,
  };
}

describe('attachTrainCodeForLeg #1719 wrong-direction 차단', () => {
  const line6Target: Waypoint = { stationName: '합정', line: '6', kind: 'intermediate' };

  it('real arrivals: 양방향 trains → DOWN train 만 선택 (UP 응암 방향 차단)', async () => {
    // 사용자 trip evidence — 합정 6호선 양방향 trains 동시 진입. leg 진행 방향(down) 만 채택.
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: makeArrivalsFetch([
        line6Arrival('6184', true), // 응암 방향 (UP) — leg 와 반대
        line6Arrival('6187', false), // 공덕 방향 (DOWN) — leg 정합
      ]),
    });
    const lock = await attachTrainCodeForLeg({
      trip: makeLine6Trip(),
      targetWaypoint: line6Target,
      seoul,
      now: NOW,
    });
    expect(lock?.trainCode).toBe('6187');
  });

  it('real arrivals: UP only (wrong direction) → null (fallback prompt)', async () => {
    // Seoul OpenAPI 가 한 방향(UP=응암) 만 반환한 회귀 시나리오. leg=down 이므로 매칭 0건 → null.
    // direction=null 이었으면 6184 가 single candidate 로 lock 합성됐을 케이스를 차단.
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: makeArrivalsFetch([line6Arrival('6184', true)]),
    });
    const lock = await attachTrainCodeForLeg({
      trip: makeLine6Trip(),
      targetWaypoint: line6Target,
      seoul,
      now: NOW,
    });
    expect(lock).toBeNull();
  });

  it('positions fallback: 양방향 trains @ 합정 → DOWN train 만 합성', async () => {
    // Seoul API 0건 → positions fallback. positions 가 양방향 trains 를 반환해도 leg=down 만 채택.
    const seoul = makeSeoul([]);
    const lock = await attachTrainCodeForLeg({
      trip: makeLine6Trip(),
      targetWaypoint: line6Target,
      seoul,
      now: NOW,
      selfPollPositions: [
        position({ trainCode: '6184', stationName: '합정', isUp: true }), // UP 응암 방향
        position({ trainCode: '6187', stationName: '합정', isUp: false }), // DOWN 공덕 방향
      ],
    });
    expect(lock?.trainCode).toBe('6187');
  });

  it('positions fallback: UP only (wrong direction) → null (잘못된 응암 방향 lock 차단)', async () => {
    const seoul = makeSeoul([]);
    const lock = await attachTrainCodeForLeg({
      trip: makeLine6Trip(),
      targetWaypoint: line6Target,
      seoul,
      now: NOW,
      selfPollPositions: [position({ trainCode: '6184', stationName: '합정', isUp: true })],
    });
    expect(lock).toBeNull();
  });

  it('2호선 양방향(외선/내선) wrong-direction 차단 — 합정 → 신촌 (DOWN)', async () => {
    // 2호선 합정 → 신촌 leg 는 외선순환(down). 내선순환(up) train 차단.
    const trip: Trip = {
      token: 'tok',
      route: { type: 'direct', line: '2', stops: 2 },
      destination: 'dst',
      waypoints: [
        { stationName: '합정', line: '2', kind: 'intermediate' },
        { stationName: '신촌', line: '2', kind: 'destination' },
      ],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW + 60_000,
    };
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: makeArrivalsFetch([
        {
          destination: '시청',
          arrivalSeconds: 60,
          trainCode: '2_INNER',
          isUp: true, // 내선순환
          subwayNm: '지하철2호선',
          arvlCd: 1,
        },
        {
          destination: '신촌',
          arrivalSeconds: 60,
          trainCode: '2_OUTER',
          isUp: false, // 외선순환
          subwayNm: '지하철2호선',
          arvlCd: 1,
        },
      ]),
    });
    const lock = await attachTrainCodeForLeg({
      trip,
      targetWaypoint: { stationName: '합정', line: '2', kind: 'intermediate' },
      seoul,
      now: NOW,
    });
    // 합정(2-038) → 신촌(2-040) → id 증가 = 외선순환(down). 외선 train 만 통과.
    // direction=null 이었으면 양방향 priority 1 ambiguity 로 null 이었을 케이스를 차단.
    expect(lock?.trainCode).toBe('2_OUTER');
  });

  it('추론 불가 노선(5호선 분기) → direction=null fallback, 기존 동작 유지', async () => {
    // 5호선은 monotonic + closedLoop 둘 다 X — `inferLegDirection` null. caller 는 direction=null
    // 로 진행 → 양방향 candidate 같이 통과(ambiguity → null) 또는 단일 후보면 통과 (기존 동작).
    const trip: Trip = {
      token: 'tok',
      route: { type: 'direct', line: '5', stops: 2 },
      destination: 'dst',
      waypoints: [
        { stationName: '광화문', line: '5', kind: 'intermediate' },
        { stationName: '종로3가', line: '5', kind: 'destination' },
      ],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW + 60_000,
    };
    const seoul = new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: makeArrivalsFetch([
        {
          destination: '하남검단산',
          arrivalSeconds: 60,
          trainCode: '5_DOWN',
          isUp: false,
          subwayNm: '지하철5호선',
          arvlCd: 1,
        },
      ]),
    });
    const lock = await attachTrainCodeForLeg({
      trip,
      targetWaypoint: { stationName: '광화문', line: '5', kind: 'intermediate' },
      seoul,
      now: NOW,
    });
    // direction=null 이므로 단일 후보 통과 (기존 lockSwap 정책 유지).
    expect(lock?.trainCode).toBe('5_DOWN');
  });
});
