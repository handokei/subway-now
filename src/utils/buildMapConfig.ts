import type { Station } from '../types/station';

export interface MapConfig {
  userLat: number;
  userLng: number;
  stations: (Station & { isNearest: boolean })[];
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
  return {
    userLat,
    userLng,
    stations: nearbyStations.map((s) => ({
      ...s,
      isNearest: nearestStation?.id === s.id,
    })),
  };
}
