/* eslint-disable import/no-restricted-paths --
 * 마이그레이션 실패를 alarmLog(features/alarm)에 남기는 cross-feature 관측 연결.
 * useStateRehydration과 같은 방식의 옵트인이며, 파서 본체는 순수 함수다.
 */
import type { LineNumber } from '../types/station';
import { logStoredRouteMigrationFailed } from '../../features/alarm/utils/alarmLog';
import { findStationByNameAndLine } from './stationLookup';
import type { Route, TransferSegment } from './stationRoute';

/**
 * #3177 PR-2a — 저장 경로(ROUTE_KEY) 공용 파서 + stationId 마이그레이션.
 *
 * PR-1(#3179) 이전 빌드가 저장한 경로 JSON에는 `transferStationId` / `destinationStationId`가
 * 없다. 하차문 조회가 이름이 아닌 id로 바뀌므로, 놓침 경로(위치 task·안전망 재예약·안전망 재검증)가
 * 구버전 경로를 폐기(null)하지 않고 빠진 id만 채워 쓴다 (ADR-010 놓침 방지).
 *
 * - `transferStationId` = `findStationByNameAndLine(transferName, fromLine).id`
 * - `destinationStationId` = 저장된 목적지(DESTINATION_KEY) `Station.id`
 * - 이미 있는 id는 덮어쓰지 않는다. 환승역 조회가 실패하면 null + alarmLog `route-migration-failed`.
 *
 * 삭제 조건: id 없는 경로는 PR-1 이전 빌드의 트립 단위 데이터라 트립 종료/첫 화면 진입 시 사라진다.
 * PR-1이 포함된 릴리스의 다음 릴리스에서 이 마이그레이션 블록을 제거한다.
 */
export function readStoredRoute(routeRaw: string | null, destinationRaw: string | null): Route {
  if (!routeRaw) return null;
  let parsed: Route;
  try {
    parsed = JSON.parse(routeRaw) as Route;
  } catch {
    return null;
  }
  if (!parsed) return null;

  // 목적지 id를 못 구해도 경로는 폐기하지 않는다(필드는 optional) — 알람 놓침(ADR-010)이 더 나쁘고,
  // 정상 트립의 목적지는 항상 id를 갖는다. 환승역 id 조회 실패만 null로 취급한다.
  const destinationStationId = parsed.destinationStationId ?? readDestinationId(destinationRaw);
  const destinationFields = destinationStationId ? { destinationStationId } : {};

  if (parsed.type === 'direct') return { ...parsed, ...destinationFields };

  if (parsed.type === 'transfer') {
    const { transferName, fromLine, transferStationId } = parsed;
    const resolved = transferStationId ?? lookupStationId(transferName, fromLine);
    if (!resolved) return null;
    return { ...parsed, transferStationId: resolved, ...destinationFields };
  }

  const transfers: TransferSegment[] = [];
  for (const segment of parsed.transfers) {
    const { transferName, fromLine, transferStationId } = segment;
    const resolved = transferStationId ?? lookupStationId(transferName, fromLine);
    if (!resolved) return null;
    transfers.push({ ...segment, transferStationId: resolved });
  }
  return { ...parsed, transfers, ...destinationFields };
}

function lookupStationId(name: string, line: LineNumber): string | null {
  const found = findStationByNameAndLine(name, line);
  if (!found) {
    logStoredRouteMigrationFailed(name);
    return null;
  }
  return found.id;
}

function readDestinationId(destinationRaw: string | null): string | null {
  if (!destinationRaw) return null;
  try {
    const parsed = JSON.parse(destinationRaw) as { id?: unknown } | null;
    const id = parsed?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
