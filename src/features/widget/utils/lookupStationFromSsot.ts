/**
 * #1935 — silent push payload + BG context에서 widget update용 Station/distance를 결정한다.
 *
 * 우선순위:
 *  1. payload `ssot.currentStationId` (backend가 4-tier fusion 결과를 forward한 권위 신호).
 *     `ssot.currentStationLine`이 있으면 line 정확 매칭(`findStationByNameAndLine`) —
 *     동명 환승역(합정 2/6호선 등) cross-line confusion 차단.
 *     SSoT 경로는 backend가 advance한 시점이므로 거리 신호는 0으로 stamp(역 도착).
 *  2. BG context (`BG_LAST_STATION_KEY` mirror) — Always 권한 사용자의
 *     `backgroundLocationTask`가 적재해 둔 마지막 GPS-derived station + distance.
 *     WhileInUse 사용자는 보통 비어 있다(BG task 미등록) → null로 떨어진다.
 *
 * 둘 다 결정 불가 → null (caller no-op, 위젯 마지막 정상 상태 유지).
 *
 * 본 helper는 expo-notifications / expo-task-manager / AsyncStorage 의존성이 없어
 * silent push handler / FG state freshness 호출자 양쪽 모두 import 가능하다.
 */

import { findStationByName, findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import type { LineNumber, Station } from '../../../shared/types/station';
import type { BgLastStationContext, SsotStationInput } from '../../../shared/types/widgetRefresh';

export type { BgLastStationContext, SsotStationInput };

export interface ResolvedWidgetStation {
  station: Station;
  distanceKm: number;
}

/**
 * SSoT → BG context 순으로 시도. 둘 다 결정 불가 시 null.
 */
export function lookupStationFromSsot(
  ssot: SsotStationInput | null | undefined,
  bgContext: BgLastStationContext | null,
): ResolvedWidgetStation | null {
  const fromSsot = resolveFromSsot(ssot);
  if (fromSsot) return fromSsot;
  if (bgContext) {
    return { station: bgContext.station, distanceKm: bgContext.distanceKm };
  }
  return null;
}

/**
 * SSoT field 우선. currentStationLine이 있으면 line 정확 매칭, 없으면 name-only fallback.
 * silent push가 backend advance 신호이므로 거리 신호는 0(역 도착).
 */
function resolveFromSsot(
  ssot: SsotStationInput | null | undefined,
): ResolvedWidgetStation | null {
  if (!ssot) return null;
  const station = ssot.currentStationLine
    ? findStationByNameAndLine(ssot.currentStationId, ssot.currentStationLine as LineNumber)
    : findStationByName(ssot.currentStationId);
  if (!station) return null;
  return { station, distanceKm: 0 };
}
