/**
 * Unit tests for `computeMultiHopContext` (#1618 R9-b).
 *
 * `buildLiveActivityContentState` integrations are exercised in `liveActivity.test.ts`;
 * this file pins the lower-level helper semantics — index/off-by-one math, defensive
 * scanning, and empty-input handling.
 */

import { describe, expect, it } from 'vitest';
import { computeMultiHopContext } from '../tripMultiHop';
import type { Trip, Waypoint } from '../types';

const NOW = 1_700_000_000_000;

function makeTrip(waypoints: Waypoint[]): Trip {
  return {
    token: 'tok',
    route: { type: 'direct', line: '2', stops: waypoints.length },
    destination: 'dst',
    waypoints,
    expiresAt: NOW + 3_600_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000,
  };
}

describe('computeMultiHopContext (#1618)', () => {
  it('returns empty object for trips with no remaining waypoints', () => {
    expect(computeMultiHopContext(makeTrip([]))).toEqual({});
  });

  // Direct trip (no transfer waypoints) — only destinationName is populated.
  it.each<[string, Waypoint[]]>([
    ['destination only', [{ stationName: '강남', line: '2', kind: 'destination' }]],
    [
      'intermediate + destination',
      [
        { stationName: '중곡', line: '2', kind: 'intermediate' },
        { stationName: '강남', line: '2', kind: 'destination' },
      ],
    ],
  ])('direct trip (%s) populates destinationName only', (_label, waypoints) => {
    const ctx = computeMultiHopContext(makeTrip(waypoints));
    expect(ctx.destinationName).toBe('강남');
    expect(ctx.transferStationName).toBeUndefined();
    expect(ctx.stopsToTransfer).toBeUndefined();
    expect(ctx.stopsFromTransfer).toBeUndefined();
    expect(ctx.secondTransferStationName).toBeUndefined();
    expect(ctx.stopsToSecondTransfer).toBeUndefined();
    expect(ctx.stopsAfterLastTransfer).toBeUndefined();
  });

  /**
   * Single-transfer cases. `stopsToTransfer` = (index of transfer) + 1 — 1-based count of
   * stations to pass, where 1 = next stop. `stopsFromTransfer` = remaining count after the
   * transfer waypoint (= waypoints.length - 1 - transferIdx).
   */
  it.each<[string, Waypoint[], number, number]>([
    [
      'transfer as next waypoint',
      [
        { stationName: '시청', line: '2', kind: 'transfer' },
        { stationName: '강남', line: '1', kind: 'destination' },
      ],
      1,
      1,
    ],
    [
      'transfer after 1 intermediate',
      [
        { stationName: 'A', line: '2', kind: 'intermediate' },
        { stationName: '시청', line: '2', kind: 'transfer' },
        { stationName: 'C', line: '1', kind: 'intermediate' },
        { stationName: '강남', line: '1', kind: 'destination' },
      ],
      2,
      2,
    ],
    [
      'transfer after 3 intermediates',
      [
        { stationName: 'A', line: '2', kind: 'intermediate' },
        { stationName: 'B', line: '2', kind: 'intermediate' },
        { stationName: 'C', line: '2', kind: 'intermediate' },
        { stationName: '시청', line: '2', kind: 'transfer' },
        { stationName: '강남', line: '1', kind: 'destination' },
      ],
      4,
      1,
    ],
  ])(
    'single-transfer (%s) → stopsToTransfer=%i, stopsFromTransfer=%i',
    (_label, waypoints, expectedTo, expectedFrom) => {
      const ctx = computeMultiHopContext(makeTrip(waypoints));
      expect(ctx.transferStationName).toBe('시청');
      expect(ctx.stopsToTransfer).toBe(expectedTo);
      expect(ctx.stopsFromTransfer).toBe(expectedFrom);
      expect(ctx.secondTransferStationName).toBeUndefined();
      expect(ctx.stopsToSecondTransfer).toBeUndefined();
      expect(ctx.stopsAfterLastTransfer).toBeUndefined();
      expect(ctx.destinationName).toBe('강남');
    },
  );

  /**
   * Multi-transfer cases (≥2 transfers). `stopsAfterLastTransfer` replaces `stopsFromTransfer`
   * (matches JS-side `MultiTransferRoute` schema). Only the first two transfers are surfaced —
   * extra transfer waypoints are ignored (JS LA UI also caps at 2).
   */
  it.each<[string, Waypoint[], number, number, number]>([
    [
      'two adjacent transfers',
      [
        { stationName: '시청', line: '2', kind: 'transfer' },
        { stationName: '동대문', line: '1', kind: 'transfer' },
        { stationName: '강남', line: '4', kind: 'destination' },
      ],
      1, // stopsToTransfer
      1, // stopsToSecondTransfer
      1, // stopsAfterLastTransfer
    ],
    [
      'two transfers with intermediates between',
      [
        { stationName: 'A', line: '2', kind: 'intermediate' },
        { stationName: '시청', line: '2', kind: 'transfer' },
        { stationName: 'C', line: '1', kind: 'intermediate' },
        { stationName: '동대문', line: '1', kind: 'transfer' },
        { stationName: 'E', line: '4', kind: 'intermediate' },
        { stationName: 'F', line: '4', kind: 'intermediate' },
        { stationName: '강남', line: '4', kind: 'destination' },
      ],
      2,
      2,
      3,
    ],
    [
      'three transfers — only first two surface',
      [
        { stationName: '시청', line: '2', kind: 'transfer' },
        { stationName: '동대문', line: '1', kind: 'transfer' },
        { stationName: '왕십리', line: '4', kind: 'transfer' },
        { stationName: '강남', line: '5', kind: 'destination' },
      ],
      1,
      1,
      2,
    ],
  ])(
    'multi-transfer (%s) → stopsToTransfer=%i, stopsToSecondTransfer=%i, stopsAfterLastTransfer=%i',
    (_label, waypoints, expectedTo, expectedToSecond, expectedAfterLast) => {
      const ctx = computeMultiHopContext(makeTrip(waypoints));
      expect(ctx.transferStationName).toBe('시청');
      expect(ctx.secondTransferStationName).toBe('동대문');
      expect(ctx.stopsToTransfer).toBe(expectedTo);
      expect(ctx.stopsToSecondTransfer).toBe(expectedToSecond);
      expect(ctx.stopsAfterLastTransfer).toBe(expectedAfterLast);
      expect(ctx.stopsFromTransfer).toBeUndefined();
      expect(ctx.destinationName).toBe('강남');
    },
  );

  /**
   * Defensive scanning — `destinationName` extraction walks waypoints from the tail and picks
   * the last waypoint with `kind='destination'`. Normally exactly one and at the tail, but the
   * scan tolerates schema drift (e.g. backfilled intermediates after the destination).
   */
  it('defensive destination scan — picks last destination even if not at tail', () => {
    const ctx = computeMultiHopContext(
      makeTrip([
        { stationName: '강남', line: '2', kind: 'destination' },
        { stationName: '잘못된역', line: '2', kind: 'intermediate' },
      ]),
    );
    expect(ctx.destinationName).toBe('강남');
  });

  /**
   * Waypoints with no `destination` kind at all (edge case — should not happen but graceful).
   * Returns undefined `destinationName` rather than crashing.
   */
  it('returns undefined destinationName when no destination waypoint present', () => {
    const ctx = computeMultiHopContext(
      makeTrip([{ stationName: 'A', line: '2', kind: 'intermediate' }]),
    );
    expect(ctx.destinationName).toBeUndefined();
  });
});
