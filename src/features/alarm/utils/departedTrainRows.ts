/**
 * #3155 — backend 출발 열차 → 목록 행 변환 (red 단계 스텁).
 */
import type { ArrivalInfo } from '../../../shared/types/arrival';
import type { LineNumber } from '../../../shared/types/station';
import type { AnchorDeparturesView } from '../api/anchorDepartures';

export interface DepartedTrainRow {
  train: ArrivalInfo;
  departedAtMs: number;
  currentStation: string | null;
}

export function buildDepartedTrainRows(
  _view: AnchorDeparturesView | null,
  _slot: { stationName: string; line: LineNumber },
  _nowMs: number,
): DepartedTrainRow[] {
  return [];
}
