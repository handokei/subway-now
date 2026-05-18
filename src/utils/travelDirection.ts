import type { LineNumber } from '../types/station';
import type { TravelDirection } from '../types/exitSide';
import { getStationsOnLine, normalizeStationName } from './stationRoute';
import lineTopology from '../data/lineTopology.json';

// 단조(상행 종점 → 하행 종점)로 stations.json에 표현 가능한 노선만 인덱스 비교로 방향을 결정한다.
// 화이트리스트는 src/data/lineTopology.json 단일 출처에서 가져온다 — 데이터 수집 스크립트
// (scripts/fetch-exit-side.js)도 동일 JSON을 참조해 좌/우 라벨 채택 정책을 공유한다.
const MONOTONIC_LINES = new Set<LineNumber>(lineTopology.monotonicLines as LineNumber[]);

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
