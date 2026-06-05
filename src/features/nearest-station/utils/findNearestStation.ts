import stationsData from '../../../data/stations.json';
import { haversine } from '../../../utils/haversine';
import type { NearestStationResult, NearestStationsResult, Station } from '../../../shared/types/station';

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

/**
 * 사용자 좌표 기준 거리순 상위 N개 역(이름 중복 제거 — 환승역은 한 번만).
 * fusion 후보 추출에 사용. 거리 기준이지 노선 기준이 아니다.
 */
export function findTopNearestStations(
  lat: number,
  lng: number,
  limit: number,
  maxDistanceKm?: number,
): NearestStationResult[] {
  if (limit <= 0) return [];
  const ranked = stations
    .map((s) => ({ station: s, distanceKm: haversine(lat, lng, s.lat, s.lng) }))
    .filter((r) => maxDistanceKm == null || r.distanceKm <= maxDistanceKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const seen = new Set<string>();
  const out: NearestStationResult[] = [];
  for (const r of ranked) {
    if (seen.has(r.station.name)) continue;
    seen.add(r.station.name);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}
