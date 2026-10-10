/**
 * #1935 — silent push 채널 widget refresh 시 alarm / widget 양쪽이 공유하는 입력 type.
 *
 * - `BgLastStationContext`: `BG_LAST_STATION_KEY` mirror shape. `backgroundLocationTask`가
 *   적재하고, silent push handler가 read해 widget update / LA refresh에 fallback으로 사용.
 *   (WhileInUse 사용자는 BG task 미등록이라 보통 null로 떨어진다.)
 * - `SsotStationInput`: silent push payload `ssot` 슬라이스에서 widget update가 필요한 narrow
 *   subset (currentStationId + 선택적 currentStationLine). 전체 `SilentPushSsotMirror`를
 *   import하면 alarm feature 의존이 widget에 생기므로 shape만 빌려온다.
 *
 * 두 type 모두 alarm slice의 storage write 형식과 1:1로 정렬돼 있다.
 */

import type { Station } from './station';

/**
 * `BG_LAST_STATION_KEY`에 적재된 형태. `backgroundLocationTask`가 write,
 * `refreshLiveActivityFromBackgroundContext` / widget update가 read.
 */
export interface BgLastStationContext {
  station: Station;
  distanceKm: number;
  timestamp: number;
}

/**
 * silent push payload `ssot` 슬라이스에서 widget station lookup이 필요한 두 필드.
 * 전체 SSoT mirror entry shape와 부분 호환 — currentStationLine은 #1705에서 추가되며
 * 부재 시 lookup은 name-only fallback.
 */
export interface SsotStationInput {
  currentStationId: string;
  currentStationLine?: string;
}
