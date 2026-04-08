import stations from '../data/stations.json';
import type { Station } from '../types/station';

const allStations = stations as Station[];

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
