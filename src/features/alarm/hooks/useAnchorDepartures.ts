/**
 * #3155 — 앵커역 출발 열차 polling hook (red 단계 스텁).
 */
import type { AnchorDeparturesView } from '../api/anchorDepartures';

export function useAnchorDepartures(_options: { enabled: boolean }): AnchorDeparturesView | null {
  return null;
}
