/* eslint-disable import/no-restricted-paths --
 * 노선도 node → 대표 역 선택은 지도 마커(StationMap)와 같은 규칙(groupStationsByName)을 써야
 * 두 모드의 하단 카드가 같은 역으로 뜬다. MapSearchBar와 동일하게 nearest-station util을 직접 import한다.
 */
import type { Station } from '../../../shared/types/station';
import { groupStationsByName } from '../../nearest-station/utils/groupStationsByName';

/** #3371 — node.stationIds 중 대표 역(지도 모드 마커와 동일 규칙: 노선 순서 첫 역). 매칭 0건이면 null. */
export function pickNodeStation(stationIds: readonly string[], stations: readonly Station[]): Station | null {
  const idSet = new Set(stationIds);
  const members = stations.filter((s) => idSet.has(s.id));
  const [group] = groupStationsByName(members);
  if (!group) return null;
  const [representative] = group.stations;
  return representative;
}
