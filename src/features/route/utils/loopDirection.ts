import type { LineNumber } from '../../../shared/types/station';
import type { TravelDirection } from '../../../shared/types/exitSide';
import { getStationsOnLine, normalizeStationName } from '../../../shared/utils/stationRoute';

// 비단조 노선(현재 2호선 순환선만) 방향 추론.
// monotonic 화이트리스트(`travelDirection.ts`)에 들어가지 못하는 노선을 보완한다.
//
// 2호선 순환선:
//   - 메인 루프(시청 ~ 충정로, stations.json id 2-001 ~ 2-043, 43개)는 순환선.
//   - 까치산(2-105) / 신설동(2-205)은 지선으로 본 추론 대상 외 → null.
//   - 진행 방향 결정: from → to까지 id 증가 방향으로 가는 호(arc)와
//     반대 방향(루프 wrap) 호 중 짧은 쪽을 선택.
//   - 증가 방향이 더 짧으면 외선순환 = 'down' (low→high 컨벤션 정렬)
//   - 감소 방향(wrap)이 더 짧으면 내선순환 = 'up'
//   - 두 호가 정확히 같은 길이(정반대 위치)면 ambiguous → null.
//
// 이 util은 호출부에 직접 wiring 되지 않는다(후속 PR). monotonic util과 분리 유지.

const LOOP_LINES = new Set<LineNumber>(['2']);

// 2호선 메인 루프 station id prefix. 지선(2-105, 2-205)을 배제.
const LINE2_LOOP_PREFIX = '2-0';

/**
 * 2호선 순환선의 from → to 방향을 추론한다.
 * - 'up'   = 내선순환 (id 감소 방향이 더 짧음)
 * - 'down' = 외선순환 (id 증가 방향이 더 짧음)
 * - null   = 추론 불가 (지선 포함, 동일 역, 정반대 위치 등)
 */
export function inferLoopDirection(
  line: LineNumber,
  fromName: string,
  toName: string,
): TravelDirection | null {
  if (!LOOP_LINES.has(line)) return null;
  const stations = getStationsOnLine(line);
  if (stations.length === 0) return null;

  // 메인 루프만 추출(지선 제외). id 오름차순 정렬은 stations.json 기준 유지.
  const loop = stations.filter((s) => s.id.startsWith(LINE2_LOOP_PREFIX));
  if (loop.length < 2) return null;

  const fromIdx = indexOf(loop, fromName);
  const toIdx = indexOf(loop, toName);
  if (fromIdx === -1 || toIdx === -1) return null;
  if (fromIdx === toIdx) return null;

  const n = loop.length;
  const forward = (toIdx - fromIdx + n) % n; // id 증가 방향 호 길이
  const backward = n - forward; // wrap 방향 호 길이

  if (forward === backward) return null; // 정반대 위치 — ambiguous
  return forward < backward ? 'down' : 'up';
}

/**
 * Seoul OpenAPI `trainLineNm` 텍스트에서 순환선 방향 토큰을 파싱한다.
 * - "내선순환" → 'up'
 * - "외선순환" → 'down'
 * - 그 외 → null
 *
 * 후속에서 inferLoopDirection의 fallback/검증용으로 활용.
 */
export function parseTrainLineDirection(trainLineNm: string): TravelDirection | null {
  if (trainLineNm.includes('내선순환')) return 'up';
  if (trainLineNm.includes('외선순환')) return 'down';
  return null;
}

function indexOf(stations: ReadonlyArray<{ name: string }>, name: string): number {
  const exact = stations.findIndex((s) => s.name === name);
  if (exact !== -1) return exact;
  const normalized = normalizeStationName(name);
  return stations.findIndex((s) => normalizeStationName(s.name) === normalized);
}
