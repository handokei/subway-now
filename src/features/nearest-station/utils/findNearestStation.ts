import stationsData from '../../../data/stations.json';
import { haversine } from '../../../shared/utils/haversine';
import type { LineNumber, NearestStationResult, NearestStationsResult, Station } from '../../../shared/types/station';

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
 *
 * #1436 — `allowedLines`가 주어지면 trip route에 포함된 노선의 entry만 후보로 통과시킨다.
 * 좌표는 같지만 이름이 다른 entry(예: `왕십리(성동구청)` vs `왕십리`)가 name dedup을 우회해
 * trip 외 노선이 fusion result로 흘러가던 회귀를 입구에서 차단한다. ADR-015 §5.
 * trip 비활성(undefined) 시 기존 동작 보존.
 */
export function findTopNearestStations(
  lat: number,
  lng: number,
  limit: number,
  maxDistanceKm?: number,
  allowedLines?: Set<LineNumber>,
): NearestStationResult[] {
  if (limit <= 0) return [];
  const ranked = stations
    .map((s) => ({ station: s, distanceKm: haversine(lat, lng, s.lat, s.lng) }))
    .filter((r) => maxDistanceKm == null || r.distanceKm <= maxDistanceKm)
    .filter((r) => allowedLines == null || allowedLines.has(r.station.line))
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
