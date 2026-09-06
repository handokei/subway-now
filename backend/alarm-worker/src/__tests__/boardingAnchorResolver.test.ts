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
  POSITION_FRESHNESS_MS,
  resolveActiveLegOrigin,
  resolveTrainCodeFromPositions,
  type BoardingAnchor,
} from '../boardingAnchorResolver';
import { SeoulArrivalClient, type PositionEntry } from '../seoul';
import type { Trip } from '../types';

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

  it('currentLegAnchor 있지만 legBoardingEligibleAt 미정의(비정상 상태) → null', () => {
    const trip = makeTrip({ currentLegAnchor: { boardingStation: '건대입구', line: '2' } });
    expect(resolveActiveLegOrigin(trip, NOW)).toBeNull();
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
