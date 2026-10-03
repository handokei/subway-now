import type { LineNumber } from '../../../shared/types/station';
import type { CongestionDirection } from '../../../shared/types/congestion';
import { getStationsOnLine } from '../../../shared/utils/stationRoute';

/**
 * 현재역 → 다음역의 노선 내 station 순서를 비교해 진행 방향을 추론한다.
 *
 * stations.json은 각 노선을 상행(외선) → 하행(내선) 순서로 정렬한다고 가정.
 * 즉, 노선 배열의 index가 증가하는 방향이 `up`(상행/외선), 감소가 `down`(하행/내선).
 *
 * 서울 OD `OA-12928` 정의(`UPDN_LINE`: 0=상행, 1=하행, `INNER_OUTER`: 외선/내선)와 일치한다.
 *
 * - 입력값 누락이나 lookup 실패 시 `null` (UI는 미표시).
 * - 노선 내 동일 역(예: 환승역 케이스에서 같은 line 중복 없음 보장): null 처리.
 */
export function deriveCongestionDirection(
  line: LineNumber | null | undefined,
  currentName: string | null | undefined,
  nextStationName: string | null | undefined,
): CongestionDirection | null {
  if (!line || !currentName || !nextStationName) return null;
  const stations = getStationsOnLine(line);
  const currentIdx = stations.findIndex((s) => s.name === currentName);
  const nextIdx = stations.findIndex((s) => s.name === nextStationName);
  if (currentIdx < 0 || nextIdx < 0 || currentIdx === nextIdx) return null;
  return nextIdx > currentIdx ? 'up' : 'down';
}
