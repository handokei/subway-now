/**
 * lockSwap.ts (#902 Seam F) — 환승/사라짐 자동 trainCode swap 단위 테스트.
 *
 * 통합 동작(advanceBoardingLockWaypoint / runTrainCodeTracking 진입점)은 scheduled.test.ts에서
 * 별도 커버. 본 파일은 pure pipeline (KV/네트워크 의존 없음)에 한정.
 */

import { describe, expect, it } from 'vitest';
import { SeoulArrivalClient, type ArrivalEntry } from '../seoul';
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

function makeArrival(
  trainCode: string,
  arvlCd: number | null,
  arrivalSeconds = 60,
  subwayNm = '지하철7호선',
): ArrivalEntry {
  return {
    destination: '도봉산',
    arrivalSeconds,
    trainCode,
    isUp: true,
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
});
