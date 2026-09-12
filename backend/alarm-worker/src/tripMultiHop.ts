/**
 * Multi-hop context derivation for Live Activity content-state (#1618 R9-b).
 *
 * Mirrors JS-side `buildLiveActivityData` (src/features/alarm/utils/stationNotification.ts:278)
 * which populates `destinationName / transferStationName / stopsToTransfer / stopsFromTransfer /
 * secondTransferStationName / stopsToSecondTransfer / stopsAfterLastTransfer` from a
 * `DirectRoute | TransferRoute | MultiTransferRoute`. The backend cron path historically only
 * wrote `stationName / lineName / lineColorHex / stopsRemaining / etaMinutes`, so the very first
 * APNs Live Activity update push wiped the multi-hop chain that JS init had stamped — leaving
 * the user with only the destination visible on the lock screen (#1618 evidence).
 *
 * Data source choice: `trip.waypoints` (not `trip.route`).
 *
 * `trip.waypoints` is the **shifted SSOT** — backend `advanceBoardingLockWaypoint` /
 * `runLocklessIntermediate` pop the head as the user passes stations, so it always reflects the
 * remaining station-pass events ahead. Each waypoint is one station-pass (intermediate / transfer
 * / destination). Index N in the remaining array means "N+1 stations from now" — the very next
 * station is index 0 and counts as 1 stop. This matches the JS semantics where
 * `route.stopsToTransfer` shrinks as the nearest station advances.
 *
 * `trip.route` would also work but holds the **original** route (never shifts) — using it would
 * require deriving "remaining" from cross-referencing waypoints anyway, which is what we already do.
 */

import type { Trip } from './types';

/** Multi-hop snapshot derived from a trip's remaining waypoints. */
export interface MultiHopContext {
  /** Final destination station name (last waypoint with kind='destination'). */
  destinationName?: string;
  /** First transfer station name ahead, if any. */
  transferStationName?: string;
  /** Stations to pass before reaching the first transfer (1-based; 1 = transfer is the very next stop). */
  stopsToTransfer?: number;
  /** Second transfer station name ahead (multi-transfer trips). */
  secondTransferStationName?: string;
  /** Stations to pass between first and second transfer (1-based). */
  stopsToSecondTransfer?: number;
  /** Stations to pass between the last transfer and the destination. */
  stopsAfterLastTransfer?: number;
  /** Stations to pass from the first transfer to the destination (single-transfer trips). */
  stopsFromTransfer?: number;
}

/**
 * Derive multi-hop context from a trip's remaining waypoints array.
 *
 * Returns an empty object for trips with no waypoints (effectively arrived). All fields are
 * optional — direct trips populate only `destinationName`, single-transfer trips add
 * `transferStationName` + `stopsToTransfer` + `stopsFromTransfer`, multi-transfer trips
 * additionally populate `secondTransferStationName` + `stopsToSecondTransfer` +
 * `stopsAfterLastTransfer`.
 */
export function computeMultiHopContext(trip: Trip): MultiHopContext {
  const waypoints = trip.waypoints;
  if (waypoints.length === 0) return {};

  const ctx: MultiHopContext = {};

  // Destination: the last waypoint with kind='destination'. There is normally exactly one and it
  // sits at the tail, but we scan defensively (handles future schema where intermediate could
  // wrap a destination — graceful for an edge case rather than tightly coupling to position).
  for (let i = waypoints.length - 1; i >= 0; i--) {
    if (waypoints[i].kind === 'destination') {
      ctx.destinationName = waypoints[i].stationName;
      break;
    }
  }

  // Transfers: first two transfer waypoints in order. JS-side `buildLiveActivityData` only
  // surfaces up to two transfers (MultiTransferRoute), so we cap accordingly.
  const transferIndices: number[] = [];
  for (let i = 0; i < waypoints.length; i++) {
    if (waypoints[i].kind === 'transfer') {
      transferIndices.push(i);
      if (transferIndices.length === 2) break;
    }
  }

  if (transferIndices.length >= 1) {
    const firstIdx = transferIndices[0];
    ctx.transferStationName = waypoints[firstIdx].stationName;
    // 1-based: index 0 = next stop = 1 station to pass.
    ctx.stopsToTransfer = firstIdx + 1;

    if (transferIndices.length === 2) {
      const secondIdx = transferIndices[1];
      ctx.secondTransferStationName = waypoints[secondIdx].stationName;
      ctx.stopsToSecondTransfer = secondIdx - firstIdx;
      // Multi-transfer: stops from second (last) transfer to the end (destination inclusive).
      ctx.stopsAfterLastTransfer = waypoints.length - 1 - secondIdx;
    } else {
      // Single-transfer: stops from the transfer to the end (destination inclusive).
      ctx.stopsFromTransfer = waypoints.length - 1 - firstIdx;
    }
  }

  return ctx;
}
