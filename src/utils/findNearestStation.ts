import stationsData from '../data/stations.json';
import { haversine } from './haversine';
import type { NearestStationResult, NearestStationsResult, Station } from '../types/station';

const stations = stationsData as Station[];

export function findNearestStation(
  lat: number,
  lng: number,
  maxDistanceKm?: number,
): NearestStationResult | null {
  let nearest: Station | null = null;
  let minDistance = Infinity;

  for (const station of stations) {
    const dist = haversine(lat, lng, station.lat, station.lng);
    if (dist < minDistance) {
      minDistance = dist;
      nearest = station;
    }
  }

  if (!nearest) return null;
  if (maxDistanceKm != null && minDistance > maxDistanceKm) return null;
  return { station: nearest, distanceKm: minDistance };
}

export function findNearestStations(
  lat: number,
  lng: number,
  maxDistanceKm?: number,
): NearestStationsResult | null {
  const result = findNearestStation(lat, lng, maxDistanceKm);
  if (!result) return null;

  const variants = stations.filter((s) => s.name === result.station.name);

  return {
    primary: result.station,
    variants,
    distanceKm: result.distanceKm,
    isTransfer: variants.length > 1,
  };
}
