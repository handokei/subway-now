/**
 * Backend-authority boarding trainCode resolver — 단위 테스트 (committed architecture, 2026-09-03).
 *
 * `resolveTrainCodeFromPositions`(pure) + `attemptBoardingAnchorResolution`(seoul.fetchPositions
 * 호출 wrapper) 둘 다 검증한다. 안전 불변식 최우선: 0개/2개+ 후보는 절대 resolved를 반환하지
 * 않는다(틀린 열차를 lock하는 것이 이 기능이 막아야 하는 핵심 위험).
 */

import { describe, expect, it } from 'vitest';
import {
  attemptBoardingAnchorResolution,
  findTapLegStart,
  POSITION_FRESHNESS_MS,
  resolveActiveLegOrigin,
  resolveTrainCodeFromPositions,
  type BoardingAnchor,
} from '../boardingAnchorResolver';
import { SeoulArrivalClient, type PositionEntry } from '../seoul';
import type { Trip, Waypoint } from '../types';

const NOW = 1_700_000_000_000;

function position(overrides: Partial<PositionEntry> & { trainCode: string }): PositionEntry {
  return {
    stationName: '중곡',
    trainSttus: 1, // ARRIVED
    isUp: false,
    recptnMs: NOW,
    ...overrides,
  };
}

const ANCHOR: BoardingAnchor = { line: '7', boardingStation: '중곡', direction: 'down' };

describe('resolveTrainCodeFromPositions', () => {
  it('정확히 1개(ARRIVED) 매칭 → resolved', () => {
    const result = resolveTrainCodeFromPositions(
      ANCHOR,
      [position({ trainCode: '7246' })],
      NOW,
    );
    expect(result).toEqual({ status: 'resolved', trainCode: '7246' });
  });

  it('정확히 1개(APPROACHING) 매칭, ARRIVED 없음 → resolved', () => {
    const result = resolveTrainCodeFromPositions(
      ANCHOR,
      [position({ trainCode: '7246', trainSttus: 0 })],
      NOW,
    );
    expect(result).toEqual({ status: 'resolved', trainCode: '7246' });
  });

  it('후보 0개 → none', () => {
    expect(resolveTrainCodeFromPositions(ANCHOR, [], NOW)).toEqual({ status: 'none' });
  });

  it('같은 tier(ARRIVED) 2개+ → ambiguous (틀린 열차 추측 금지)', () => {
    const result = resolveTrainCodeFromPositions(
      ANCHOR,
      [
        position({ trainCode: '7246' }),
        position({ trainCode: '7248' }),
      ],
      NOW,
    );
    expect(result).toEqual({ status: 'ambiguous' });
  });

  it('DEPARTED(2)만 있으면 → none (제외, ambiguous 아님)', () => {
    const result = resolveTrainCodeFromPositions(
      ANCHOR,
      [position({ trainCode: '7246', trainSttus: 2 })],
      NOW,
    );
    expect(result).toEqual({ status: 'none' });
  });

  it('방향 불일치(isUp 반대) → 후보에서 제외', () => {
    const result = resolveTrainCodeFromPositions(
      ANCHOR,
      [position({ trainCode: '7246', isUp: true })],
      NOW,
    );
    expect(result).toEqual({ status: 'none' });
  });

  it('direction=null이면 양방향 모두 허용', () => {
    const anchor: BoardingAnchor = { ...ANCHOR, direction: null };
    const result = resolveTrainCodeFromPositions(
      anchor,
      [position({ trainCode: '7246', isUp: true })],
      NOW,
    );
    expect(result).toEqual({ status: 'resolved', trainCode: '7246' });
  });

  it('stationName 불일치 → 후보에서 제외', () => {
    const result = resolveTrainCodeFromPositions(
      ANCHOR,
      [position({ trainCode: '7246', stationName: '군자' })],
      NOW,
    );
    expect(result).toEqual({ status: 'none' });
  });

  it('recptnMs=0(누락) → 신뢰 불가로 제외', () => {
    const result = resolveTrainCodeFromPositions(
      ANCHOR,
      [position({ trainCode: '7246', recptnMs: 0 })],
      NOW,
    );
    expect(result).toEqual({ status: 'none' });
  });

  it('recptnMs가 freshness 임계 초과(stale) → 제외', () => {
    const result = resolveTrainCodeFromPositions(
      ANCHOR,
      [position({ trainCode: '7246', recptnMs: NOW - POSITION_FRESHNESS_MS - 1 })],
      NOW,
    );
    expect(result).toEqual({ status: 'none' });
  });

  it('freshness 임계 이내(경계) → 포함', () => {
    const result = resolveTrainCodeFromPositions(
      ANCHOR,
      [position({ trainCode: '7246', recptnMs: NOW - POSITION_FRESHNESS_MS })],
      NOW,
    );
    expect(result).toEqual({ status: 'resolved', trainCode: '7246' });
  });

  it('ARRIVED 1개 + APPROACHING 1개(다른 trainCode) → ARRIVED tier 우선 채택 (APPROACHING 무시)', () => {
    const result = resolveTrainCodeFromPositions(
      ANCHOR,
      [
        position({ trainCode: '7246', trainSttus: 1 }),
        position({ trainCode: '7248', trainSttus: 0 }),
      ],
      NOW,
    );
    expect(result).toEqual({ status: 'resolved', trainCode: '7246' });
  });
});

