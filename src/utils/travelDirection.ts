import type { LineNumber } from '../types/station';
import type { TravelDirection } from '../types/exitSide';
import { getStationsOnLine, normalizeStationName } from './stationRoute';

// stations.json이 단조(상행 종점 → 하행 종점)로 정렬된 노선만 인덱스 비교로 방향을 결정한다.
// 다음 노선들은 단조 배열로 표현이 불가능해 false direction 위험이 있다 — 명시적으로 제외:
//   - 1호선: 다중 종착/지선(병점·신창·광운대 등)
//   - 2호선: 순환선 (내선/외선 개념, up/down 단일 축 부족)
//   - 5호선: 답십리 이후 마천/상일동 분기
//   - 6호선: 응암 루프
//   - 경의중앙선: 다중 갈래 (DMC-운천 / 문산 / 지평)
// 위 노선들은 좌/우 안내를 생략한다. inner/outer/지선 표현은 별도 모델링이 결정된 뒤 확장.
const MONOTONIC_LINES = new Set<LineNumber>([
  '3', '4', '7', '8', '9', 'airport', 'bundang', 'sinbundang',
]);

export function resolveTravelDirection(
  line: LineNumber,
  fromName: string,
  toName: string,
): TravelDirection | null {
  if (!MONOTONIC_LINES.has(line)) return null;
  const stations = getStationsOnLine(line);
  if (stations.length === 0) return null;
  const fromIdx = indexOf(stations, fromName);
  const toIdx = indexOf(stations, toName);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return null;
  return toIdx < fromIdx ? 'up' : 'down';
}

function indexOf(stations: ReadonlyArray<{ name: string }>, name: string): number {
  const exact = stations.findIndex((s) => s.name === name);
  if (exact !== -1) return exact;
  // 노선별 표기 차이를 흡수 (예: "상봉(시외버스터미널)" vs "상봉")
  const normalized = normalizeStationName(name);
  return stations.findIndex((s) => normalizeStationName(s.name) === normalized);
}
