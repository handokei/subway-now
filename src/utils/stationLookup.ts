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
