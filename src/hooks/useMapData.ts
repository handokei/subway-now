import { useMemo } from 'react';
import stationsData from '../data/stations.json';
import { haversine } from '../utils/haversine';
import { Station } from '../shared/types/station';

const stations = stationsData as Station[];

export function useMapData(
  userLat: number | null,
  userLng: number | null,
  radiusKm = 1.0
): { nearbyStations: Station[] } {
  const nearbyStations = useMemo(() => {
    if (userLat === null || userLng === null) return [];
    return stations.filter(
      (s) => haversine(userLat, userLng, s.lat, s.lng) <= radiusKm
    );
  }, [userLat, userLng, radiusKm]);

  return { nearbyStations };
}
