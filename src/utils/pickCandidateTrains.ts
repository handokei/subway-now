import type { LinePositions } from '../api/positionApi';
import type { LineNumber } from '../types/station';
import { getStationsOnLine } from './stationRoute';

export interface CandidateTrain {
  trainNo: string;
  line: LineNumber;
  direction: 0 | 1;
  currentStationName: string;
  trainStatus: number;
  receivedAtMs: number;
}

export interface PickCandidateTrainsInput {
  positions: LinePositions[];
  line: LineNumber;
  direction?: 0 | 1;
  anchorStationName?: string;
  windowStations?: number;
}

const DEFAULT_WINDOW_STATIONS = 3;

export function pickCandidateTrains(input: PickCandidateTrainsInput): CandidateTrain[] {
  const { positions, line, direction, anchorStationName, windowStations } = input;

  const linePositions = positions.find((p) => p.line === line);
  if (!linePositions) return [];

  const stationsOnLine = getStationsOnLine(line);
  const nameToIndex = new Map<string, number>();
  stationsOnLine.forEach((s, i) => nameToIndex.set(s.name, i));

  const window = Math.max(0, windowStations ?? DEFAULT_WINDOW_STATIONS);
  const anchorIdx =
    anchorStationName !== undefined ? nameToIndex.get(anchorStationName) : undefined;

  const candidates: Array<{ candidate: CandidateTrain; sortKey: number }> = [];

  for (const train of linePositions.trains) {
    if (train.receivedAtMs <= 0) continue;
    // positionApi가 파싱 실패 시 updnLine=-1을 sentinel로 내보낸다. 방향 모름은 후보에서 제외.
    if (train.updnLine !== 0 && train.updnLine !== 1) continue;
    if (direction !== undefined && train.updnLine !== direction) continue;

    const stationIdx = nameToIndex.get(train.statnNm);
    if (stationIdx === undefined) continue;

    if (anchorIdx !== undefined && Math.abs(stationIdx - anchorIdx) > window) continue;

    const sortKey = anchorIdx !== undefined ? Math.abs(stationIdx - anchorIdx) : 0;
    candidates.push({
      candidate: {
        trainNo: train.trainNo,
        line,
        direction: train.updnLine,
        currentStationName: train.statnNm,
        trainStatus: train.trainStatus,
        receivedAtMs: train.receivedAtMs,
      },
      sortKey,
    });
  }

  candidates.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    return a.candidate.trainNo.localeCompare(b.candidate.trainNo);
  });

  return candidates.map((c) => c.candidate);
}
