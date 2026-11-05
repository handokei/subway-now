/**
 * Route → alarm-worker(#338) Waypoint[] 변환.
 *
 * 백엔드 Waypoint는 `{stationName, line, kind}` 형태 — 백엔드가 도착정보 API를
 * 어느 호선에서 호출해야 하는지 알기 위해 line이 필요하다.
 *
 * `currentStation`이 주어지면 출발/환승/도착 사이의 중간역까지 펼쳐
 * `kind: 'intermediate'` waypoint로 포함시킨다(#416). null이면 기존 동작과 동일하게
 * transfer/destination만 반환한다.
 */

import type { LineNumber, Station } from '../../../shared/types/station';
import type { DirectRoute, MultiTransferRoute, Route, TransferRoute } from '../../../shared/utils/stationRoute';
import {
  anchorRouteToCurrentStation,
  calculateStaticETA,
  findStationByNameAndLine,
  getIntermediateStations,
  getRouteRemainingSeconds,
  isSameStationName,
} from '../../../shared/utils/stationRoute';
import type { AlarmWaypoint } from '../../../shared/types/alarm';
import { planTransferReselect } from '../../../shared/utils/journeyTimeline';

interface Context {
  destinationName: string;
  currentStation: Station | null;
  enabled: boolean;
}

// stationId는 경로 계산 함수가 채운 값만 싣는다(이름 조회로 대체하지 않음 — #3177). 없으면 키 자체를 생략.
function makeWaypoint(
  stationName: string,
  line: LineNumber,
  kind: AlarmWaypoint['kind'],
  stationId?: string,
): AlarmWaypoint {
  return { stationName, line, kind, ...(stationId && { stationId }) };
}

function intermediateWaypoints(
  ctx: Context,
  line: LineNumber,
  fromId: string | undefined,
  toId: string | undefined,
): AlarmWaypoint[] {
  if (!ctx.enabled || !fromId || !toId) return [];
  const stations = getIntermediateStations(fromId, toId);
  if (!stations) return [];
  return stations.map(({ name, id }) => makeWaypoint(name, line, 'intermediate', id));
}

function buildDirect(route: DirectRoute, ctx: Context): AlarmWaypoint[] {
  const destStation = findStationByNameAndLine(ctx.destinationName, route.line);
  const intermediates = intermediateWaypoints(
    ctx,
    route.line,
    ctx.currentStation?.id,
    destStation?.id,
  );
  const { destinationStationId } = route;
  return [...intermediates, makeWaypoint(ctx.destinationName, route.line, 'destination', destinationStationId)];
}

function buildTransfer(route: TransferRoute, ctx: Context): AlarmWaypoint[] {
  const { transferStationId, destinationStationId } = route;
  // 환승역 == 목적지 → fromLine으로 도착 처리. 실제로 내리는 곳은 fromLine 승강장(transferStationId)이다.
  if (isSameStationName(route.transferName, ctx.destinationName)) {
    const destFromLine = findStationByNameAndLine(route.transferName, route.fromLine);
    const intermediates = intermediateWaypoints(
      ctx,
      route.fromLine,
      ctx.currentStation?.id,
      destFromLine?.id,
    );
    return [
      ...intermediates,
      makeWaypoint(ctx.destinationName, route.fromLine, 'destination', transferStationId),
    ];
  }
  const transferFromLine = findStationByNameAndLine(route.transferName, route.fromLine);
  const transferToLine = findStationByNameAndLine(route.transferName, route.toLine);
  const destToLine = findStationByNameAndLine(ctx.destinationName, route.toLine);
  return [
    ...intermediateWaypoints(ctx, route.fromLine, ctx.currentStation?.id, transferFromLine?.id),
    makeWaypoint(route.transferName, route.fromLine, 'transfer', transferStationId),
    ...intermediateWaypoints(ctx, route.toLine, transferToLine?.id, destToLine?.id),
    makeWaypoint(ctx.destinationName, route.toLine, 'destination', destinationStationId),
  ];
}

