import type { NearestStationResult } from '../../../shared/types/station';
import type { LineNumber } from '../../../shared/types/station';

/**
 * fusion 후보 역들에서 호선만 dedup해 추출. realtimePosition은 호선 단위 호출이라
 * 같은 호선의 후보가 여러 개여도 1번만 폴링하면 됨.
 *
 * 입력 순서(거리 가까운 → 먼)를 보존해 활성 호선 우선순위가 자연스럽게 GPS 거리로 정렬됨.
 */
export function findActiveLines(candidates: NearestStationResult[]): LineNumber[] {
  const seen = new Set<LineNumber>();
  const out: LineNumber[] = [];
  for (const c of candidates) {
    const line = c.station.line;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}
