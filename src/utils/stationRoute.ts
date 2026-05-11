import stations from '../data/stations.json';
import type { Station } from '../types/station';
import { LINE_COLORS } from '../constants/lineColors';
import type { LineNumber } from '../types/station';
import { createLogger } from './logger';

const logger = createLogger('StationRoute');

const allStations = stations as Station[];

// O(1) 룩업 테이블 (성능 최적화)
const stationById = new Map<string, Station>(allStations.map((s) => [s.id, s]));
const lineStationsCache = new Map<string, Station[]>();

function getLineStationsCached(line: string): Station[] {
  let cached = lineStationsCache.get(line);
  if (!cached) {
    cached = allStations.filter((s) => s.line === line).sort((a, b) => a.id.localeCompare(b.id));
    lineStationsCache.set(line, cached);
  }
  return cached;
}

// 노선별 name→index 캐시 (성능 최적화: buildNameIndex 중복 호출 제거)
const lineNameIndexCache = new Map<string, Map<string, number>>();

function getLineNameIndexCached(line: string): Map<string, number> {
  let cached = lineNameIndexCache.get(line);
  if (!cached) {
    cached = buildNameIndex(getLineStationsCached(line));
    lineNameIndexCache.set(line, cached);
  }
  return cached;
}

export interface DirectRoute {
  type: 'direct';
  stops: number;
}

export interface TransferRoute {
  type: 'transfer';
  transferName: string;
  fromLine: string;
  toLine: string;
  stopsToTransfer: number;
  stopsFromTransfer: number;
}

export interface TransferSegment {
  transferName: string;
  fromLine: string;
  toLine: string;
  stopsToTransfer: number;
}

export interface MultiTransferRoute {
  type: 'multi-transfer';
  transfers: TransferSegment[];
  stopsAfterLastTransfer: number;
}

export type Route = DirectRoute | TransferRoute | MultiTransferRoute | null;

export type RoutePreference = 'optimal' | 'minTransfer';

export interface RouteCandidate {
  route: NonNullable<Route>;
  totalStops: number;
  transferCount: number;
  travelMinutes: number;
}

export interface JourneySegment {
  line: string;
  lineColor: string;
  fromName: string;
  toName: string;
  stops: number;
}

export interface JourneyDisplay {
  segments: JourneySegment[];
  totalStops: number;
}

// 환승 그래프: fromLine → toLine → 환승역 이름 목록
const transferGraph = new Map<string, Map<string, string[]>>();

function buildTransferGraph(): void {
  const nameToLines = new Map<string, Set<string>>();
  for (const s of allStations) {
    let lines = nameToLines.get(s.name);
    if (!lines) {
      lines = new Set();
      nameToLines.set(s.name, lines);
    }
    lines.add(s.line);
  }

  for (const [name, lines] of nameToLines) {
    if (lines.size < 2) continue;
    const lineArr = Array.from(lines);
    for (let i = 0; i < lineArr.length; i++) {
      for (let j = 0; j < lineArr.length; j++) {
        if (i === j) continue;
        let toMap = transferGraph.get(lineArr[i]);
        if (!toMap) {
          toMap = new Map();
          transferGraph.set(lineArr[i], toMap);
        }
        let names = toMap.get(lineArr[j]);
        if (!names) {
          names = [];
          toMap.set(lineArr[j], names);
        }
        names.push(name);
      }
    }
  }
}

buildTransferGraph();

export function getStationsOnLine(line: string): Station[] {
  return getLineStationsCached(line);
}

export function findStationByNameAndLine(name: string, line: string): Station | undefined {
  return getLineStationsCached(line).find((s) => s.name === name);
}

