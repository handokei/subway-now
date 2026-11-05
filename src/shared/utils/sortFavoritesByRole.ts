import type { FavoriteEntry, FavoriteRole } from '../types/station';

const FAVORITE_ROLE_ORDER: Record<FavoriteRole, number> = { home: 0, work: 1, general: 2 };

/** 즐겨찾기를 home → work → general 순으로 정렬한 새 배열을 반환한다 (원본 불변). */
export function sortFavoritesByRole(favorites: readonly FavoriteEntry[]): FavoriteEntry[] {
  return [...favorites].sort((a, b) => FAVORITE_ROLE_ORDER[a.role] - FAVORITE_ROLE_ORDER[b.role]);
}
