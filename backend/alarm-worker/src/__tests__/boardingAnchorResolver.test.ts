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

  describe('transfer-leg 확장 (#2505 follow-up) — currentLegAnchor', () => {
    it('환승 후(currentLegAnchor 존재) → promptDisplay(옛 leg 1 line) 대신 leg 2 line/역을 조회해 resolved', async () => {
      // promptDisplay는 leg 1(7호선/중곡)을 그대로 남겨둔 채(원 ORIGIN-ONLY 버그 재현 조건),
      // currentLegAnchor가 leg 2(5호선/군자)를 가리키면 leg 2가 채택돼야 한다.
      const seoul = makeSeoulWithPositions([{ trainCode: '5123', stationName: '군자' }]);
      const trip = makeTrip({
        promptDisplay: { originStation: '중곡', line: '7' },
        currentLegAnchor: { boardingStation: '군자', line: '5' },
        waypoints: [{ stationName: '아차산', line: '5', kind: 'destination' }],
      });
      const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
      expect(result).not.toBeNull();
      expect(result?.trainCode).toBe('5123');
      expect(result?.line).toBe('5');
      expect(result?.segmentStations[0]).toBe('군자');
      expect(result?.segmentStations).toContain('아차산');
    });

    it('환승 후 후보 2개(ambiguous) → null, lock 승격 안 함(leg 2도 동일 안전 기준)', async () => {
      const seoul = makeSeoulWithPositions([
        { trainCode: '5123', stationName: '군자' },
        { trainCode: '5124', stationName: '군자' },
      ]);
      const trip = makeTrip({
        currentLegAnchor: { boardingStation: '군자', line: '5' },
        waypoints: [{ stationName: '아차산', line: '5', kind: 'destination' }],
      });
      const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
      expect(result).toBeNull();
    });

    it('환승 후 후보 0개 → null', async () => {
      const seoul = makeSeoulWithPositions([]);
      const trip = makeTrip({
        currentLegAnchor: { boardingStation: '군자', line: '5' },
        waypoints: [{ stationName: '아차산', line: '5', kind: 'destination' }],
      });
      const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
      expect(result).toBeNull();
    });

    it('promptDisplay 없이 currentLegAnchor만 있어도 resolved (leg 1 프롬프트 정보 소실 케이스에도 leg 2 동작)', async () => {
      const seoul = makeSeoulWithPositions([{ trainCode: '5123', stationName: '군자' }]);
      const trip = makeTrip({
        promptDisplay: undefined,
        currentLegAnchor: { boardingStation: '군자', line: '5' },
        waypoints: [{ stationName: '아차산', line: '5', kind: 'destination' }],
      });
      const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
      expect(result).not.toBeNull();
      expect(result?.trainCode).toBe('5123');
    });

    it('infoModeEnabled !== true면 currentLegAnchor가 있어도 null (seoul 호출 안 함, 트리거 게이트 불변)', async () => {
      const seoul = makeSeoulWithPositions([{ trainCode: '5123', stationName: '군자' }]);
      const trip = makeTrip({
        infoModeEnabled: false,
        currentLegAnchor: { boardingStation: '군자', line: '5' },
        waypoints: [{ stationName: '아차산', line: '5', kind: 'destination' }],
      });
      const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
      expect(result).toBeNull();
      expect(seoul.stats.callCount).toBe(0);
    });

    it('currentLegAnchor의 line이 subwayId 매핑 실패 → null', async () => {
      const seoul = makeSeoulWithPositions([{ trainCode: '5123', stationName: '군자' }]);
      const trip = makeTrip({
        currentLegAnchor: { boardingStation: '군자', line: 'not-a-line' },
        waypoints: [{ stationName: '아차산', line: '5', kind: 'destination' }],
      });
      const result = await attemptBoardingAnchorResolution(trip, seoul, NOW);
      expect(result).toBeNull();
    });
  });
});
