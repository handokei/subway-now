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

import { LINE_META } from './lineAlias';
import type { Route, Trip } from './types';

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

/** #3221 PR-5 — 여정 LA 진행 막대용 leg 정거장 수. 전부 optional(없으면 위젯이 막대를 숨긴다). */
export interface LegProgressContext {
  /** 현재 leg 전체 정거장 수(원본 route 기준 — waypoint shift와 무관하게 고정). */
  legStopsTotal?: number;
  /** 환승 후 다음 leg 전체 정거장 수. 마지막 leg면 생략. */
  nextLegStopsTotal?: number;
  /** 다음 leg 노선색(#RRGGBB). 노선을 모르면 생략. */
  nextLineColorHex?: string;
}

/** route를 leg별 { 정거장 수, 이 leg 다음에 갈아탈 노선 } 목록으로 편다 — 환승 횟수에 의존하지 않는다. */
function routeLegs(route: Route): Array<{ stops: number; nextLine?: string }> {
  if (route.type === 'direct') return [{ stops: route.stops }];
  if (route.type === 'transfer') {
    return [{ stops: route.stopsToTransfer, nextLine: route.toLine }, { stops: route.stopsFromTransfer }];
  }
  return [
    ...route.transfers.map((t) => ({ stops: t.stopsToTransfer, nextLine: t.toLine })),
    { stops: route.stopsAfterLastTransfer },
  ];
}

/**
 * 현재 leg 인덱스 = (원본 route의 leg 수 - 1) - (남은 환승 waypoint 수). `trip.route`는 shift되지 않는
 * 원본이라 leg 길이가 고정이고, `trip.waypoints`는 지나간 역이 pop되므로 남은 환승 수만 줄어든다.
 * route와 waypoints가 모순돼 인덱스가 범위 밖이면 거짓 막대 대신 빈 객체를 돌려준다.
 */
export function computeLegProgressContext(trip: Trip): LegProgressContext {
  // 남은 waypoint가 없으면(사실상 도착) computeMultiHopContext와 동일하게 빈 객체.
  if (trip.waypoints.length === 0) return {};
  // 막대는 장식이다 — route 없는 레거시/부분 레코드(타입상 필수지만 KV·테스트 fixture에 실재)가 LA push
  // 전체를 throw로 죽이면 안 된다(첫 구현이 scheduled 프롬프트 LA alert 14건을 죽였다). 없으면 생략.
  const route = trip.route as Route | undefined;
  if (route === undefined) return {};
  const legs = routeLegs(route);
  const remainingTransfers = trip.waypoints.filter((w) => w.kind === 'transfer').length;
  const legIndex = legs.length - 1 - remainingTransfers;
  if (legIndex < 0) return {};

  const { stops, nextLine } = legs[legIndex];
  const next = legs[legIndex + 1];
  const nextLineColor = nextLine === undefined ? undefined : LINE_META[nextLine]?.color;
  return {
    legStopsTotal: stops,
    ...(next === undefined ? {} : { nextLegStopsTotal: next.stops }),
    ...(nextLineColor === undefined ? {} : { nextLineColorHex: nextLineColor }),
  };
}