function buildMultiTransfer(route: MultiTransferRoute, ctx: Context): AlarmWaypoint[] {
  // segment마다 진행하며 각 사이의 intermediate를 펼친다.
  // segment.transferName === destinationName이면 그 segment에서 destination 마킹 후 조기 return.
  const result: AlarmWaypoint[] = [];
  let segmentStart: Station | undefined = ctx.currentStation ?? undefined;

  for (const seg of route.transfers) {
    const isDestination = isSameStationName(seg.transferName, ctx.destinationName);
    const transferFromLine = findStationByNameAndLine(seg.transferName, seg.fromLine);
    result.push(
      ...intermediateWaypoints(ctx, seg.fromLine, segmentStart?.id, transferFromLine?.id),
    );
    result.push(
      makeWaypoint(
        isDestination ? ctx.destinationName : seg.transferName,
        seg.fromLine,
        isDestination ? 'destination' : 'transfer',
        seg.transferStationId,
      ),
    );
    if (isDestination) return result;
    segmentStart = findStationByNameAndLine(seg.transferName, seg.toLine);
  }

  const lastSegment = route.transfers[route.transfers.length - 1];
  const destToLine = findStationByNameAndLine(ctx.destinationName, lastSegment.toLine);
  result.push(
    ...intermediateWaypoints(ctx, lastSegment.toLine, segmentStart?.id, destToLine?.id),
  );
  result.push(makeWaypoint(ctx.destinationName, lastSegment.toLine, 'destination', route.destinationStationId));
  return result;
}

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/**
 * #2747 PR-6 (C1') — waypoint마다 "그 역에 정차해 있다고 볼 때 목적지까지 남은 초"를 stamp한다.
 * 값은 mirror writer(`liveActivityMirrorSync`)와 같은 함수·같은 입력
 * (`calculateStaticETA(anchorRouteToCurrentStation(route, 그 역, 목적지), {excludeOriginWait:true})`)이라
 * backend가 합산한 LA etaMinutes와 device mirror의 etaMinutes가 같은 의미(목적지까지)를 갖는다.
 * 도착 waypoint는 0초. 앵커링 불가(역 조회 실패·ETA null)면 필드를 생략한다 — backend는 생략 시 etaMinutes를 내지 않는다.
 *
 * #1480 PR-C — 환승 대기는 시간표(시각 의존)라 "지금 그 역에 있다"가 아니라 **그 역에 도달할 예상 시각**
 * 기준으로 평가해야 한다(이 PR 전엔 고정 3분이라 시각이 무관했다). 도달 시각 = nowMs + (현재역 기준 잔여 주행·도보
 * - 해당 역 기준 잔여 주행·도보). 지연으로 어긋나는 한계(plan B1)는 PR-E(B2)가 푼다.
 * `nowMs`는 등록 시각(미지정 시 Date.now()) — 계약 fixture는 실측 등록 시각을 고정 주입한다.
 */
/**
 * #1480 PR-E (B2) — 환승 waypoint의 대기 재선택 재료. 시간표를 쓸 수 없으면 `{}`(backend는 remainingSecToDest로 폴백).
 * `remainingSecToDest`는 등록 시점 고정값이라 열차가 늦어지면 어긋난다 — backend가 push마다 이 재료로 다시 고른다.
 */
function reselectFields(
  anchored: NonNullable<Route>,
  arrivalMs: number,
): Pick<AlarmWaypoint, 'nextLegDeparturesEpochSec' | 'transferWalkSec' | 'rideSecToDest'> {
  const plan = planTransferReselect(anchored, arrivalMs);
  if (!plan) return {};
  const { walkSeconds, departuresEpochMs, rideSeconds } = plan;
  return {
    nextLegDeparturesEpochSec: departuresEpochMs.map((ms) => Math.round(ms / MS_PER_SECOND)),
    transferWalkSec: Math.round(walkSeconds),
    rideSecToDest: Math.round(rideSeconds),
  };
}

function stampRemainingSecToDest(
  route: NonNullable<Route>,
  waypoints: AlarmWaypoint[],
  destinationName: string,
  currentStation: Station | null,
  nowMs: number | undefined,
): AlarmWaypoint[] {
  const { line: destLine } = waypoints[waypoints.length - 1];
  const destStation = findStationByNameAndLine(destinationName, destLine as LineNumber);
  const baseNowMs = nowMs ?? Date.now();
  // route가 non-null이면 anchorRouteToCurrentStation도 non-null (앵커링 불가 시 원본 route 반환).
  const anchorOf = (station: Station, destId: string): NonNullable<Route> =>
    anchorRouteToCurrentStation(route, station, destId) as NonNullable<Route>;
  const remainingFromCurrent = getRouteRemainingSeconds(
    currentStation && destStation ? anchorOf(currentStation, destStation.id) : route,
  );
  return waypoints.map((waypoint) => {
    if (waypoint.kind === 'destination') return { ...waypoint, remainingSecToDest: 0 };
    const station = findStationByNameAndLine(waypoint.stationName, waypoint.line as LineNumber);
    if (!station || !destStation) return waypoint;
    const anchored = anchorOf(station, destStation.id);
    const secondsToWaypoint = Math.max(remainingFromCurrent - getRouteRemainingSeconds(anchored), 0);
    const arrivalMs = baseNowMs + secondsToWaypoint * MS_PER_SECOND;
    // anchored는 non-null route라 ETA도 항상 숫자.
    const minutes = calculateStaticETA(anchored, { excludeOriginWait: true, nowMs: arrivalMs }) as number;
    const stamped = { ...waypoint, remainingSecToDest: minutes * SECONDS_PER_MINUTE };
    return waypoint.kind === 'transfer' ? { ...stamped, ...reselectFields(anchored, arrivalMs) } : stamped;
  });
}

export function routeToWaypoints(
  route: NonNullable<Route>,
  destinationName: string,
  currentStation: Station | null = null,
  nowMs?: number,
): AlarmWaypoint[] {
  // currentStation이 없으면 legacy 동작(transfer/destination만) — 하위 호환.
  const ctx: Context = {
    destinationName,
    currentStation,
    enabled: currentStation !== null,
  };
  const waypoints =
    route.type === 'direct'
      ? buildDirect(route, ctx)
      : route.type === 'transfer'
        ? buildTransfer(route, ctx)
        : buildMultiTransfer(route, ctx);
  return stampRemainingSecToDest(route, waypoints, destinationName, currentStation, nowMs);
}
