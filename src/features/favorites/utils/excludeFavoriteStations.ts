import type { FavoriteEntry, Station } from '../../../shared/types/station';

/** 즐겨찾기에 있는 역(station.id 동일)을 제외한 목록. 표시 전용 필터 — 입력/스토어는 변경하지 않는다. */
export function excludeFavoriteStations(stations: readonly Station[], favorites: readonly FavoriteEntry[]): Station[] {
  const favoriteIds = new Set(favorites.map(({ station }) => station.id));
  return stations.filter(({ id }) => !favoriteIds.has(id));
}
