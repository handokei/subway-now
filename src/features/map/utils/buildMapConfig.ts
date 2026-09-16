/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import type { Station } from '../../../shared/types/station';
import { groupStationsByName, type StationGroup } from '../../nearest-station/utils/groupStationsByName';

export interface MapStationGroup extends StationGroup {
  isNearest: boolean;
}

export interface MapConfig {
  userLat: number;
  userLng: number;
  groups: MapStationGroup[];
}

export function buildMapConfig({
  userLat,
  userLng,
  nearestStation,
  nearbyStations,
}: {
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
}): MapConfig {
  const groups = groupStationsByName(nearbyStations).map((g) => ({
    ...g,
    isNearest: nearestStation ? g.stations.some((s) => s.id === nearestStation.id) : false,
  }));
  return { userLat, userLng, groups };
}
