import { haversine } from '../../../shared/utils/haversine';
import {
  findStationByNameAndLine,
  getStationsOnLine,
  type Route,
} from '../../../shared/utils/stationRoute';
import { shortestLinePathIndices } from '../../../shared/utils/lineLoopPath';
import type { Station } from '../../../shared/types/station';
import { MAX_INTER_STATION_M } from '../../../shared/constants/routeProgress';

// 위도 1° ≒ 111.32km (적도 기준). 서울 위도(~37.5°)에서도 위도 방향 거리는 변하지 않음.
// 경도 1°는 위도에 따라 cos(lat)배. 서울 시내(수십 km 범위)에서 등각도 평면 근사는
// 오차 1m 이하로 충분히 정확하다.
const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLng(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

export interface RouteArc {
  /** 경로 시작→끝 ordered station 시퀀스. 환승역은 노선별로 별도 Station 객체로 들어감. */
  stations: Station[];
  /** 누적 거리(m). length === stations.length, arcM[0] === 0. */
  arcM: number[];
  /** 경로 총 길이(m). */
  totalLengthM: number;
}

export interface ArcProjection {
  /** 경로 시작점부터 사영점까지 누적 거리(m). 0 ~ totalLengthM. */
  arcM: number;
  /** 사영점과 입력 좌표 사이 수직 거리(m). 경로에서 벗어난 정도. */
  perpDistanceM: number;
  /** 사영이 일어난 segment의 시작 station 인덱스. */
  segmentIndex: number;
}

export interface RoutePositionInfo {
  /** progressM에 가장 가까운 역(arc 기준 최단). */
  current: Station;
  /** progressM보다 arc가 큰 첫 번째 역. 없으면 null(목적지 통과). */
  next: Station | null;
  /** progressM보다 arc가 작은 마지막 역(current와 다르면). 없으면 null. */
  prev: Station | null;
  /** current 역과 progressM 사이 arc 거리(m). */
  distanceToCurrentM: number;
  /** next 역까지 arc 거리(m). next 없으면 null. */
  distanceToNextM: number | null;
}

function stationsBetween(
  line: Station['line'],
  fromId: string,
  toId: string,
): Station[] | null {
  const lineStations = getStationsOnLine(line);
  const fromIdx = lineStations.findIndex((s) => s.id === fromId);
  const toIdx = lineStations.findIndex((s) => s.id === toId);
  if (fromIdx === -1 || toIdx === -1) return null;
  // #1698 — 2호선 본선 closed loop은 shortestLinePathIndices가 짧은 쪽 path 반환.
  const path = shortestLinePathIndices(lineStations, fromIdx, toIdx, line);
  return path.map((i) => lineStations[i]);
}

function appendSegment(stations: Station[], segment: Station[]): void {
  // 환승 시 같은 station이 중복되지 않도록 boundary 제거.
  if (stations.length > 0 && segment.length > 0 && stations[stations.length - 1].id === segment[0].id) {
    stations.push(...segment.slice(1));
  } else {
    stations.push(...segment);
  }
}

/**
 * 경로(route) + 출발/도착 역으로 ordered station 시퀀스와 누적거리 테이블을 만든다.
 * 좌표 기반(haversine)이라 실제 트랙 곡선은 반영되지 않지만, 역 사이 직선 근사로 충분.
 * 환승 시 양 노선의 환승역을 모두 시퀀스에 넣어 노선 정보를 보존한다.
 */
export function computeRouteArc(
  route: Route,
  origin: Station,
  destination: Station,
): RouteArc | null {
  if (!route) return null;

  const stations: Station[] = [];

  if (route.type === 'direct') {
    const segment = stationsBetween(route.line, origin.id, destination.id);
    if (!segment) return null;
    appendSegment(stations, segment);
  } else if (route.type === 'transfer') {
    const fromTransfer = findStationByNameAndLine(route.transferName, route.fromLine);
    const toTransfer = findStationByNameAndLine(route.transferName, route.toLine);
    if (!fromTransfer || !toTransfer) return null;
    const seg1 = stationsBetween(route.fromLine, origin.id, fromTransfer.id);
    const seg2 = stationsBetween(route.toLine, toTransfer.id, destination.id);
    if (!seg1 || !seg2) return null;
    appendSegment(stations, seg1);
    appendSegment(stations, seg2);
  } else {
    let currentStartId = origin.id;
    for (const seg of route.transfers) {
      const fromTransfer = findStationByNameAndLine(seg.transferName, seg.fromLine);
      const toTransfer = findStationByNameAndLine(seg.transferName, seg.toLine);
      if (!fromTransfer || !toTransfer) return null;
      const subSeg = stationsBetween(seg.fromLine, currentStartId, fromTransfer.id);
      if (!subSeg) return null;
      appendSegment(stations, subSeg);
      appendSegment(stations, [toTransfer]);
      currentStartId = toTransfer.id;
    }
    const lastLine = route.transfers[route.transfers.length - 1].toLine;
    const lastSeg = stationsBetween(lastLine, currentStartId, destination.id);
    if (!lastSeg) return null;
    appendSegment(stations, lastSeg);
  }

  const arcM: number[] = [0];
  let total = 0;
  for (let i = 1; i < stations.length; i++) {
    const prev = stations[i - 1];
    const curr = stations[i];
    const segM = haversine(prev.lat, prev.lng, curr.lat, curr.lng) * 1000;
    // 노선 정렬 데이터 오류 가드: 인접 역 사이 거리가 비정상이면 polyline이 신뢰 불가.
    // arc 자체를 폐기해 호출부가 GPS-only fallback으로 빠지게 한다.
    if (segM > MAX_INTER_STATION_M) return null;
    total += segM;
    arcM.push(total);
  }

  return { stations, arcM, totalLengthM: total };
}

/**
 * (lat,lng)를 RouteArc polyline에 사영. 경로 위 가장 가까운 점의 arc 위치 + 수직 거리 반환.
 * 등각도 평면 근사: segment별로 a 기준 로컬 미터 좌표로 변환 후 표준 점-선분 사영.
 */
export function nearestArcPoint(arc: RouteArc, lat: number, lng: number): ArcProjection {
  const { stations, arcM } = arc;

  if (stations.length === 1) {
    const distM = haversine(lat, lng, stations[0].lat, stations[0].lng) * 1000;
    return { arcM: 0, perpDistanceM: distM, segmentIndex: 0 };
  }

  let bestPerpM = Infinity;
  let bestArcM = 0;
  let bestSegIdx = 0;

  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    const mPerLng = metersPerDegLng(a.lat);
    const bx = (b.lng - a.lng) * mPerLng;
    const by = (b.lat - a.lat) * METERS_PER_DEG_LAT;
    const px = (lng - a.lng) * mPerLng;
    const py = (lat - a.lat) * METERS_PER_DEG_LAT;
    const segLenSq = bx * bx + by * by;
    let t = 0;
    if (segLenSq > 0) {
      t = (px * bx + py * by) / segLenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const closestX = t * bx;
    const closestY = t * by;
    const perp = Math.hypot(px - closestX, py - closestY);
    if (perp < bestPerpM) {
      bestPerpM = perp;
      const segLenM = Math.sqrt(segLenSq);
      bestArcM = arcM[i] + t * segLenM;
      bestSegIdx = i;
    }
  }

  return { arcM: bestArcM, perpDistanceM: bestPerpM, segmentIndex: bestSegIdx };
}

/**
 * progressM(경로 시작점부터 누적거리)에 해당하는 현재/다음/이전 역 정보.
 * current = arc 기준 최단 거리 역. next/prev = 해당 역의 다음/이전 인덱스 역(경로 진행 방향).
 */
export function stationAtProgress(arc: RouteArc, progressM: number): RoutePositionInfo {
  const { stations, arcM, totalLengthM } = arc;

  if (stations.length === 1) {
    return {
      current: stations[0],
      next: null,
      prev: null,
      distanceToCurrentM: 0,
      distanceToNextM: null,
    };
  }

  const p = Math.max(0, Math.min(progressM, totalLengthM));

  let currentIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < arcM.length; i++) {
    const d = Math.abs(arcM[i] - p);
    if (d < bestDist) {
      bestDist = d;
      currentIdx = i;
    }
  }

  const next = currentIdx + 1 < stations.length ? stations[currentIdx + 1] : null;
  const prev = currentIdx > 0 ? stations[currentIdx - 1] : null;
  const distanceToNextM = next ? Math.max(0, arcM[currentIdx + 1] - p) : null;

  return {
    current: stations[currentIdx],
    next,
    prev,
    distanceToCurrentM: Math.abs(arcM[currentIdx] - p),
    distanceToNextM,
  };
}
