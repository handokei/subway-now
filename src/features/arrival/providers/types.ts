import type { StationArrival } from '../api/arrivalApi';
import type { LineNumber } from '../../../shared/types/station';

export interface ArrivalOptions {
  timeoutMs?: number;
  maxPerDirection?: number;
  /**
   * 호출자가 이미 알고 있는 노선. schedule fallback에서 stationName으로 다시 lookup하는
   * 비용 + 환승역의 첫 매칭 부정확성을 회피하기 위한 힌트. realtime 성공 경로에는 영향 없음.
   */
  lineHint?: LineNumber;
}

export interface ArrivalProvider {
  getArrival(
    stationName: string,
    options?: ArrivalOptions,
  ): Promise<StationArrival>;
}
