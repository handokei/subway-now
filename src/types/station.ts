export type LineNumber =
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'airport'
  | 'gyeongui'
  | 'bundang'
  | 'sinbundang';

export interface Station {
  id: string;
  name: string;
  nameEn?: string;
  nameJa?: string;
  nameHanja?: string;
  line: LineNumber;
  lineColor: string;
  lat: number;
  lng: number;
}

export type FavoriteRole = 'home' | 'work' | 'general';

export const FAVORITE_SLOT_ROLES = ['home', 'work'] as const;
export type FavoriteSlotRole = (typeof FAVORITE_SLOT_ROLES)[number];

export const FAVORITE_SLOT_ICONS: Record<FavoriteSlotRole, string> = {
  home: '🏠',
  work: '🏢',
};

export function isFavoriteSlotRole(role: FavoriteRole): role is FavoriteSlotRole {
  return (FAVORITE_SLOT_ROLES as readonly FavoriteRole[]).includes(role);
}

export interface FavoriteEntry {
  station: Station;
  role: FavoriteRole;
  label?: string;
}

export interface NearestStationResult {
  station: Station;
  distanceKm: number;
}

export interface NearestStationsResult {
  primary: Station;
  variants: Station[];
  distanceKm: number;
  isTransfer: boolean;
}
