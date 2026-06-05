import type { LinePositions, FetchPositionOptions } from '../api/positionApi';
import type { LineNumber } from '../../../shared/types/station';

/** 호선 단위 실시간 열차위치 조회 — Phase 3. */
export interface PositionProvider {
  getPositions(line: LineNumber, options?: FetchPositionOptions): Promise<LinePositions>;
}
