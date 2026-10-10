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

// Waypoint factory helpers — kill the repeated `{ stationName, line, kind }` literal noise across
// it.each cases. `line` defaults to '2' (most cases) and overrides only when crossing lines.
const wp = (
  stationName: string,
  kind: Waypoint['kind'],
  line: string = '2',
): Waypoint => ({ stationName, line, kind });
const int = (stationName: string, line: string = '2'): Waypoint => wp(stationName, 'intermediate', line);
const tx = (stationName: string, line: string = '2'): Waypoint => wp(stationName, 'transfer', line);
const dst = (stationName: string, line: string = '2'): Waypoint => wp(stationName, 'destination', line);

describe('computeMultiHopContext (#1618)', () => {
  it('returns empty object for trips with no remaining waypoints', () => {
    expect(computeMultiHopContext(makeTrip([]))).toEqual({});
  });

  // Direct trip (no transfer waypoints) — only destinationName is populated.
  it.each<[string, Waypoint[]]>([
    ['destination only', [dst('강남')]],
    ['intermediate + destination', [int('중곡'), dst('강남')]],
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
    ['transfer as next waypoint', [tx('시청'), dst('강남', '1')], 1, 1],
    [
      'transfer after 1 intermediate',
      [int('A'), tx('시청'), int('C', '1'), dst('강남', '1')],
      2,
      2,
    ],
    [
      'transfer after 3 intermediates',
      [int('A'), int('B'), int('C'), tx('시청'), dst('강남', '1')],
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
      [tx('시청'), tx('동대문', '1'), dst('강남', '4')],
      1, // stopsToTransfer
      1, // stopsToSecondTransfer
      1, // stopsAfterLastTransfer
    ],
    [
      'two transfers with intermediates between',
      [
        int('A'),
        tx('시청'),
        int('C', '1'),
        tx('동대문', '1'),
        int('E', '4'),
        int('F', '4'),
        dst('강남', '4'),
      ],
      2,
      2,
      3,
    ],
    [
      'three transfers — only first two surface',
      [tx('시청'), tx('동대문', '1'), tx('왕십리', '4'), dst('강남', '5')],
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
    const ctx = computeMultiHopContext(makeTrip([dst('강남'), int('잘못된역')]));
    expect(ctx.destinationName).toBe('강남');
  });

  /**
   * Waypoints with no `destination` kind at all (edge case — should not happen but graceful).
   * Returns undefined `destinationName` rather than crashing.
   */
  it('returns undefined destinationName when no destination waypoint present', () => {
    const ctx = computeMultiHopContext(makeTrip([int('A')]));
    expect(ctx.destinationName).toBeUndefined();
  });
});
