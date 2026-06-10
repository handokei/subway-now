import type { LineNumber } from '../../../shared/types/station';
import type {
  CongestionDirection,
  CongestionEntry,
} from '../../../shared/types/congestion';

/**
 * 시간대×역×방향 평균 혼잡도 lookup port.
 *
 * 입력 조건에 해당하는 entry가 없으면 `null` 반환 — caller가 fallback UI를 결정한다.
 * (PoC 단계: 미커버 노선/역/시간대가 많아 null 허용. 후속 PR에서 nearest-slot fallback 검토.)
 */
export interface CongestionProvider {
  getCongestion(
    stationName: string,
    line: LineNumber,
    direction: CongestionDirection,
    now: Date,
  ): CongestionEntry | null;
}
