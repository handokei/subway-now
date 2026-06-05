/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: trip-end 시점에 route(stations 시퀀스 재구성) + alarm(log 윈도우)
 * + telemetry(backend upload)를 한 곳에서 묶어 호출하는 trigger. route 슬라이스의
 * `computeRouteArc`를 직접 참조하는 것이 본질이므로 file-level disable로 옵트인 처리.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * Trip 종료 시 매역 알림 recall KPI 1건을 backend `/telemetry/recall`로 upload하는 trigger (#919).
 *
 * 호출자 (두 경로):
 *  1. silent push `trip-ended` BG handler — backend가 trip을 자동 종료할 때.
 *  2. FG `useDestinationStore.setDestination(null)` — 사용자가 destination 직접 클리어할 때.
 *
 * 두 경로 모두 `runTripBoundCleanups` *이전* 에 호출되어야 한다. cleanup이 `ROUTE_KEY` /
 * `DESTINATION_KEY` / `TRIP_ORIGIN_KEY` / `TRIP_STARTED_AT_KEY`를 제거하므로 trigger가
 * 그 뒤에 돌면 recall 입력이 비어 자동 skip ('empty')된다.
 *
 * Idempotency (P2-2):
 *  - 같은 `tripStart`로 두 번 호출되면 두 번째는 `LAST_UPLOADED_RECALL_TRIP_START_KEY`
 *    비교로 skip한다. silent push trip-ended 직후 FG 복귀 시 useStateRehydration이
 *    `setDestination(null)`을 다시 호출하는 race 경로(#899 sentinel)에서 중복 upload 차단.
 *
 * 동작 변경 없음 — 순수 측정. routeStops 미구성 / tripStart 부재 / backend 실패 모두
 * 호출자 흐름 차단 없이 graceful skip.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DESTINATION_KEY,
  ROUTE_KEY,
  TRIP_ORIGIN_KEY,
  LAST_UPLOADED_RECALL_TRIP_START_KEY,
} from '../../../shared/constants/storageKeys';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { computeRouteArc } from '../../route/utils/routeProgress';
import { computeAndUploadTripRecall } from './alarmLogTelemetry';
import { getTripStartedAt } from './tripStartStorage';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('triggerTripEndRecall');

export type TriggerTripEndRecallSkipReason =
  | 'no-trip-start'
  | 'no-route'
  | 'no-destination'
  | 'no-origin'
  | 'route-arc-failed'
  | 'duplicate'
  | 'error';

export interface TriggerTripEndRecallResult {
  uploaded: boolean;
  skipped?: TriggerTripEndRecallSkipReason;
}

/**
 * Trip-end recall trigger. 호출자(`trip-ended` silent push handler / FG setDestination(null))는
 * 이 함수를 fire-and-forget으로 호출한 뒤 `runTripBoundCleanups`로 storage를 정리한다.
 *
 * 절대 throw 하지 않는다 — 호출자 흐름(cleanup, route reset)의 critical path를
 * 측정 인프라가 차단하면 안 된다.
 */
export async function triggerTripEndRecall(): Promise<TriggerTripEndRecallResult> {
  try {
    const tripStart = await getTripStartedAt();
    if (tripStart === null) {
      return { uploaded: false, skipped: 'no-trip-start' };
    }

    // Idempotency 가드 (P2-2). silent push trip-ended → FG 복귀 → useStateRehydration의
    // setDestination(null) 재호출 같은 race에서도 중복 upload 차단.
    const lastUploadedRaw = await AsyncStorage.getItem(LAST_UPLOADED_RECALL_TRIP_START_KEY);
    if (lastUploadedRaw !== null && Number(lastUploadedRaw) === tripStart) {
      log.info(`duplicate trip-end recall skip: tripStart=${tripStart}`);
      return { uploaded: false, skipped: 'duplicate' };
    }

    const routeStops = await loadRouteStops();
    if (routeStops === null) {
      return { uploaded: false, skipped: 'route-arc-failed' };
    }

    const result = await computeAndUploadTripRecall({
      routeStops,
      tripStart,
    });

    if (result.uploaded) {
      // tripStart를 idempotency 키로 기록. 다음 trip 시작 시 tripBoundCleanups에서 제거되므로
      // 새 trip은 다시 upload 가능.
      await AsyncStorage.setItem(LAST_UPLOADED_RECALL_TRIP_START_KEY, String(tripStart));
    }

    return { uploaded: result.uploaded };
  } catch (e) {
    log.warn('trigger error', e);
    return { uploaded: false, skipped: 'error' };
  }
}

/**
 * AsyncStorage의 route/origin/destination를 읽어 ordered station name 시퀀스를 만든다.
 * 하나라도 누락 / parse 실패 / arc 계산 실패 시 null — caller가 graceful skip.
 *
 * origin은 TRIP_ORIGIN_KEY(#700 — destination set 시점에 캡처된 진짜 출발역)를 사용한다.
 * customOrigin은 GPS와 별개라 trip 시작 시점의 진짜 출발 지점을 보장하지 못한다.
 */
async function loadRouteStops(): Promise<string[] | null> {
  const [routeRaw, originRaw, destinationRaw] = await Promise.all([
    AsyncStorage.getItem(ROUTE_KEY),
    AsyncStorage.getItem(TRIP_ORIGIN_KEY),
    AsyncStorage.getItem(DESTINATION_KEY),
  ]);
  if (!routeRaw || !originRaw || !destinationRaw) return null;

  let route: Route;
  let origin: Station;
  let destination: Station;
  try {
    route = JSON.parse(routeRaw) as Route;
    origin = JSON.parse(originRaw) as Station;
    destination = JSON.parse(destinationRaw) as Station;
  } catch {
    return null;
  }

  const arc = computeRouteArc(route, origin, destination);
  if (!arc) return null;
  return arc.stations.map((s) => s.name);
}
