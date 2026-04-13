import stations from '../data/stations.json';
import type { Station } from '../types/station';
import { LINE_COLORS } from '../constants/lineColors';
import type { LineNumber } from '../types/station';

const allStations = stations as Station[];

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

export type Route = DirectRoute | TransferRoute | null;

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

export function getStationsOnLine(line: string): Station[] {
  return allStations
    .filter((s) => s.line === line)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getRemainingStops(
  currentId: string,
  destinationId: string,
): number | null {
  const current = allStations.find((s) => s.id === currentId);
  const destination = allStations.find((s) => s.id === destinationId);

  if (!current || !destination) return null;
  if (current.line !== destination.line) return null;

  const lineStations = getStationsOnLine(current.line);
  const currentIdx = lineStations.findIndex((s) => s.id === currentId);
  const destIdx = lineStations.findIndex((s) => s.id === destinationId);

  return Math.abs(destIdx - currentIdx);
}

export function findRoute(currentId: string, destinationId: string): Route {
  const current = allStations.find((s) => s.id === currentId);
  const destination = allStations.find((s) => s.id === destinationId);

  if (!current || !destination) return null;

  // 같은 노선: 직통
  if (current.line === destination.line) {
    const lineStations = getStationsOnLine(current.line);
    const cIdx = lineStations.findIndex((s) => s.id === currentId);
    const dIdx = lineStations.findIndex((s) => s.id === destinationId);
    return { type: 'direct', stops: Math.abs(dIdx - cIdx) };
  }

  // 다른 노선: 환승역 탐색
  const currentLineStations = getStationsOnLine(current.line);
  const destLineStations = getStationsOnLine(destination.line);
  const currentIdx = currentLineStations.findIndex((s) => s.id === currentId);
  const destIdx = destLineStations.findIndex((s) => s.id === destinationId);

  // 목적지 노선에 같은 이름이 있는 현재 노선의 역 = 환승 후보
  let bestRoute: TransferRoute | null = null;
  let bestTotal = Infinity;

  for (let i = 0; i < currentLineStations.length; i++) {
    const candidate = currentLineStations[i];
    const transferTarget = destLineStations.find((s) => s.name === candidate.name);
    if (!transferTarget) continue;

    const transferDestIdx = destLineStations.findIndex((s) => s.id === transferTarget.id);
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

  return bestRoute;
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

export function calculateETA(nextTrainMinutes: number, route: Route): number {
  if (!route) return nextTrainMinutes;

  const totalStops =
    route.type === 'direct'
      ? route.stops
      : route.stopsToTransfer + route.stopsFromTransfer;

  const transferTime = route.type === 'transfer' ? TRANSFER_MINUTES : 0;

  return nextTrainMinutes + totalStops * MINUTES_PER_STOP + transferTime;
}