describe('attemptBoardingAnchorResolution', () => {
  function makeTrip(overrides: Partial<Trip> = {}): Trip {
    return {
      token: 'tok',
      route: { type: 'direct', line: '7', stops: 1 },
      destination: '어린이대공원',
      waypoints: [{ stationName: '어린이대공원', line: '7', kind: 'destination' }],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW + 60_000,
      infoModeEnabled: true,
      promptDisplay: { originStation: '중곡', line: '7' },
      ...overrides,
    };
  }

  function makeSeoulWithPositions(
    positions: Array<Partial<PositionEntry> & { trainCode: string }>,
  ): SeoulArrivalClient {
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            realtimePositionList: positions.map((p) => ({
              trainNo: p.trainCode,
              statnNm: p.stationName ?? '중곡',
              trainSttus: p.trainSttus ?? 1,
              updnLine: p.isUp === true ? '상행' : '하행',
              lastRecptnDt: recptnDtFor(p.recptnMs ?? NOW),
            })),
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
  }

  /** seoul.ts parseRecptnDt는 `<recptnDt 공백구분> + '+09:00'`을 Date.parse한다 — 역산해서
   * 주어진 epoch ms를 그대로 복원하는 문자열을 만든다. */
  function recptnDtFor(ms: number): string {
    return new Date(ms + 9 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  }

  it('정확히 1개 매칭 → BoardingLockMeta 반환 (trainCode/line/segmentStations)', async () => {
    const seoul = makeSeoulWithPositions([{ trainCode: '7246' }]);
    const trip = makeTrip();
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
    expect(result).not.toBeNull();
    expect(result?.trainCode).toBe('7246');
    expect(result?.line).toBe('7');
    expect(result?.segmentStations[0]).toBe('중곡');
    expect(result?.segmentStations).toContain('어린이대공원');
    expect(result?.expiresAt).toBeGreaterThan(NOW);
  });

  it('infoModeEnabled !== true → null (seoul 호출 안 함)', async () => {
    const seoul = makeSeoulWithPositions([{ trainCode: '7246' }]);
    const trip = makeTrip({ infoModeEnabled: false });
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
    expect(result).toBeNull();
    expect(seoul.stats.callCount).toBe(0);
  });

  it('promptDisplay 없음 → null (seoul 호출 안 함)', async () => {
    const seoul = makeSeoulWithPositions([{ trainCode: '7246' }]);
    const trip = makeTrip({ promptDisplay: undefined });
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
    expect(result).toBeNull();
    expect(seoul.stats.callCount).toBe(0);
  });

  it('후보 2개(ambiguous) → null, lock 승격 안 함', async () => {
    const seoul = makeSeoulWithPositions([
      { trainCode: '7246' },
      { trainCode: '7248' },
    ]);
    const trip = makeTrip();
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
    expect(result).toBeNull();
  });

  it('후보 0개(none) → null', async () => {
    const seoul = makeSeoulWithPositions([]);
    const trip = makeTrip();
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
    expect(result).toBeNull();
  });

  it('line 매핑 실패(subwayId 없음) → null', async () => {
    const seoul = makeSeoulWithPositions([{ trainCode: '7246' }]);
    const trip = makeTrip({ promptDisplay: { originStation: '중곡', line: 'not-a-line' } });
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
    expect(result).toBeNull();
  });

  it('waypoints[0].line이 promptDisplay.line과 다름(direction=null fallback) → legSegment 빈 배열 → null', async () => {
    // 첫 waypoint의 line이 다르면 direction 추론은 null-fallback되고(#1719 정책),
    // buildLegSegmentStations도 첫 waypoint에서 즉시 멈춰 빈 배열을 반환한다 → null.
    const seoul = makeSeoulWithPositions([{ trainCode: '7246' }]);
    const trip = makeTrip({
      waypoints: [{ stationName: '어린이대공원', line: '다른선', kind: 'destination' }],
    });
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
    expect(result).toBeNull();
  });

  it('waypoints[0].stationName === origin(동일역) → direction=null이어도 resolved + segmentStations prepend 생략', async () => {
    const seoul = makeSeoulWithPositions([{ trainCode: '7246' }]);
    const trip = makeTrip({
      waypoints: [{ stationName: '중곡', line: '7', kind: 'destination' }],
    });
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
    expect(result).not.toBeNull();
    expect(result?.trainCode).toBe('7246');
    expect(result?.segmentStations).toEqual(['중곡']);
  });
});

describe('resolveActiveLegOrigin (#2515, #2511 supersede)', () => {
  function makeTrip(overrides: Partial<Trip> = {}): Trip {
    return {
      token: 'tok',
      route: { type: 'direct', line: '7', stops: 1 },
      destination: '어린이대공원',
      waypoints: [{ stationName: '어린이대공원', line: '7', kind: 'destination' }],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW + 60_000,
      infoModeEnabled: true,
      promptDisplay: { originStation: '중곡', line: '7' },
      ...overrides,
    };
  }

  it('currentLegAnchor 없음 → promptDisplay(leg 1) 반환', () => {
    const trip = makeTrip();
    expect(resolveActiveLegOrigin(trip, NOW)).toEqual({ originStation: '중곡', line: '7' });
  });

  it('currentLegAnchor 있지만 도보시간 미경과(now < legBoardingEligibleAt) → null (promptDisplay로 fallback하지 않음)', () => {
    const trip = makeTrip({
      currentLegAnchor: { boardingStation: '건대입구', line: '2' },
      legBoardingEligibleAt: NOW + 60_000,
    });
    expect(resolveActiveLegOrigin(trip, NOW)).toBeNull();
  });

  it('currentLegAnchor + 도보시간 경과(now === legBoardingEligibleAt, 경계) + allowLegTransfer:true(탭/register-time) → leg 2 anchor 반환', () => {
    const trip = makeTrip({
      currentLegAnchor: { boardingStation: '건대입구', line: '2' },
      legBoardingEligibleAt: NOW,
    });
    expect(resolveActiveLegOrigin(trip, NOW, { allowLegTransfer: true })).toEqual({
      originStation: '건대입구',
      line: '2',
    });
  });

  // break #2 (#2323 rework) — cron 경로(옵션 미전달, 기본 false)는 도보시간 경과 + eligible해도
  // leg 2를 절대 평가하지 않는다. leg 2 승격은 register-time(탭 트리거) 경로에서만 허용된다.
  it('currentLegAnchor + 도보시간 경과했어도 allowLegTransfer 미전달(cron 기본값) → null', () => {
    const trip = makeTrip({
      currentLegAnchor: { boardingStation: '건대입구', line: '2' },
      legBoardingEligibleAt: NOW,
    });
    expect(resolveActiveLegOrigin(trip, NOW)).toBeNull();
  });

  it('currentLegAnchor 있지만 legBoardingEligibleAt 미정의(비정상 상태) → null (allowLegTransfer 미전달)', () => {
    const trip = makeTrip({ currentLegAnchor: { boardingStation: '건대입구', line: '2' } });
    expect(resolveActiveLegOrigin(trip, NOW)).toBeNull();
  });

  it('currentLegAnchor + allowLegTransfer:true 이지만 legBoardingEligibleAt 미정의(비정상 상태) → null', () => {
    const trip = makeTrip({ currentLegAnchor: { boardingStation: '건대입구', line: '2' } });
    expect(resolveActiveLegOrigin(trip, NOW, { allowLegTransfer: true })).toBeNull();
  });

  it('promptDisplay, currentLegAnchor 둘 다 없음 → null', () => {
    const trip = makeTrip({ promptDisplay: undefined });
    expect(resolveActiveLegOrigin(trip, NOW)).toBeNull();
  });
});

describe('attemptBoardingAnchorResolution — leg 2 (#2515, #2511 supersede)', () => {
  function makeLeg2Trip(overrides: Partial<Trip> = {}): Trip {
    return {
      token: 'tok',
      route: { type: 'direct', line: '2', stops: 1 },
      destination: '용마산',
      waypoints: [{ stationName: '용마산', line: '2', kind: 'destination' }],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW - 10 * 60_000,
      alarmAtEpochMs: NOW + 60_000,
      infoModeEnabled: true,
      // leg 1 promptDisplay는 여전히 남아 있다(옛 origin) — currentLegAnchor가 우선해야 한다.
      promptDisplay: { originStation: '성수', line: '2' },
      currentLegAnchor: { boardingStation: '건대입구', line: '7' },
      legBoardingEligibleAt: NOW,
      ...overrides,
    };
  }

  function makeSeoulWithPositions(
    positions: Array<Partial<PositionEntry> & { trainCode: string }>,
  ): SeoulArrivalClient {
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            realtimePositionList: positions.map((p) => ({
              trainNo: p.trainCode,
              statnNm: p.stationName ?? '건대입구',
              trainSttus: p.trainSttus ?? 1,
              updnLine: p.isUp === true ? '상행' : '하행',
              lastRecptnDt: new Date((p.recptnMs ?? NOW) + 9 * 60 * 60_000)
                .toISOString()
                .slice(0, 19)
                .replace('T', ' '),
            })),
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
  }

  it('도보시간 경과 후 정확히 1개 매칭 → leg 2(건대입구/7호선) trainCode로 lock 승격, 옛 leg 1 origin(성수) 사용 안 함', async () => {
    // inferLegDirection('7', '건대입구', '용마산') === 'up' (7호선 monotonic, 실측).
    const seoul = makeSeoulWithPositions([{ trainCode: '7246', isUp: true }]);
    const trip = makeLeg2Trip({
      waypoints: [{ stationName: '용마산', line: '7', kind: 'destination' }],
    });
    // break #2 (#2323 rework) — leg 2는 allowLegTransfer:true(register-time/탭 트리거) 없이는
    // 평가되지 않는다. 이 테스트는 index.ts의 resolveBoardingAnchorAtRegister와 동일 호출 계약.
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW, { allowLegTransfer: true });
    expect(result).not.toBeNull();
    expect(result?.trainCode).toBe('7246');
    expect(result?.line).toBe('7');
    expect(result?.segmentStations[0]).toBe('건대입구');
  });

  // break #2 (#2323 rework) — cron 호출자(옵션 미전달)는 leg 2를 절대 자동 승격하지 않는다.
  it('allowLegTransfer 미전달(cron 기본값) → 도보시간 경과 + unambiguous 후보 있어도 승격 안 함', async () => {
    const seoul = makeSeoulWithPositions([{ trainCode: '7246', isUp: true }]);
    const trip = makeLeg2Trip({
      waypoints: [{ stationName: '용마산', line: '7', kind: 'destination' }],
    });
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
    expect(result).toBeNull();
  });

  it('도보시간 미경과 → null, seoul 호출 안 함 (오탑승 lock 방지 — #2511 supersede 핵심)', async () => {
    const seoul = makeSeoulWithPositions([{ trainCode: '7246' }]);
    const trip = makeLeg2Trip({ legBoardingEligibleAt: NOW + 60_000 });
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
    expect(result).toBeNull();
    expect(seoul.stats.callCount).toBe(0);
  });

  it('도보시간 경과 + 후보 2개(ambiguous) → null, lock 승격 안 함', async () => {
    const seoul = makeSeoulWithPositions([
      { trainCode: '7246' },
      { trainCode: '7248' },
    ]);
    const trip = makeLeg2Trip();
    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
    expect(result).toBeNull();
  });
});

