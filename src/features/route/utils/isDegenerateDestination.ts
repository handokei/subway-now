import { Station } from '../../../shared/types/station';

/**
 * #1324 — 목적지가 출발역과 같으면 degenerate trip(0-waypoint → 방향 null → 빈 탑승목록 →
 * skip-cycle)이 생성된다. 사가정 trip 사고. 목적지 지정 경계(DestinationPicker.onSelect /
 * useDestinationStore.setDestination)에서 이 술어로 차단한다.
 *
 * `origin`이 null(아직 현재역 미확정)이면 비교 불가 → false(통과). 동일 역 판정은
 * stations.json의 안정적 `id` 기준 — 표시명/노선 표기 차이에 영향받지 않는다.
 */
export function isDegenerateDestination(
  origin: Station | null | undefined,
  destination: Station,
): boolean {
  return origin != null && origin.id === destination.id;
}
