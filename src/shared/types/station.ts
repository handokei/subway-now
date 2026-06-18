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

/**
 * 역 환경 (ADR-015 §1 Deterministic Environment SSOT).
 *
 * - `surface`: 지상 (CSV 층수 F prefix)
 * - `underground`: 지하 (CSV 층수 B prefix)
 * - `mixed`: 지상·지하 복합 (CSV 층수 F+B, 예: 동묘앞 5FB2)
 * - `unknown`: 데이터 출처 매칭 실패 — 사용자 검수 대상
 *
 * 데이터 SSOT는 `src/data/stations.json`. 빌드 스크립트는
 * `scripts/build-station-environment.js` 참조.
 */
export type StationEnvironment = 'surface' | 'underground' | 'mixed' | 'unknown';

export const STATION_ENVIRONMENTS = ['surface', 'underground', 'mixed', 'unknown'] as const;

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
  /**
   * ADR-015 §1 — Deterministic Environment SSOT.
   *
   * `src/data/stations.json`의 모든 entry는 본 필드를 가진다 (CI assertion).
   * 타입 정의에서는 선언적 옵셔널 — 인메모리 fixture/mock이 일일이 채울 필요
   * 없게 하여 surgical change 원칙을 보존한다. 실제 런타임에서는 stations.json
   * 데이터를 사용하므로 항상 존재한다.
   */
  environment?: StationEnvironment;
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
