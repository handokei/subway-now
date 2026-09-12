import { describe, expect, it } from 'vitest';

import {
  TRANSFER_DESTINATION_FRESH_WINDOW_MS,
  evaluateTransferDestinationGate,
  isAtOrApproachingTransferDestination,
  isSsotAdvanceRecent,
  isTransferOrDestination,
  type TransferDestinationBlockReason,
} from '../transferDestinationGate';
import type { TripPositionSSoT } from '../tripPositionSsot';
import type { Trip, Waypoint } from '../types';

/**
 * ADR-017 T7 (#1560) — transfer/destination 발사 직전 SSoT 위치 + 신선도 게이트 단위 테스트.
 *
 * 본 suite는 evidence 시나리오(transferScenarios)를 it.each로 박제해 N9 회귀(2026-06-19 정지
 * trip "환승임박 건대입구" false 발사) 차단을 직접 단언한다. integration 레벨 wire-up은
 * scheduled.test.ts의 T4 suite가 cover.
 */

const NOW = 1_750_000_000_000;
const FRESH_LAST_ADVANCE = NOW - 30_000;
const STALE_LAST_ADVANCE = NOW - 90_000;

function makeSsot(overrides?: Partial<TripPositionSSoT>): TripPositionSSoT {
  return {
    tripToken: 'tok-t7',
    currentStationId: '건대입구',
    motionState: 'moving',
    motionEvidence: [],
    lastAdvanceAt: FRESH_LAST_ADVANCE,
    lastAdvanceEvidence: 'arvlcd-confirmed-train',
    passedStations: ['뚝섬', '성수'],
    userIntentDeclared: false,
    seedOverrideCount: 0,
    schemaVersion: 1,
    ...overrides,
  };
}

function makeTrip(overrides?: Partial<Trip>): Trip {
  return {
    token: 'tok-t7',
    route: { type: 'direct', stops: 5, line: '2' },
    destination: '강남',
    waypoints: [{ stationName: '건대입구', line: '2', kind: 'transfer' }],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 30 * 60_000,
    passedStations: ['뚝섬', '성수'],
    ...overrides,
  };
}

function makeWaypoint(overrides?: Partial<Waypoint>): Waypoint {
  return {
    stationName: '건대입구',
    line: '2',
    kind: 'transfer',
    ...overrides,
  };
}

describe('isTransferOrDestination', () => {
  it.each([
    ['transfer', true],
    ['destination', true],
    ['intermediate', false],
  ] as const)('kind=%s → %s', (kind, expected) => {
    expect(isTransferOrDestination({ kind })).toBe(expected);
  });
});

describe('isAtOrApproachingTransferDestination', () => {
  it('at-target — currentStationId === waypoint.stationName → true', () => {
    expect(
      isAtOrApproachingTransferDestination(
        makeSsot({ currentStationId: '건대입구' }),
        makeTrip(),
        makeWaypoint(),
      ),
    ).toBe(true);
  });

  it('approaching — currentStationId === last passedStation → true', () => {
    expect(
      isAtOrApproachingTransferDestination(
        makeSsot({ currentStationId: '성수' }),
        makeTrip({ passedStations: ['뚝섬', '성수'] }),
        makeWaypoint(),
      ),
    ).toBe(true);
  });

  it('mismatch — currentStationId is some other station → false (N9 박제)', () => {
    expect(
      isAtOrApproachingTransferDestination(
        makeSsot({ currentStationId: '용마산' }),
        makeTrip({ passedStations: ['뚝섬', '성수'] }),
        makeWaypoint(),
      ),
    ).toBe(false);
  });

  it('empty passedStations + currentStationId !== waypoint → false', () => {
    expect(
      isAtOrApproachingTransferDestination(
        makeSsot({ currentStationId: '용마산' }),
        makeTrip({ passedStations: [] }),
        makeWaypoint(),
      ),
    ).toBe(false);
  });

  it('passedStations undefined → falls back to empty (no 1-hop candidate)', () => {
    expect(
      isAtOrApproachingTransferDestination(
        makeSsot({ currentStationId: '용마산' }),
        { passedStations: undefined } as unknown as Trip,
        makeWaypoint(),
      ),
    ).toBe(false);
  });
});

