import type { Station } from '../types/station';
import { groupStationsByName, type StationGroup } from './groupStationsByName';

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
