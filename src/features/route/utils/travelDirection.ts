import type { LineNumber, Station } from '../../../shared/types/station';
import type { TravelDirection } from '../types/exitSide';
import { getStationsOnLine, normalizeStationName } from './stationRoute';
import lineTopology from '../../../data/lineTopology.json';

// 단조(상행 종점 → 하행 종점)로 stations.json에 표현 가능한 노선만 인덱스 비교로 방향을 결정한다.
// 화이트리스트는 src/data/lineTopology.json 단일 출처에서 가져온다 — 데이터 수집 스크립트
// (scripts/fetch-exit-side.js)도 동일 JSON을 참조해 좌/우 라벨 채택 정책을 공유한다.
const MONOTONIC_LINES = new Set<LineNumber>(lineTopology.monotonicLines as LineNumber[]);

// #788: 노선별 운영 종점명(transferExit.fromTerminal과 정렬). stations.json은 신규 연장
// (석남/진접/별내/중앙보훈병원 등)을 미반영하므로 endpoints는 lineTopology.json 단일 출처.
// Partial<Record<LineNumber, ...>>로 좁혀 잘못된 노선명 lookup을 컴파일타임에 잡는다.
const ENDPOINTS = lineTopology.endpoints as Partial<Record<LineNumber, { low: string; high: string }>>;

export interface TravelResolution {
  direction: TravelDirection;
  fromStation: Station;
  toStation: Station;
}

// 방향과 함께 출/도착역 객체를 같이 반환한다 — caller가 별도 lookup으로 정합성을 깨지 않게.
// 단조 화이트리스트에 없는 노선이거나 둘 중 하나라도 매칭 실패면 null.
export function resolveTravelDirection(
  line: LineNumber,
  fromName: string,
  toName: string,
): TravelResolution | null {
  if (!MONOTONIC_LINES.has(line)) return null;
  const stations = getStationsOnLine(line);
  if (stations.length === 0) return null;
  const fromIdx = indexOf(stations, fromName);
  const toIdx = indexOf(stations, toName);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return null;
  return {
    direction: toIdx < fromIdx ? 'up' : 'down',
    fromStation: stations[fromIdx],
    toStation: stations[toIdx],
  };
}

/**
 * 단조 노선에서 fromName → toName의 진행 방면 종착역 운영명을 반환한다(#788).
 * `resolveTransferDoor`의 `fromTerminal` 인자로 전달해 같은 환승역의 양 방향 row를 구별.
 *
 * - 단조 노선(`lineTopology.monotonicLines`)만 결정 가능. 그 외는 null.
 * - 진행 방향(low/high)은 stations.json의 id 정렬을 기준 — id가 증가하는 방향이 high.
 * - 운영 종점명은 lineTopology.endpoints에서 lookup (stations.json과 다를 수 있음 — 예: 7호선 high=석남).
 * - endpoints에 매핑이 없거나 from/to가 같으면 null.
 */
export function resolveProgressingTerminal(
  line: LineNumber,
  fromName: string,
  toName: string,
): string | null {
  const resolution = resolveTravelDirection(line, fromName, toName);
  if (!resolution) return null;
  const endpoints = ENDPOINTS[line];
  /* istanbul ignore next -- lineTopology.json invariant: 모든 monotonicLines가 endpoints에 등록. 추가 노선 도입 시 가드 */
  if (!endpoints) return null;
  return resolution.direction === 'up' ? endpoints.low : endpoints.high;
}

function indexOf(stations: ReadonlyArray<Station>, name: string): number {
  const exact = stations.findIndex((s) => s.name === name);
  if (exact !== -1) return exact;
  // 노선별 표기 차이를 흡수 (예: "상봉(시외버스터미널)" vs "상봉")
  const normalized = normalizeStationName(name);
  return stations.findIndex((s) => normalizeStationName(s.name) === normalized);
}
