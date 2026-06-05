import stationsData from '../../../data/stations.json';
import type { LineNumber, Station } from '../../../shared/types/station';

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

/**
 * 역명 + 노선 정확 매칭 Station 반환 (#707).
 * 환승역(예: 강남=line 2 & sinbundang)에서 실제 탑승 중인 노선의 stop id를 가져올 때 사용.
 *
 * 용도:
 *  - BoardingLock 생성 시 boardingStationId가 train.line 기준 station id가 되도록 정정.
 *  - silent push 게이트에서 nextWaypoint가 lock.boardingLine에 정차하는지 line-mismatch 가드.
 *
 * 매칭 실패(역명 없음 또는 해당 line에 정차 안 함) 시 null.
 */
export function findStationByNameAndLine(name: string, line: LineNumber): Station | null {
  return stations.find((s) => s.name === name && s.line === line) ?? null;
}
