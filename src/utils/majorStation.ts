import stationsData from '../data/stations.json';
import type { Station } from '../types/station';
import type { StationGroup } from './groupStationsByName';

const stations = stationsData as Station[];

// stations.json은 호선별로 상행 종점 → 하행 종점 순서대로 정렬되어 있다는 계약에 의존.
// 분기/루프 노선(1·2·5·6·경의중앙)의 일부 지선 종점은 누락될 수 있으나,
// 줌아웃 표시 후보 결정 용도이므로 정확도보다 안정성을 우선한다.
function buildEndpointIds(): Set<string> {
  const byLine = new Map<string, Station[]>();
  for (const s of stations) {
    let arr = byLine.get(s.line);
    if (!arr) {
      arr = [];
      byLine.set(s.line, arr);
    }
    arr.push(s);
  }
  const ids = new Set<string>();
  for (const arr of byLine.values()) {
    ids.add(arr[0].id);
    ids.add(arr[arr.length - 1].id);
  }
  return ids;
}

export const LINE_ENDPOINT_IDS: ReadonlySet<string> = buildEndpointIds();

// 줌아웃(latitudeDelta가 이 값보다 크면) 시 주요 역만 표시.
// 초기 region(0.05, 서울 시내 약 5km×5km)에서는 전체 노출이 자연스럽고,
// 그 이상으로 사용자가 의도적으로 축소했을 때만 잡음(2~3개 클러스터)을 제거.
export const MAJOR_ONLY_LATITUDE_DELTA = 0.08;

export function isMajorGroup(group: StationGroup): boolean {
  if (group.stations.length >= 2) return true;
  return group.stations.some((s) => LINE_ENDPOINT_IDS.has(s.id));
}
