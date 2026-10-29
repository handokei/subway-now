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
  getIntermediateStationNames,
  isSameStationName,
} from '../../../shared/utils/stationRoute';
import type { AlarmWaypoint } from '../../../shared/types/alarm';

interface Context {
  destinationName: string;
  currentStation: Station | null;
  enabled: boolean;
}

function makeWaypoint(
  stationName: string,
  line: LineNumber,
  kind: AlarmWaypoint['kind'],
): AlarmWaypoint {
  return { stationName, line, kind };
}

function intermediateWaypoints(
  ctx: Context,
  line: LineNumber,
  fromId: string | undefined,
  toId: string | undefined,
): AlarmWaypoint[] {
  if (!ctx.enabled || !fromId || !toId) return [];
  const names = getIntermediateStationNames(fromId, toId);
  if (!names) return [];
  return names.map((stationName) => makeWaypoint(stationName, line, 'intermediate'));
}

function buildDirect(route: DirectRoute, ctx: Context): AlarmWaypoint[] {
  const destStation = findStationByNameAndLine(ctx.destinationName, route.line);
  const intermediates = intermediateWaypoints(
    ctx,
    route.line,
    ctx.currentStation?.id,
    destStation?.id,
  );
  return [...intermediates, makeWaypoint(ctx.destinationName, route.line, 'destination')];
}

function buildTransfer(route: TransferRoute, ctx: Context): AlarmWaypoint[] {
  // 환승역 == 목적지 → fromLine으로 도착 처리.
  if (isSameStationName(route.transferName, ctx.destinationName)) {
    const destFromLine = findStationByNameAndLine(route.transferName, route.fromLine);
    const intermediates = intermediateWaypoints(
      ctx,
      route.fromLine,
      ctx.currentStation?.id,
      destFromLine?.id,
    );
    return [...intermediates, makeWaypoint(ctx.destinationName, route.fromLine, 'destination')];
  }
  const transferFromLine = findStationByNameAndLine(route.transferName, route.fromLine);
  const transferToLine = findStationByNameAndLine(route.transferName, route.toLine);
  const destToLine = findStationByNameAndLine(ctx.destinationName, route.toLine);
  return [
    ...intermediateWaypoints(ctx, route.fromLine, ctx.currentStation?.id, transferFromLine?.id),
    makeWaypoint(route.transferName, route.fromLine, 'transfer'),
    ...intermediateWaypoints(ctx, route.toLine, transferToLine?.id, destToLine?.id),
    makeWaypoint(ctx.destinationName, route.toLine, 'destination'),
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
  result.push(makeWaypoint(ctx.destinationName, lastSegment.toLine, 'destination'));
  return result;
}

const SECONDS_PER_MINUTE = 60;

/**
 * #2747 PR-6 (C1') — waypoint마다 "그 역에 정차해 있다고 볼 때 목적지까지 남은 초"를 stamp한다.
 * 값은 mirror writer(`liveActivityMirrorSync`)와 같은 함수·같은 입력
 * (`calculateStaticETA(anchorRouteToCurrentStation(route, 그 역, 목적지), {excludeOriginWait:true})`)이라
 * backend가 합산한 LA etaMinutes와 device mirror의 etaMinutes가 같은 의미(목적지까지)를 갖는다.
 * 도착 waypoint는 0초. 앵커링 불가(역 조회 실패·ETA null)면 필드를 생략한다 — backend는 생략 시 etaMinutes를 내지 않는다.
 */
function stampRemainingSecToDest(
  route: NonNullable<Route>,
  waypoints: AlarmWaypoint[],
  destinationName: string,
): AlarmWaypoint[] {
  const { line: destLine } = waypoints[waypoints.length - 1];
  const destStation = findStationByNameAndLine(destinationName, destLine as LineNumber);
  return waypoints.map((waypoint) => {
    if (waypoint.kind === 'destination') return { ...waypoint, remainingSecToDest: 0 };
    const station = findStationByNameAndLine(waypoint.stationName, waypoint.line as LineNumber);
    const minutes =
      station && destStation
        ? calculateStaticETA(anchorRouteToCurrentStation(route, station, destStation.id), {
            excludeOriginWait: true,
          })
        : null;
    return minutes === null ? waypoint : { ...waypoint, remainingSecToDest: minutes * SECONDS_PER_MINUTE };
  });
}

export function routeToWaypoints(
  route: NonNullable<Route>,
  destinationName: string,
  currentStation: Station | null = null,
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
  return stampRemainingSecToDest(route, waypoints, destinationName);
}
