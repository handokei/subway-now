import stationsData from '../data/stations.json';
import type { Station } from '../types/station';
import { haversine } from './haversine';

export interface TransferStationGroup {
  name: string;
  variants: Station[];
}

export interface EnumerateTransferStationsOptions {
  maxPairDistanceKm?: number;
}

const ALL_STATIONS = stationsData as Station[];

const DEFAULT_MAX_PAIR_DISTANCE_KM = 1.0;

/**
 * 같은 이름을 공유하는 다른 노선 station을 환승역 단위로 묶어 반환.
 * #662/#663/#664 회귀 가드 데이터 주도 테스트 인프라 (#671).
 *
 * `maxPairDistanceKm`(기본 1.0km): variants 중 어느 한 쌍이라도 이 거리를 넘으면 동명이역으로 보고 그룹 제외.
 * 예) "양평"은 서울 5호선 ↔ 경기 경의중앙선 53km 떨어져 환승역 아님.
 */
export function enumerateTransferStations(
  stations: Station[] = ALL_STATIONS,
  options: EnumerateTransferStationsOptions = {},
): TransferStationGroup[] {
  const maxPairDistanceKm = options.maxPairDistanceKm ?? DEFAULT_MAX_PAIR_DISTANCE_KM;
  const byName = new Map<string, Station[]>();
  for (const station of stations) {
    const variants = byName.get(station.name);
    if (variants) {
      variants.push(station);
    } else {
      byName.set(station.name, [station]);
    }
  }
  const groups: TransferStationGroup[] = [];
  for (const [name, variants] of byName) {
    if (variants.length < 2) continue;
    if (!variantsWithinDistance(variants, maxPairDistanceKm)) continue;
    groups.push({ name, variants });
  }
  return groups;
}

function variantsWithinDistance(variants: Station[], maxKm: number): boolean {
  for (let i = 0; i < variants.length; i += 1) {
    for (let j = i + 1; j < variants.length; j += 1) {
      const a = variants[i];
      const b = variants[j];
      if (haversine(a.lat, a.lng, b.lat, b.lng) > maxKm) return false;
    }
  }
  return true;
}
