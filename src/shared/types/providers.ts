/**
 * Provider 인터페이스 type — useFusedNearestStation 같은 cross-feature orchestrator가
 * arrival/position provider type을 모두 type-import하므로 shared로 추출.
 *
 * ADR Roadmap Phase 5 (#890). 원본 위치는 features/<slice>/providers/types.ts (re-export 유지).
 */

import type { LineNumber } from './station';
import type { StationArrival } from './arrival';
import type { LinePositions } from './position';

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

export interface FetchPositionOptions {
  timeoutMs?: number;
  /** 0~limit 범위로 호출 (호선당 최대 1000건이지만 일반적으로 100 충분). */
  limit?: number;
}

/** 호선 단위 실시간 열차위치 조회 — Phase 3. */
export interface PositionProvider {
  getPositions(line: LineNumber, options?: FetchPositionOptions): Promise<LinePositions>;
}
