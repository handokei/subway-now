import { readStoredRoute } from '../../../shared/utils/storedRoute';
import type { Route } from '../../../shared/utils/stationRoute';
import { logStoredRouteMigrationFailed } from './alarmLog';

/**
 * #3177 — 저장 경로 공용 파서(shared, features 비의존)에 alarmLog 계측을 붙인 호출부 헬퍼.
 * 위치 task·안전망 재예약·안전망 재검증이 같은 처리를 하므로 한 곳에 둔다.
 */
export function readStoredRouteLogged(routeRaw: string | null, destinationRaw: string | null): Route {
  const { route, migrationFailedName } = readStoredRoute(routeRaw, destinationRaw);
  if (migrationFailedName !== undefined) logStoredRouteMigrationFailed(migrationFailedName);
  return route;
}