/**
 * #2739 — 탭이 실어 보낸 station/line이 trip route와 정합하는지, 그리고 route 상 어느
 * leg(1 또는 2+)의 origin인지 판정한다. 하드코딩 인덱스 없이 waypoints 배열을 순회해
 * kind==='transfer' 지점을 탐지하므로 다중 환승도 동일 로직으로 커버된다(요구사항 3).
 */
describe('#2739 — findTapLegStart (탭 station/line의 route 정합 검증)', () => {
  function makeTapTrip(overrides: Partial<Trip> = {}): Trip {
    return {
      token: 'tok',
      route: {
        type: 'transfer',
        transferName: '건대입구',
        fromLine: '2',
        toLine: '7',
        stopsToTransfer: 2,
        stopsFromTransfer: 4,
      },
      destination: '용마산',
      waypoints: [
        { stationName: '건대입구', line: '2', kind: 'transfer' },
        { stationName: '어린이대공원', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW + 60_000,
      originStationName: '뚝섬',
      ...overrides,
    };
  }

  it('탭이 leg-1 origin(originStationName + 첫 waypoint line)과 일치 → sliceFrom 0', () => {
    const trip = makeTapTrip();
    expect(findTapLegStart(trip, '뚝섬', '2')).toEqual({ originStation: '뚝섬', sliceFrom: 0 });
  });

  it('탭이 leg-2 환승 지점(kind=transfer waypoint + 다음 waypoint line)과 일치 → 그 다음 index부터 slice', () => {
    const trip = makeTapTrip();
    expect(findTapLegStart(trip, '건대입구', '7')).toEqual({ originStation: '건대입구', sliceFrom: 1 });
  });

  it('다중 환승 — 두 번째 transfer waypoint도 배열 순회로 탐지(하드코딩 인덱스 없음)', () => {
    const trip = makeTapTrip({
      waypoints: [
        { stationName: '건대입구', line: '2', kind: 'transfer' },
        { stationName: '왕십리', line: '7', kind: 'transfer' },
        { stationName: '상왕십리', line: '5', kind: 'intermediate' },
        { stationName: '목적지', line: '5', kind: 'destination' },
      ],
    });
    expect(findTapLegStart(trip, '왕십리', '5')).toEqual({ originStation: '왕십리', sliceFrom: 2 });
  });

  it('탭 line이 route에 없는 노선 → null(거부, 요구사항 3)', () => {
    const trip = makeTapTrip();
    expect(findTapLegStart(trip, '건대입구', '9')).toBeNull();
  });

  it('탭 station이 route에 없는 역 → null(거부, 요구사항 3)', () => {
    const trip = makeTapTrip();
    expect(findTapLegStart(trip, '전혀다른역', '7')).toBeNull();
  });

  it('originStationName 없음(레거시 trip) → leg-1 매칭은 skip되지만 transfer 매칭은 그대로 평가', () => {
    const trip = makeTapTrip({ originStationName: undefined });
    expect(findTapLegStart(trip, '뚝섬', '2')).toBeNull();
    expect(findTapLegStart(trip, '건대입구', '7')).toEqual({ originStation: '건대입구', sliceFrom: 1 });
  });
});

/**
 * #2739 — `attemptBoardingAnchorResolution`이 탭(`options.tapAnchor`)을 anchor 판정에 실제로
 * 반영하는지 검증한다. 우선순위(PR 본문 근거): `currentLegAnchor`(게이트 통과) > `promptDisplay`
 * > 탭 — 탭은 **둘 다 없을 때만** 쓰는 1순위 fallback이다. 이미 있는 backend anchor를 탭이
 * 덮어쓰지 않고(회귀 없음), 도보 게이트(#2515)도 탭으로 우회되지 않는다(요구사항 2).
 */
describe('#2739 — attemptBoardingAnchorResolution({ tapAnchor })', () => {
  function makeTapTrip(overrides: Partial<Trip> = {}): Trip {
    return {
      token: 'tok',
      route: {
        type: 'transfer',
        transferName: '건대입구',
        fromLine: '2',
        toLine: '7',
        stopsToTransfer: 2,
        stopsFromTransfer: 4,
      },
      destination: '용마산',
      waypoints: [
        { stationName: '건대입구', line: '2', kind: 'transfer' },
        { stationName: '어린이대공원', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
      expiresAt: NOW + 60 * 60_000,
      createdAt: NOW,
      alarmAtEpochMs: NOW + 60_000,
      infoModeEnabled: true,
      originStationName: '뚝섬',
      ...overrides,
    };
  }

  function makeSeoulWithPositions(
    positions: Array<Partial<PositionEntry> & { trainCode: string }>,
    defaultStation = '건대입구',
  ): SeoulArrivalClient {
    return new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            realtimePositionList: positions.map((p) => ({
              trainNo: p.trainCode,
              statnNm: p.stationName ?? defaultStation,
              trainSttus: p.trainSttus ?? 1,
              updnLine: p.isUp === true ? '상행' : '하행',
              lastRecptnDt: new Date((p.recptnMs ?? NOW) + 9 * 60 * 60_000)
                .toISOString()
                .slice(0, 19)
                .replace('T', ' '),
            })),
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
  }

  it('promptDisplay/currentLegAnchor 둘 다 없음 + tapAnchor(건대입구/7, leg-2 환승 지점) → resolved, waypoints를 tap 이후로 slice해 onTapLegAdvance로 통지(요구사항 1)', async () => {
    const seoul = makeSeoulWithPositions([{ trainCode: '7256', isUp: true }]);
    const trip = makeTapTrip();
    let outcome: string | undefined;
    let advance: { waypoints: Waypoint[]; boardingStation: string; line: string } | undefined;

    const result = await attemptBoardingAnchorResolution(
      trip,
      seoul,
      NOW,
      { allowLegTransfer: true, tapAnchor: { boardingStation: '건대입구', line: '7' } },
      (o) => {
        outcome = o;
      },
      (a) => {
        advance = a;
      },
    );

    expect(result).not.toBeNull();
    expect(result?.trainCode).toBe('7256');
    expect(result?.line).toBe('7');
    expect(result?.segmentStations).toEqual(['건대입구', '어린이대공원', '용마산']);
    expect(outcome).toBe('resolved');
    expect(advance).toEqual({
      waypoints: [
        { stationName: '어린이대공원', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
      boardingStation: '건대입구',
      line: '7',
    });
  });

  it('tapAnchor가 leg-1 origin과 일치(sliceFrom=0) → resolved이지만 leg 전환이 아니므로 onTapLegAdvance는 호출 안 됨', async () => {
    // 순환선(2호선) direction 추론(arc 비교)의 우연한 방향 불일치를 피하기 위해 monotonic
    // 노선(7호선)의 origin-leg1 조합으로 구성 — inferLegDirection('7','어린이대공원','건대입구')는
    // id(018<019)이므로 'down'(기본 mock isUp:false와 일치).
    const seoul = makeSeoulWithPositions([{ trainCode: '2001' }], '어린이대공원');
    const trip = makeTapTrip({
      originStationName: '어린이대공원',
      waypoints: [
        { stationName: '건대입구', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
    });
    let advance: unknown;

    const result = await attemptBoardingAnchorResolution(
      trip,
      seoul,
      NOW,
      { allowLegTransfer: true, tapAnchor: { boardingStation: '어린이대공원', line: '7' } },
      undefined,
      (a) => {
        advance = a;
      },
    );

    expect(result).not.toBeNull();
    expect(result?.trainCode).toBe('2001');
    expect(advance).toBeUndefined();
  });

  it('tapAnchor가 route 밖(존재하지 않는 조합) → null, outcome=invalid-route, seoul 조회 자체를 안 함(요구사항 3)', async () => {
    const seoul = makeSeoulWithPositions([{ trainCode: '7256' }]);
    const trip = makeTapTrip();
    let outcome: string | undefined;

    const result = await attemptBoardingAnchorResolution(
      trip,
      seoul,
      NOW,
      { allowLegTransfer: true, tapAnchor: { boardingStation: '없는역', line: '9' } },
      (o) => {
        outcome = o;
      },
    );

    expect(result).toBeNull();
    expect(outcome).toBe('invalid-route');
    expect(seoul.stats.callCount).toBe(0);
  });

  it('currentLegAnchor 이미 존재(도보게이트 통과) + tapAnchor 충돌 → currentLegAnchor가 승리, tap은 무시된다(요구사항 2 — 우선순위 고정)', async () => {
    // tap이 이겼다면 findTapLegStart('전혀다른역','9')가 null → invalid-route가 됐을 것.
    // currentLegAnchor(건대입구/7)가 이겼다면 정상 조회되어 resolved + trainCode 7256.
    const seoul = makeSeoulWithPositions([{ trainCode: '7256', isUp: true }]);
    const trip = makeTapTrip({
      currentLegAnchor: { boardingStation: '건대입구', line: '7' },
      legBoardingEligibleAt: NOW,
      waypoints: [
        { stationName: '어린이대공원', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
    });
    let outcome: string | undefined;

    const result = await attemptBoardingAnchorResolution(
      trip,
      seoul,
      NOW,
      { allowLegTransfer: true, tapAnchor: { boardingStation: '전혀다른역', line: '9' } },
      (o) => {
        outcome = o;
      },
    );

    expect(outcome).toBe('resolved');
    expect(result?.trainCode).toBe('7256');
    expect(result?.segmentStations[0]).toBe('건대입구');
  });

  it('currentLegAnchor 존재하지만 도보게이트 미통과 + tapAnchor 있음 → 여전히 walk-gated, tap이 게이트를 우회하지 못한다(요구사항 2)', async () => {
    const seoul = makeSeoulWithPositions([{ trainCode: '7256' }]);
    const trip = makeTapTrip({
      currentLegAnchor: { boardingStation: '건대입구', line: '7' },
      legBoardingEligibleAt: NOW + 60_000,
    });
    let outcome: string | undefined;

    const result = await attemptBoardingAnchorResolution(
      trip,
      seoul,
      NOW,
      { allowLegTransfer: true, tapAnchor: { boardingStation: '건대입구', line: '7' } },
      (o) => {
        outcome = o;
      },
    );

    expect(result).toBeNull();
    expect(outcome).toBe('walk-gated');
    expect(seoul.stats.callCount).toBe(0);
  });

  it('tapAnchor 미전달(기존 caller — register-time/cron) → 기존 동작 그대로(둘 다 없음이면 outcome=none)', async () => {
    const seoul = makeSeoulWithPositions([{ trainCode: '7256' }]);
    const trip = makeTapTrip();
    let outcome: string | undefined;

    const result = await attemptBoardingAnchorResolution(trip, seoul, NOW, { allowLegTransfer: true }, (o) => {
      outcome = o;
    });

    expect(result).toBeNull();
    expect(outcome).toBe('none');
    expect(seoul.stats.callCount).toBe(0);
  });
});