describe('isSsotAdvanceRecent', () => {
  it('fresh — lastAdvanceAt within window → true', () => {
    expect(isSsotAdvanceRecent({ lastAdvanceAt: NOW - 30_000 }, NOW)).toBe(true);
  });

  it('exactly window boundary → true (≤ inclusive)', () => {
    expect(
      isSsotAdvanceRecent(
        { lastAdvanceAt: NOW - TRANSFER_DESTINATION_FRESH_WINDOW_MS },
        NOW,
      ),
    ).toBe(true);
  });

  it('stale — beyond window → false', () => {
    expect(isSsotAdvanceRecent({ lastAdvanceAt: NOW - 90_000 }, NOW)).toBe(false);
  });

  it('lastAdvanceAt===0 (미advance, lazy-seed 직후) → true (dormant, T4 unknown 통과 정책과 정합)', () => {
    expect(isSsotAdvanceRecent({ lastAdvanceAt: 0 }, NOW)).toBe(true);
  });
});

describe('evaluateTransferDestinationGate', () => {
  type Scenario = {
    name: string;
    currentStationId: string;
    lastAdvanceAt: number;
    passedStations?: string[];
    expectPass: boolean;
    expectReason?: TransferDestinationBlockReason;
  };

  const transferScenarios: Scenario[] = [
    // Positive
    {
      name: 'P1 at-transfer + 신선 → pass',
      currentStationId: '건대입구',
      lastAdvanceAt: FRESH_LAST_ADVANCE,
      expectPass: true,
    },
    {
      name: 'P2 직전 1 hop + 신선 → pass',
      currentStationId: '성수',
      lastAdvanceAt: FRESH_LAST_ADVANCE,
      expectPass: true,
    },
    // Negative — N9 회귀 박제
    {
      name: 'N9 SSoT 정지 다른 station + 신선 → block(ssot-not-at-or-approaching)',
      currentStationId: '용마산',
      lastAdvanceAt: FRESH_LAST_ADVANCE,
      expectPass: false,
      expectReason: 'ssot-not-at-or-approaching',
    },
    {
      name: 'N9-stale at-transfer 인데 60s 초과 → block(ssot-stale)',
      currentStationId: '건대입구',
      lastAdvanceAt: STALE_LAST_ADVANCE,
      expectPass: false,
      expectReason: 'ssot-stale',
    },
    {
      name: 'P3 at-transfer 인데 lastAdvanceAt===0 (legacy / lazy-seed 직후) → pass(dormant)',
      currentStationId: '건대입구',
      lastAdvanceAt: 0,
      expectPass: true,
    },
  ];

  it.each(transferScenarios)('$name', (sc) => {
    const ssot = makeSsot({
      currentStationId: sc.currentStationId,
      lastAdvanceAt: sc.lastAdvanceAt,
    });
    const trip = makeTrip({ passedStations: sc.passedStations ?? ['뚝섬', '성수'] });
    const waypoint = makeWaypoint();
    const outcome = evaluateTransferDestinationGate(ssot, trip, waypoint, NOW);
    expect(outcome.pass).toBe(sc.expectPass);
    if (!sc.expectPass) {
      expect(outcome.blockReason).toBe(sc.expectReason);
    } else {
      expect(outcome.blockReason).toBeUndefined();
    }
  });

  it('destination kind도 동일 게이트 통과 (N10 박제)', () => {
    const ssot = makeSsot({ currentStationId: '강남', lastAdvanceAt: FRESH_LAST_ADVANCE });
    const trip = makeTrip();
    const waypoint = makeWaypoint({ stationName: '강남', kind: 'destination' });
    expect(evaluateTransferDestinationGate(ssot, trip, waypoint, NOW).pass).toBe(true);
  });

  it('destination + SSoT 정지 다른 station → block', () => {
    const ssot = makeSsot({ currentStationId: '용마산', lastAdvanceAt: FRESH_LAST_ADVANCE });
    const trip = makeTrip({ passedStations: ['뚝섬', '성수'] });
    const waypoint = makeWaypoint({ stationName: '강남', kind: 'destination' });
    const outcome = evaluateTransferDestinationGate(ssot, trip, waypoint, NOW);
    expect(outcome.pass).toBe(false);
    expect(outcome.blockReason).toBe('ssot-not-at-or-approaching');
  });
});
