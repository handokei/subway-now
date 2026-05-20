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

import type { LineNumber, Station } from '../types/station';
import type { Route } from './stationRoute';
import {
  findStationByNameAndLine,
  getIntermediateStationNames,
  isSameStationName,
} from './stationRoute';
import type { AlarmWaypoint } from '../api/alarmBackend';

function intermediateWaypoints(
  enabled: boolean,
  line: LineNumber,
  fromId: string | undefined,
  toId: string | undefined,
): AlarmWaypoint[] {
  if (!enabled || !fromId || !toId) return [];
  const names = getIntermediateStationNames(fromId, toId);
  if (!names) return [];
  return names.map((stationName) => ({ stationName, line, kind: 'intermediate' as const }));
}

export function routeToWaypoints(
  route: NonNullable<Route>,
  destinationName: string,
  currentStation: Station | null = null,
): AlarmWaypoint[] {
  // currentStation이 없으면 legacy 동작(transfer/destination만) — 하위 호환.
  const enabled = currentStation !== null;
  if (route.type === 'direct') {
    const destStation = findStationByNameAndLine(destinationName, route.line);
    const intermediates = intermediateWaypoints(enabled, route.line, currentStation?.id, destStation?.id);
    return [
      ...intermediates,
      { stationName: destinationName, line: route.line, kind: 'destination' },
    ];
  }

  if (route.type === 'transfer') {
    if (isSameStationName(route.transferName, destinationName)) {
      const destFromLine = findStationByNameAndLine(route.transferName, route.fromLine);
      const intermediates = intermediateWaypoints(
        enabled,
        route.fromLine,
        currentStation?.id,
        destFromLine?.id,
      );
      return [
        ...intermediates,
        { stationName: destinationName, line: route.fromLine, kind: 'destination' },
      ];
    }
    const transferFromLine = findStationByNameAndLine(route.transferName, route.fromLine);
    const transferToLine = findStationByNameAndLine(route.transferName, route.toLine);
    const destToLine = findStationByNameAndLine(destinationName, route.toLine);
    const preIntermediates = intermediateWaypoints(
      enabled,
      route.fromLine,
      currentStation?.id,
      transferFromLine?.id,
    );
    const postIntermediates = intermediateWaypoints(
      enabled,
      route.toLine,
      transferToLine?.id,
      destToLine?.id,
    );
    return [
      ...preIntermediates,
      { stationName: route.transferName, line: route.fromLine, kind: 'transfer' },
      ...postIntermediates,
      { stationName: destinationName, line: route.toLine, kind: 'destination' },
    ];
  }

  // multi-transfer: segment마다 진행하며 각 사이의 intermediate를 펼친다.
  // segment의 transferName이 destinationName과 같으면 그 segment에서 destination으로 마킹 후 조기 return —
  // 이후 segment는 의미가 없으므로 (도착했으니 환승할 일도, post-intermediate도 없다).
  const result: AlarmWaypoint[] = [];
  let segmentStartStation: Station | undefined = currentStation ?? undefined;

  for (const seg of route.transfers) {
    const isDestination = isSameStationName(seg.transferName, destinationName);
    const transferFromLine = findStationByNameAndLine(seg.transferName, seg.fromLine);
    result.push(
      ...intermediateWaypoints(enabled, seg.fromLine, segmentStartStation?.id, transferFromLine?.id),
    );
    result.push({
      stationName: isDestination ? destinationName : seg.transferName,
      line: seg.fromLine,
      kind: isDestination ? 'destination' : 'transfer',
    });
    if (isDestination) return result;
    segmentStartStation = findStationByNameAndLine(seg.transferName, seg.toLine);
  }

  const lastSegment = route.transfers[route.transfers.length - 1];
  const destToLine = findStationByNameAndLine(destinationName, lastSegment.toLine);
  result.push(
    ...intermediateWaypoints(enabled, lastSegment.toLine, segmentStartStation?.id, destToLine?.id),
  );
  result.push({ stationName: destinationName, line: lastSegment.toLine, kind: 'destination' });
  return result;
}
