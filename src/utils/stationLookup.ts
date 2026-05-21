import stationsData from '../data/stations.json';
import type { LineNumber, Station } from '../types/station';

const stations = stationsData as Station[];

/**
 * 역명으로 첫 매칭되는 호선을 반환한다.
 * 환승역의 경우 stations.json 등록 순서상 첫 호선이 반환된다 — schedule fallback은
 * trip 전 화면에서만 의미가 있으므로 단일 호선 기준 표시로 충분하다.
 */
export function findLineByStationName(name: string): LineNumber | null {
  const match = stations.find((s) => s.name === name);
  return match ? match.line : null;
}

/**
 * 역명으로 첫 매칭되는 Station(좌표 포함)을 반환한다.
 * 환승역은 호선별 lat/lng가 동일하므로 첫 매칭으로 충분하다.
 * silent push 위치 게이트(#478)에서 사용.
 */
export function findStationByName(name: string): Station | null {
  return stations.find((s) => s.name === name) ?? null;
}
