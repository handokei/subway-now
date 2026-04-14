import stations from '../data/stations.json';
import type { Station } from '../types/station';
import { LINE_COLORS } from '../constants/lineColors';
import type { LineNumber } from '../types/station';

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

export interface MultiTransferRoute {
  type: 'multi-transfer';
  transfers: [
    { transferName: string; fromLine: string; toLine: string; stopsToTransfer: number },
    { transferName: string; fromLine: string; toLine: string; stopsToTransfer: number },
  ];
  stopsAfterLastTransfer: number;
}

export type Route = DirectRoute | TransferRoute | MultiTransferRoute | null;

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

export function findRoute(currentId: string, destinationId: string): Route {
  const current = stationById.get(currentId);
  const destination = stationById.get(destinationId);

  if (!current || !destination) return null;

  // 같은 노선: 직통
  if (current.line === destination.line) {
    const lineStations = getLineStationsCached(current.line);
    const cIdx = lineStations.findIndex((s) => s.id === currentId);
    const dIdx = lineStations.findIndex((s) => s.id === destinationId);
    return { type: 'direct', stops: Math.abs(dIdx - cIdx) };
  }

  // 다른 노선: 환승역 탐색
  const currentLineStations = getLineStationsCached(current.line);
  const destLineStations = getLineStationsCached(destination.line);
  const currentIdx = currentLineStations.findIndex((s) => s.id === currentId);
  const destIdx = destLineStations.findIndex((s) => s.id === destinationId);

  // 목적지 노선의 이름 → 인덱스 Map (O(1) 룩업)
  const destNameIndex = getLineNameIndexCached(destination.line);

  let bestRoute: TransferRoute | null = null;
  let bestTotal = Infinity;

  for (let i = 0; i < currentLineStations.length; i++) {
    const candidate = currentLineStations[i];
    const transferDestIdx = destNameIndex.get(candidate.name);
    if (transferDestIdx === undefined) continue;

    const stopsToTransfer = Math.abs(i - currentIdx);
    const stopsFromTransfer = Math.abs(transferDestIdx - destIdx);
    const total = stopsToTransfer + stopsFromTransfer;

    if (total < bestTotal) {
      bestTotal = total;
      bestRoute = {
        type: 'transfer',
        transferName: candidate.name,
        fromLine: current.line,
        toLine: destination.line,
        stopsToTransfer,
        stopsFromTransfer,
      };
    }
  }

  if (bestRoute) return bestRoute;

  // 2회 환승 BFS: 현재노선 → 중간노선 → 목적지노선
  return findMultiTransferRoute(current, destination, currentLineStations, destLineStations, currentIdx, destIdx);
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

  // multi-transfer
  const [t1, t2] = route.transfers;
  const totalStops = t1.stopsToTransfer + t2.stopsToTransfer + route.stopsAfterLastTransfer;
  return {
    segments: [
      {
        line: t1.fromLine,
        lineColor: LINE_COLORS[t1.fromLine as LineNumber] ?? current.lineColor,
        fromName: current.name,
        toName: t1.transferName,
        stops: t1.stopsToTransfer,
      },
      {
        line: t1.toLine,
        lineColor: LINE_COLORS[t1.toLine as LineNumber] ?? '#888888',
        fromName: t1.transferName,
        toName: t2.transferName,
        stops: t2.stopsToTransfer,
      },
      {
        line: t2.toLine,
        lineColor: LINE_COLORS[t2.toLine as LineNumber] ?? destination.lineColor,
        fromName: t2.transferName,
        toName: destination.name,
        stops: route.stopsAfterLastTransfer,
      },
    ],
    totalStops,
  };
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