export function updateRouteFromPosition(
  storedRoute: NonNullable<Route>,
  nearestStation: Station,
  destinationId: string,
): Route | null {
  if (storedRoute.type === 'direct') {
    // getRemainingStops는 다른 노선이면 null을 반환하므로 노선 이탈 시 자동 fallback
    const dest = stationById.get(destinationId);
    if (!dest || nearestStation.line !== dest.line) return null;
    const remaining = getRemainingStops(nearestStation.id, destinationId);
    return remaining !== null ? { type: 'direct', stops: remaining } : null;
  }

  if (storedRoute.type === 'transfer') {
    if (nearestStation.line === storedRoute.fromLine) {
      const transfer = findStationByNameAndLine(storedRoute.transferName, storedRoute.fromLine);
      if (!transfer) return null;
      const stopsToTransfer = getRemainingStops(nearestStation.id, transfer.id);
      return stopsToTransfer !== null ? { ...storedRoute, stopsToTransfer } : null;
    }
    if (nearestStation.line === storedRoute.toLine) {
      const stopsFromTransfer = getRemainingStops(nearestStation.id, destinationId);
      return stopsFromTransfer !== null
        ? { ...storedRoute, stopsToTransfer: 0, stopsFromTransfer }
        : null;
    }
    return null;
  }

  // multi-transfer: transfers 배열을 순회하여 현재 구간 탐색
  const { transfers } = storedRoute;

  for (let i = 0; i < transfers.length; i++) {
    const segment = transfers[i];
    if (nearestStation.line === segment.fromLine) {
      const station = findStationByNameAndLine(segment.transferName, segment.fromLine);
      if (!station) return null;
      const stops = getRemainingStops(nearestStation.id, station.id);
      if (stops === null) return null;
      const updatedTransfers = transfers.map((t, j) =>
        j < i ? { ...t, stopsToTransfer: 0 } : j === i ? { ...t, stopsToTransfer: stops } : t,
      );
      return { ...storedRoute, transfers: updatedTransfers };
    }
  }

  // 마지막 환승 이후 구간 (목적지 방향)
  const lastTransfer = transfers[transfers.length - 1];
  if (lastTransfer && nearestStation.line === lastTransfer.toLine) {
    const stops = getRemainingStops(nearestStation.id, destinationId);
    if (stops === null) return null;
    const updatedTransfers = transfers.map((t) => ({ ...t, stopsToTransfer: 0 }));
    return { ...storedRoute, transfers: updatedTransfers, stopsAfterLastTransfer: stops };
  }

  return null;
}

export function isStationOnRoute(station: Station, route: NonNullable<Route>): boolean {
  if (route.type === 'direct') {
    // direct는 fromLine 정보가 없어서 노선 검증이 불가능 — 통과
    return true;
  }
  if (route.type === 'transfer') {
    return station.line === route.fromLine || station.line === route.toLine;
  }
  // multi-transfer
  for (const t of route.transfers) {
    if (station.line === t.fromLine || station.line === t.toLine) return true;
  }
  return false;
}

export function getRemainingStops(
  currentId: string,
  destinationId: string,
): number | null {
  const current = stationById.get(currentId);
  const destination = stationById.get(destinationId);

  if (!current || !destination) return null;
  if (current.line !== destination.line) return null;

  const lineStations = getLineStationsCached(current.line);
  const currentIdx = lineStations.findIndex((s) => s.id === currentId);
  const destIdx = lineStations.findIndex((s) => s.id === destinationId);

  return Math.abs(destIdx - currentIdx);
}

function buildNameIndex(stations: Station[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < stations.length; i++) {
    index.set(stations[i].name, i);
  }
  return index;
}

function toCandidate(route: NonNullable<Route>): RouteCandidate {
  const travelMinutes = getTravelMinutes(route);
  if (route.type === 'direct') {
    return { route, totalStops: route.stops, transferCount: 0, travelMinutes };
  }
  if (route.type === 'transfer') {
    const totalStops = route.stopsToTransfer + route.stopsFromTransfer;
    return { route, totalStops, transferCount: 1, travelMinutes };
  }
  const transferStops = route.transfers.reduce((sum, t) => sum + t.stopsToTransfer, 0);
  const totalStops = transferStops + route.stopsAfterLastTransfer;
  return { route, totalStops, transferCount: route.transfers.length, travelMinutes };
}

