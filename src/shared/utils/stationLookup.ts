import stationsData from '../../data/stations.json';
import { applyStationAlias } from '../../data/stationAliases';
import type { LineNumber, Station } from '../types/station';
import { normalizeStationName } from './normalizeStationName';

const stations = stationsData as Station[];

/**
 * 노선별 표기 차이/개명/병기역명을 흡수한 canonical 비교 키.
 *   "자양(뚝섬한강공원)" → normalize → "자양" → alias → "자양"
 *   "뚝섬유원지" (옛 boardingLock) → normalize → "뚝섬유원지" → alias → "자양"
 * 두 경우가 같은 키로 떨어지므로 정확 매칭 외에 정규화 fallback이 가능하다.
 */
function canonicalKey(name: string): string {
  return applyStationAlias(normalizeStationName(name));
}

/**
 * 역명으로 첫 매칭되는 호선을 반환한다.
 * 환승역의 경우 stations.json 등록 순서상 첫 호선이 반환된다 — schedule fallback은
 * trip 전 화면에서만 의미가 있으므로 단일 호선 기준 표시로 충분하다.
 * #1397: stations.json이 정식 표기(예: "자양(뚝섬한강공원)")를 가져도 옛 boardingLock
 * /favorites/widget의 base/옛 이름으로도 매칭되도록 canonical fallback을 적용.
 */
export function findLineByStationName(name: string): LineNumber | null {
  const exact = stations.find((s) => s.name === name);
  if (exact) return exact.line;
  const key = canonicalKey(name);
  const fallback = stations.find((s) => canonicalKey(s.name) === key);
  return fallback ? fallback.line : null;
}

/**
 * 역명으로 첫 매칭되는 Station(좌표 포함)을 반환한다.
 * 환승역은 호선별 lat/lng가 동일하므로 첫 매칭으로 충분하다.
 * silent push 위치 게이트(#478)에서 사용.
 * #1397: findLineByStationName과 동일한 canonical fallback 적용.
 */
export function findStationByName(name: string): Station | null {
  const exact = stations.find((s) => s.name === name);
  if (exact) return exact;
  const key = canonicalKey(name);
  return stations.find((s) => canonicalKey(s.name) === key) ?? null;
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
 *
 * #1405: findStationByName/findLineByStationName과 동일한 canonical fallback 적용.
 * 옛 boardingLock(예: stationName='뚝섬유원지', line=7)이 새 stations.json
 * ('자양(뚝섬한강공원)', line=7)과 정확 매칭 실패하는 lookup 일관성 부족 회귀 차단.
 */
export function findStationByNameAndLine(name: string, line: LineNumber): Station | null {
  const exact = stations.find((s) => s.name === name && s.line === line);
  if (exact) return exact;
  const key = canonicalKey(name);
  return stations.find((s) => canonicalKey(s.name) === key && s.line === line) ?? null;
}
