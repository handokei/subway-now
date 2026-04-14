import type { StationArrival } from '../api/arrivalApi';

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
