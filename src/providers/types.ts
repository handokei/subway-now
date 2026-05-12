import type { StationArrival } from '../api/arrivalApi';
import type { LinePositions, FetchPositionOptions } from '../api/positionApi';
import type { LineNumber } from '../types/station';

export interface ArrivalOptions {
  timeoutMs?: number;
  maxPerDirection?: number;
}

export interface ArrivalProvider {
  getArrival(
    stationName: string,
    options?: ArrivalOptions,
  ): Promise<StationArrival>;
}

/** 호선 단위 실시간 열차위치 조회 — Phase 3. */
export interface PositionProvider {
  getPositions(line: LineNumber, options?: FetchPositionOptions): Promise<LinePositions>;
}
