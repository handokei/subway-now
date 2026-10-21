/**
 * #3155 — 앵커역 출발 열차 조회 client (red 단계 스텁).
 */

export interface AnchorDepartureWireRow {
  trainCode: string;
  departedAt: number;
  currentStation: string | null;
}

export interface AnchorDeparturesView {
  station: string;
  line: string;
  departed: AnchorDepartureWireRow[];
}

export async function fetchAnchorDepartures(
  _tripToken: string,
  _baseUrl: string,
  _fetchImpl: typeof fetch = fetch,
): Promise<AnchorDeparturesView | null> {
  return null;
}
