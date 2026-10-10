/**
 * #1935 — silent push handler가 widget update 시 필요한 BG 컨텍스트(destination/route/bgStation)를
 * AsyncStorage에서 한 번에 읽어오는 단일 진입점.
 *
 * `refreshLiveActivityFromBackgroundContext`도 같은 storage 3개 키를 읽지만 그 내부 readers가
 * private이라 외부 caller(silent push handler)가 재사용할 수 없었다. 본 helper는 read-only
 * pure 변환 — silent push handler가 LA refresh와 widget update 양쪽에 동일한 컨텍스트를
 * 1회 read로 공급하도록 한다 (BG task 시간 예산 보호).
 *
 * 손상 / 부재 시 각 필드 null. caller no-op (`updateWidgetFromSilentPush`가 graceful skip).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BG_LAST_STATION_KEY,
  DESTINATION_KEY,
  ROUTE_KEY,
} from '../../../shared/constants/storageKeys';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import type { BgLastStationContext } from '../../../shared/types/widgetRefresh';

export interface WidgetRefreshContext {
  destination: Station | null;
  route: Route;
  bgContext: BgLastStationContext | null;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * destination: id 필드까지 narrow. id 부재 시 null (corrupt entry 자동 폐기).
 */
function parseDestination(raw: string | null): Station | null {
  const parsed = safeParse<Partial<Station>>(raw);
  if (!parsed || typeof parsed.id !== 'string') return null;
  return parsed as Station;
}

/**
 * BG_LAST_STATION_KEY 형식 narrow. `backgroundLocationTask`가 적재한 형태와 1:1
 * (`refreshLiveActivityFromBackgroundContext`의 `BgLastStation`과 동일 shape).
 *
 * - parsed가 null / 비-object / distanceKm 비-number / station 부재 → null.
 *
 * #2408 — useBoardingPromptResponder의 stale-prompt position guard도 동일 parse 로직이 필요해
 * export. 중복 구현 대신 이 단일 narrow 함수를 공유한다.
 */
export function parseBgLastStation(raw: string | null): BgLastStationContext | null {
  const parsed = safeParse<unknown>(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { distanceKm?: unknown }).distanceKm !== 'number' ||
    !(parsed as { station?: unknown }).station
  ) {
    return null;
  }
  return parsed as BgLastStationContext;
}

/**
 * silent push finally 블록에서 호출. read 실패는 swallow — silent push 본 흐름을 막지 않는다.
 * BG task 시간 예산 보호를 위해 3개 키를 병렬 read.
 */
export async function readWidgetRefreshContext(): Promise<WidgetRefreshContext> {
  try {
    const [destRaw, routeRaw, bgRaw] = await Promise.all([
      AsyncStorage.getItem(DESTINATION_KEY),
      AsyncStorage.getItem(ROUTE_KEY),
      AsyncStorage.getItem(BG_LAST_STATION_KEY),
    ]);
    return {
      destination: parseDestination(destRaw),
      route: safeParse<Route>(routeRaw),
      bgContext: parseBgLastStation(bgRaw),
    };
  } catch {
    return { destination: null, route: null, bgContext: null };
  }
}