export function findRoutes(currentId: string, destinationId: string): RouteCandidate[] {
  const start = performance.now();
  const current = stationById.get(currentId);
  const destination = stationById.get(destinationId);

  if (!current || !destination) return [];

  // 같은 노선: 직통
  if (current.line === destination.line) {
    const lineStations = getLineStationsCached(current.line);
    const cIdx = lineStations.findIndex((s) => s.id === currentId);
    const dIdx = lineStations.findIndex((s) => s.id === destinationId);
    const direct: DirectRoute = { type: 'direct', stops: Math.abs(dIdx - cIdx) };
    const duration = performance.now() - start;
    logger.debug(`findRoutes(${currentId} → ${destinationId}): ${duration.toFixed(2)}ms`);
    return [toCandidate(direct)];
  }

  // 다른 노선: 단일 환승 + 2회 환승 모두 탐색
  const currentLineStations = getLineStationsCached(current.line);
  const destLineStations = getLineStationsCached(destination.line);
  const currentIdx = currentLineStations.findIndex((s) => s.id === currentId);
  const destIdx = destLineStations.findIndex((s) => s.id === destinationId);
  const destNameIndex = getLineNameIndexCached(destination.line);

  // 단일 환승 후보
  let bestSingle: TransferRoute | null = null;
  let bestSingleTotal = Infinity;

  for (let i = 0; i < currentLineStations.length; i++) {
    const candidate = currentLineStations[i];
    const transferDestIdx = destNameIndex.get(candidate.name);
    if (transferDestIdx === undefined) continue;

    const stopsToTransfer = Math.abs(i - currentIdx);
    const stopsFromTransfer = Math.abs(transferDestIdx - destIdx);
    const total = stopsToTransfer + stopsFromTransfer;

    if (total < bestSingleTotal) {
      bestSingleTotal = total;
      bestSingle = {
        type: 'transfer',
        transferName: candidate.name,
        fromLine: current.line,
        toLine: destination.line,
        stopsToTransfer,
        stopsFromTransfer,
      };
    }
  }

  // 2회 환승 후보
  const multiRoute = findMultiTransferRoute(
    current, destination, currentLineStations, destLineStations, currentIdx, destIdx,
  );

  // 후보 수집 + 정렬 + 열등 후보 제거
  const candidates: RouteCandidate[] = [];
  if (bestSingle) candidates.push(toCandidate(bestSingle));
  /* istanbul ignore next -- 실제 서울 지하철 데이터에서 2회 환승 불가 노선 조합은 없음 */
  if (multiRoute) candidates.push(toCandidate(multiRoute));

  candidates.sort((a, b) => a.travelMinutes - b.travelMinutes);

  // strict domination 필터
  const filtered = candidates.filter((c, i) => {
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const other = candidates[j];
      /* istanbul ignore next -- 현재 후보는 항상 transferCount가 다름 (1 vs 2) */
      if (other.travelMinutes <= c.travelMinutes && other.transferCount <= c.transferCount
          && (other.travelMinutes < c.travelMinutes || other.transferCount < c.transferCount)) {
        return false;
      }
    }
    return true;
  });

  const duration = performance.now() - start;
  logger.debug(`findRoutes(${currentId} → ${destinationId}): ${duration.toFixed(2)}ms`);
  return filtered;
}

export function findRoute(currentId: string, destinationId: string): Route {
  const candidates = findRoutes(currentId, destinationId);
  if (candidates.length === 0) return null;
  // 하위 호환: 환승 적은 경로 우선 (기존 동작)
  return pickRouteByPreference(candidates, 'minTransfer')!.route;
}

export function pickRouteByPreference(
  candidates: RouteCandidate[],
  preference: RoutePreference,
): RouteCandidate | null {
  if (candidates.length === 0) return null;
  if (preference === 'minTransfer') {
    return [...candidates].sort(
      (a, b) => a.transferCount - b.transferCount || a.travelMinutes - b.travelMinutes,
    )[0];
  }
  return candidates[0];
}

