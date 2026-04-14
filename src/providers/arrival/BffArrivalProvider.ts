import type { ArrivalProvider, ArrivalOptions } from '../types';
import type { StationArrival } from '../../api/arrivalApi';
import { MOCK_ARRIVALS } from '../../api/arrivalApi';

export class BffArrivalProvider implements ArrivalProvider {
  constructor(private readonly baseUrl: string) {}

  async getArrival(
    stationName: string,
    options?: ArrivalOptions,
  ): Promise<StationArrival> {
    const { timeoutMs = 5000, maxPerDirection = 2 } = options ?? {};

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `${this.baseUrl}/api/arrival/${encodeURIComponent(stationName)}?maxPerDirection=${maxPerDirection}`;
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        return MOCK_ARRIVALS;
      }

      const data: StationArrival = await response.json();

      if (data.up.length === 0 && data.down.length === 0) {
        return MOCK_ARRIVALS;
      }

      return data;
    } catch {
      return MOCK_ARRIVALS;
    } finally {
      clearTimeout(timeout);
    }
  }
}
