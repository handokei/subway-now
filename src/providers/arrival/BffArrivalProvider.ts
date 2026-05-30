import type { ArrivalProvider, ArrivalOptions } from '../types';
import type { StationArrival } from '../../api/arrivalApi';
import { getFallbackArrival } from '../../api/arrivalApi';

export class BffArrivalProvider implements ArrivalProvider {
  constructor(private readonly baseUrl: string) {}

  async getArrival(
    stationName: string,
    options?: ArrivalOptions,
  ): Promise<StationArrival> {
    const { timeoutMs = 5000, maxPerDirection = 2, lineHint } = options ?? {};

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `${this.baseUrl}/api/arrival/${encodeURIComponent(stationName)}?maxPerDirection=${maxPerDirection}`;
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        return getFallbackArrival(stationName, `bff_http_${response.status}`, lineHint);
      }

      const data: StationArrival = await response.json();

      if (data.up.length === 0 && data.down.length === 0) {
        return getFallbackArrival(stationName, 'bff_empty_response', lineHint);
      }

      // BFF 계약: 모든 row가 line을 채워 응답해야 한다 (#663 - boardingLine 정확도 보장).
      // 구버전 BFF가 line 누락된 응답을 내려보내면 client lock이 잘못 저장되므로 schedule fallback으로 보호.
      const hasMissingLine = [...data.up, ...data.down].some((r) => !r.line);
      if (hasMissingLine) {
        return getFallbackArrival(stationName, 'bff_missing_line', lineHint);
      }

      return { ...data, source: data.source ?? 'realtime' };
    } catch {
      return getFallbackArrival(stationName, 'bff_fetch_error', lineHint);
    } finally {
      clearTimeout(timeout);
    }
  }
}