function findMultiTransferRoute(
  current: Station,
  destination: Station,
  currentLineStations: Station[],
  destLineStations: Station[],
  currentIdx: number,
  destIdx: number,
): MultiTransferRoute | null {
  const fromLine = current.line;
  const toLine = destination.line;
  const fromEdges = transferGraph.get(fromLine);
  /* istanbul ignore next -- 실제 역 데이터에서는 모든 노선이 환승 가능 */
  if (!fromEdges) return null;

  let best: MultiTransferRoute | null = null;
  let bestTotal = Infinity;

  const currentNameIndex = getLineNameIndexCached(current.line);
  const destNameIndex = getLineNameIndexCached(destination.line);

  // 현재 노선에서 갈 수 있는 중간 노선들
  for (const [midLine, transfer1Names] of fromEdges) {
    /* istanbul ignore next -- 직접 환승은 findRoute에서 먼저 처리됨 */
    if (midLine === toLine) continue;
    const midEdges = transferGraph.get(midLine);
    /* istanbul ignore next */
    if (!midEdges) continue;
    const transfer2Names = midEdges.get(toLine);
    /* istanbul ignore next */
    if (!transfer2Names) continue;

    const midNameIndex = getLineNameIndexCached(midLine);

    // 첫 번째 환승: 현재노선 → 중간노선
    for (const t1Name of transfer1Names) {
      const t1CurrentIdx = currentNameIndex.get(t1Name);
      const t1MidIdx = midNameIndex.get(t1Name);
      /* istanbul ignore next -- 환승 그래프가 같은 데이터에서 빌드되므로 undefined 불가 */
      if (t1CurrentIdx === undefined || t1MidIdx === undefined) continue;

      const stopsToFirst = Math.abs(t1CurrentIdx - currentIdx);

      // 두 번째 환승: 중간노선 → 목적지노선
      for (const t2Name of transfer2Names) {
        const t2MidIdx = midNameIndex.get(t2Name);
        const t2DestIdx = destNameIndex.get(t2Name);
        /* istanbul ignore next */
        if (t2MidIdx === undefined || t2DestIdx === undefined) continue;

        const stopsToSecond = Math.abs(t2MidIdx - t1MidIdx);
        const stopsAfter = Math.abs(destIdx - t2DestIdx);
        const total = stopsToFirst + stopsToSecond + stopsAfter;

        if (total < bestTotal) {
          bestTotal = total;
          best = {
            type: 'multi-transfer',
            transfers: [
              { transferName: t1Name, fromLine, toLine: midLine, stopsToTransfer: stopsToFirst },
              { transferName: t2Name, fromLine: midLine, toLine, stopsToTransfer: stopsToSecond },
            ],
            stopsAfterLastTransfer: stopsAfter,
          };
        }
      }
    }
  }

  return best;
}

const MINUTES_PER_STOP = 2;
const TRANSFER_MINUTES = 3;

export function buildJourneyDisplay(
  route: Route,
  current: Station,
  destination: Station,
): JourneyDisplay | null {
  if (!route) return null;

  if (route.type === 'direct') {
    return {
      segments: [
        {
          line: current.line,
          lineColor: current.lineColor,
          fromName: current.name,
          toName: destination.name,
          stops: route.stops,
        },
      ],
      totalStops: route.stops,
    };
  }

  if (route.type === 'transfer') {
    return {
      segments: [
        {
          line: route.fromLine,
          lineColor: LINE_COLORS[route.fromLine as LineNumber] ?? current.lineColor,
          fromName: current.name,
          toName: route.transferName,
          stops: route.stopsToTransfer,
        },
        {
          line: route.toLine,
          lineColor: LINE_COLORS[route.toLine as LineNumber] ?? destination.lineColor,
          fromName: route.transferName,
          toName: destination.name,
          stops: route.stopsFromTransfer,
        },
      ],
      totalStops: route.stopsToTransfer + route.stopsFromTransfer,
    };
  }

  // multi-transfer: transfers 배열을 순회하여 세그먼트 생성
  const { transfers } = route;
  const segments: JourneyDisplay['segments'] = transfers.map((t, i) => {
    const prevName = i === 0 ? current.name : transfers[i - 1].transferName;
    const fallbackColor = i === 0 ? current.lineColor : '#888888';
    return {
      line: t.fromLine,
      lineColor: LINE_COLORS[t.fromLine as LineNumber] ?? fallbackColor,
      fromName: prevName,
      toName: t.transferName,
      stops: t.stopsToTransfer,
    };
  });
  const lastTransfer = transfers[transfers.length - 1];
  segments.push({
    line: lastTransfer.toLine,
    lineColor: LINE_COLORS[lastTransfer.toLine as LineNumber] ?? destination.lineColor,
    fromName: lastTransfer.transferName,
    toName: destination.name,
    stops: route.stopsAfterLastTransfer,
  });
  const totalStops = transfers.reduce((sum, t) => sum + t.stopsToTransfer, 0) + route.stopsAfterLastTransfer;
  return { segments, totalStops };
}

