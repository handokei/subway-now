import type { LineNumber, Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { findStationByNameAndLine, getStationsOnLine } from '../../../shared/utils/stationRoute';

export type RouteStationRole = 'origin' | 'transfer' | 'destination';

export interface RouteKeyStation {
  station: Station;
  role: RouteStationRole;
}

export interface RouteCoordinatePath {
  /** 경로를 따라가는 좌표 시퀀스. Polyline 그리기에 사용. */
  path: { latitude: number; longitude: number }[];
  /** 출발/환승/도착 마커로 강조할 역 목록 (순서 보존). */
  keyStations: RouteKeyStation[];
}

interface Segment {
  line: LineNumber;
  fromStation: Station;
  toStation: Station;
}

/** 두 역 사이 해당 노선의 역들을 순서대로 반환 (양 끝 포함). */
function sliceLine(line: LineNumber, fromName: string, toName: string): Station[] {
  const lineStations = getStationsOnLine(line);
  const fromIdx = lineStations.findIndex((s) => s.name === fromName);
  const toIdx = lineStations.findIndex((s) => s.name === toName);
  if (fromIdx === -1 || toIdx === -1) return [];
  const step = toIdx >= fromIdx ? 1 : -1;
  const slice: Station[] = [];
  for (let i = fromIdx; i !== toIdx + step; i += step) {
    slice.push(lineStations[i]);
  }
  return slice;
}

/** Route를 세그먼트(노선/시작역/끝역) 시퀀스로 변환. 환승 N개 일반화. */
function buildSegments(route: NonNullable<Route>, origin: Station, destination: Station): Segment[] {
  if (route.type === 'direct') {
    return [{ line: route.line, fromStation: origin, toStation: destination }];
  }

  if (route.type === 'transfer') {
    const transferFrom = findStationByNameAndLine(route.transferName, route.fromLine);
    const transferTo = findStationByNameAndLine(route.transferName, route.toLine);
    if (!transferFrom || !transferTo) return [];
    return [
      { line: route.fromLine, fromStation: origin, toStation: transferFrom },
      { line: route.toLine, fromStation: transferTo, toStation: destination },
    ];
  }

  // multi-transfer
  const segments: Segment[] = [];
  const { transfers } = route;
  let segStart = origin;
  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    const transferStart = findStationByNameAndLine(t.transferName, t.fromLine);
    const transferNext = findStationByNameAndLine(t.transferName, t.toLine);
    if (!transferStart || !transferNext) return [];
    segments.push({ line: t.fromLine, fromStation: segStart, toStation: transferStart });
    segStart = transferNext;
  }
  const lastTransfer = transfers[transfers.length - 1];
  segments.push({ line: lastTransfer.toLine, fromStation: segStart, toStation: destination });
  return segments;
}

export function routeToCoordinates(
  route: Route,
  origin: Station,
  destination: Station,
): RouteCoordinatePath | null {
  if (!route) return null;
  const segments = buildSegments(route, origin, destination);
  if (segments.length === 0) return null;

  const path: { latitude: number; longitude: number }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const slice = sliceLine(seg.line, seg.fromStation.name, seg.toStation.name);
    if (slice.length === 0) return null;
    // 첫 세그먼트 외에는 시작점이 직전 세그먼트의 끝점(환승역)과 동일하므로 중복 제거
    const start = i === 0 ? 0 : 1;
    for (let j = start; j < slice.length; j++) {
      path.push({ latitude: slice[j].lat, longitude: slice[j].lng });
    }
  }

  const keyStations: RouteKeyStation[] = [{ station: origin, role: 'origin' }];
  // 각 세그먼트 사이의 환승역 (마지막 세그먼트 끝은 도착역이므로 제외)
  for (let i = 0; i < segments.length - 1; i++) {
    keyStations.push({ station: segments[i].toStation, role: 'transfer' });
  }
  keyStations.push({ station: destination, role: 'destination' });

  return { path, keyStations };
}
