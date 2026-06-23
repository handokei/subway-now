import type { LineNumber } from '../../../shared/types/station';
import type { TravelDirection } from '../../../shared/types/exitSide';
import { getStationsOnLine, normalizeStationName } from '../../../shared/utils/stationRoute';
import lineTopology from '../../../data/lineTopology.json';

// 비단조 노선 방향 추론. `MONOTONIC_LINES` 화이트리스트(`travelDirection.ts`)에 들어가지 못하는
// 노선을 보완한다. 토폴로지 SSOT는 `lineTopology.json`의 `closedLoops`.
//
// 모델:
//   - **순환선 (2호선)**: `mainIdRange`만 있는 진짜 closed loop. forward/backward 호 중 짧은
//     쪽을 채택. 지선(2-105/2-205)은 main range 밖이라 자동 배제.
//   - **Hybrid 노선 (6호선 응암 루프)**: `loopTailRange`가 있는 P자 노선. 루프 꼬리는 단방향
//     운행(응암→역촌→...→새절)이라 wrap이 의미 없음 — 모든 from/to 쌍을 단순 id 단조 비교로
//     처리한다(id 증가=down, 감소=up). 합정(6-013)→공덕(6-017)=down / 합정→망원(6-012)=up /
//     응암(6-001)→연신내(6-005)=down / 새절(6-007)→증산(6-008)=down 등 acceptance 케이스
//     (#1703)를 모두 자연스럽게 만족한다.
//
// 본 util은 `boardingPromptContext.ts`와 `alarmDirection.ts`에서 `resolveTravelDirection` null
// 시 fallback으로 호출된다.

interface ClosedLoopMeta {
  mainIdRange: { firstId: string; lastId: string };
  /** 있으면 hybrid 노선(P자 + 단방향 꼬리). 없으면 진짜 순환선. */
  loopTailRange?: { firstId: string; lastId: string };
}

const CLOSED_LOOPS = lineTopology.closedLoops as Partial<Record<LineNumber, ClosedLoopMeta>>;

/**
 * 순환/하이브리드 노선의 from → to 방향을 추론한다.
 * - 'up'   = id 감소 방향 (순환선의 경우 내선순환 = wrap 짧음)
 * - 'down' = id 증가 방향 (순환선의 경우 외선순환 = forward 짧음)
 * - null   = 추론 불가 (대상 노선 아님, 동일 역, 지선, 정반대 위치 등)
 */
export function inferLoopDirection(
  line: LineNumber,
  fromName: string,
  toName: string,
): TravelDirection | null {
  const meta = CLOSED_LOOPS[line];
  if (!meta) return null;

  const stations = getStationsOnLine(line);
  if (stations.length === 0) return null;

  // 메인 운행 구간만 추출(지선 배제). id 오름차순은 stations.json 기준.
  const { firstId, lastId } = meta.mainIdRange;
  const main = stations.filter((s) => s.id >= firstId && s.id <= lastId);
  if (main.length < 2) return null;

  const fromIdx = indexOf(main, fromName);
  const toIdx = indexOf(main, toName);
  if (fromIdx === -1 || toIdx === -1) return null;
  if (fromIdx === toIdx) return null;

  // Hybrid 노선(6호선)은 단방향 꼬리 때문에 wrap 비교가 무의미 — 단순 id 단조 비교.
  if (meta.loopTailRange) {
    return toIdx > fromIdx ? 'down' : 'up';
  }

  // 진짜 순환선(2호선): forward/backward 호 길이 비교.
  const n = main.length;
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
