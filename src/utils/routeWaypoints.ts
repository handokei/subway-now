/**
 * Route → alarm-worker(#338) Waypoint[] 변환.
 *
 * 백엔드 Waypoint는 `{stationName, line, kind}` 형태 — 백엔드가 도착정보 API를
 * 어느 호선에서 호출해야 하는지 알기 위해 line이 필요하다.
 */

import type { Route } from './stationRoute';
import { isSameStationName } from './stationRoute';
import type { AlarmWaypoint } from '../api/alarmBackend';

/**
 * 환승역 도착 모니터링은 환승 전 호선에서 본다 (전 호선 도착정보로 그 역을 지나가는 시점 파악).
 * 최종 목적지는 마지막 구간의 호선에서 본다.
 */
export function routeToWaypoints(
  route: NonNullable<Route>,
  destinationName: string,
): AlarmWaypoint[] {
  if (route.type === 'direct') {
    return [{ stationName: destinationName, line: route.line, kind: 'destination' }];
  }

  if (route.type === 'transfer') {
    if (isSameStationName(route.transferName, destinationName)) {
      return [{ stationName: destinationName, line: route.fromLine, kind: 'destination' }];
    }
    return [
      { stationName: route.transferName, line: route.fromLine, kind: 'transfer' },
      { stationName: destinationName, line: route.toLine, kind: 'destination' },
    ];
  }

  const waypoints: AlarmWaypoint[] = route.transfers.map((seg) => {
    const isDestination = isSameStationName(seg.transferName, destinationName);
    return {
      stationName: isDestination ? destinationName : seg.transferName,
      line: seg.fromLine,
      kind: isDestination ? 'destination' : 'transfer',
    };
  });

  const lastSegment = route.transfers[route.transfers.length - 1];
  const lastWaypoint = waypoints[waypoints.length - 1];
  if (lastSegment && lastWaypoint && lastWaypoint.kind !== 'destination') {
    waypoints.push({
      stationName: destinationName,
      line: lastSegment.toLine,
      kind: 'destination',
    });
  }
  return waypoints;
}