const DEFAULT_WAIT_MINUTES = 3;

function getTravelMinutes(route: NonNullable<Route>): number {
  if (route.type === 'direct') {
    return route.stops * MINUTES_PER_STOP;
  }

  if (route.type === 'transfer') {
    const totalStops = route.stopsToTransfer + route.stopsFromTransfer;
    return totalStops * MINUTES_PER_STOP + TRANSFER_MINUTES;
  }

  const transferStops = route.transfers.reduce((sum, t) => sum + t.stopsToTransfer, 0);
  const totalStops = transferStops + route.stopsAfterLastTransfer;
  return totalStops * MINUTES_PER_STOP + TRANSFER_MINUTES * route.transfers.length;
}

export function calculateStaticETA(route: Route): number | null {
  if (!route) return null;
  return DEFAULT_WAIT_MINUTES + getTravelMinutes(route);
}

export function calculateETA(nextTrainMinutes: number, route: Route): number {
  if (!route) return nextTrainMinutes;
  return nextTrainMinutes + getTravelMinutes(route);
}

function getNextStationOnLine(
  line: string,
  currentName: string,
  targetName: string,
): string | null {
  const nameIndex = getLineNameIndexCached(line);
  const currentIdx = nameIndex.get(currentName);
  const targetIdx = nameIndex.get(targetName);
  if (currentIdx === undefined || targetIdx === undefined) return null;
  if (currentIdx === targetIdx) return null;

  const lineStations = getLineStationsCached(line);
  const step = targetIdx > currentIdx ? 1 : -1;
  const nextIdx = currentIdx + step;
  /* istanbul ignore next -- 노선 데이터에서 boundary를 벗어나는 케이스는 발생 불가 */
  if (nextIdx < 0 || nextIdx >= lineStations.length) return null;
  return lineStations[nextIdx].name;
}

export function getNextStationName(
  currentId: string,
  destinationId: string,
  route: Route,
): string | null {
  if (!route) return null;
  const current = stationById.get(currentId);
  const destination = stationById.get(destinationId);
  if (!current || !destination) return null;

  if (route.type === 'direct') {
    return getNextStationOnLine(current.line, current.name, destination.name);
  }

  if (route.type === 'transfer') {
    if (route.stopsToTransfer > 0) {
      return getNextStationOnLine(route.fromLine, current.name, route.transferName);
    }
    // 환승 완료 후: toLine에서 목적지 방향 (환승역은 양 노선에 동일 이름으로 존재)
    return getNextStationOnLine(route.toLine, current.name, destination.name);
  }

  // multi-transfer
  // multi-transfer: 첫 번째 미완료 구간의 다음 역 반환
  const { transfers } = route;
  for (let i = 0; i < transfers.length; i++) {
    const segment = transfers[i];
    if (segment.stopsToTransfer > 0) {
      const line = i === 0 ? segment.fromLine : transfers[i - 1].toLine;
      return getNextStationOnLine(line, current.name, segment.transferName);
    }
  }
  const lastTransfer = transfers[transfers.length - 1];
  return getNextStationOnLine(lastTransfer.toLine, current.name, destination.name);
}
