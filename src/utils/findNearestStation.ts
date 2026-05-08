import stationsData from '../data/stations.json';
import { haversine } from './haversine';
import type { NearestStationResult, NearestStationsResult, Station } from '../types/station';

const stations = stationsData as Station[];

export function findNearestStation(lat: number, lng: number): NearestStationResult | null {
  let nearest: Station | null = null;
  let minDistance = Infinity;

  for (const station of stations) {
    const dist = haversine(lat, lng, station.lat, station.lng);
    if (dist < minDistance) {
      minDistance = dist;
      nearest = station;
    }
  }

  return nearest ? { station: nearest, distanceKm: minDistance } : null;
}

export function findNearestStations(lat: number, lng: number): NearestStationsResult | null {
  const result = findNearestStation(lat, lng);
  if (!result) return null;

  const variants = stations.filter((s) => s.name === result.station.name);

  return {
    primary: result.station,
    variants,
    distanceKm: result.distanceKm,
    isTransfer: variants.length > 1,
  };
}
