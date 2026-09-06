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
 * - `surface`: 지상 (KRRIC `지상구분=지상`, seoul CSV 층수 F prefix)
 * - `underground`: 지하 (KRRIC `지상구분=지하`, seoul CSV 층수 B prefix)
 * - `mixed`: 지상·지하 복합 승강장 (KRRIC 상행/하행 row가 서로 다름,
 *   또는 seoul CSV 층수 F+B 동시 표기). 한 역에서 같은 line의 두 방향이
 *   지상/지하로 분리된 경우. #1930 G1 audit 시점 기준 stations.json에 1건
 *   — `gyeongui-021` 가좌 (경의중앙선). KRRIC `krric-gyeongui-platform.csv`에서
 *   지하/지상 row 둘 다 가짐.
 * - `unknown`: 데이터 출처 매칭 실패 — 사용자 검수 대상. #1930 audit 시점 기준
 *   stations.json에 0건.
 *
 * 데이터 SSOT는 `src/data/stations.json` (총 533 entries: 528 운영 단위 역 +
 * 환승역의 line별 variant 5건. id는 unique — `validate-stations.js`가 id 중복
 * 시 error로 fail. 같은 line 내 name 중복은 warning만 발행).
 * 빌드 스크립트는 `scripts/build-station-environment.js` 참조.
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
   * `src/data/stations.json`의 모든 entry는 본 필드를 가진다 (CI assertion —
   * `scripts/validate-stations.js`가 ALLOWED_ENVIRONMENTS enum + 누락 검사, 추가로
   * `src/data/__tests__/stations.environment.test.ts`가 분포 + mixed 엔트리 정체 박제).
   *
   * 타입 정의에서는 선언적 옵셔널 — 인메모리 fixture/mock이 일일이 채울 필요
   * 없게 하여 surgical change 원칙을 보존한다. 실제 런타임에서는 stations.json
   * 데이터(`as Station[]` 캐스트)를 사용하므로 항상 존재한다.
   *
   * #1930 G1 결정: 옵셔널 유지. 사유 = (1) fixture mock 50+ 곳 동시 수정 회피
   * (surgical change 원칙 §4 보존). (2) CI 양단 assertion(validate-stations.js
   * 런타임 + stations.environment.test.ts data drift)으로 runtime 100% 보장 동등.
   * (3) `as Station[]` 캐스트 한 곳만 환경 보장 책임 — 외부 입력 가드 X.
   * 후속 G2~G4에서 fusion cascade가 environment를 직접 read할 때, stations.json
   * 데이터를 거쳐 가므로 본 옵셔널 정의는 안전.
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
