/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: silent push BG handler가 LA refresh에 필요한 stationNotification
 * builder + nearest-station/widget storage를 직접 조합한다. Phase 5 enforce 모드에서 file-level
 * disable로 옵트인 처리.
 */
/**
 * #900 Seam D — silent push 핸들러가 권한(Always/WhileInUse)과 무관하게 Live Activity를
 * 갱신하는 진입점.
 *
 * 기존 BG LA 갱신 경로는 `backgroundLocationTask` → `updateStationNotification`인데, 이건
 * `Location.requestBackgroundPermissionsAsync() === 'granted'`(Always)에서만 등록된다.
 * 사용자 다수가 WhileInUse라서 BG에서 client-side LA push는 0건이 된다.
 *
 * silent push는 권한에 무관하게 도달하므로, payload `kind`와 상관없이 모든 silent push가
 * AsyncStorage SSOT(`ROUTE_KEY` / `DESTINATION_KEY` / `BG_LAST_STATION_KEY` / `BACKEND_SSOT_MIRROR_KEY`)
 * 를 읽어 LA를 재계산해 한 번 발사한다.
 *
 *   - destination 없음 → trip 종료 의미 → `endLiveActivity` 호출
 *   - currentStation 결정 순서 (#2589 — 확정 아키텍처: backend추적 → LA 표시 SSoT):
 *     1. backend SSoT mirror (fresh ≤180s, 역↔노선 정합 가드 경유) — GPS 사망 상태에서도 우선
 *     2. BG_LAST_STATION(GPS) — mirror 부재/stale 시 폴백
 *     3. 없음 → no-op (안전: 기존 LA 마지막 정상 상태 유지)
 *   - 그 외 → `buildLiveActivityData` → `updateLiveActivity`
 *
 * zustand store는 BG에서 접근 불가하므로 AsyncStorage만 사용한다. iOS 외 플랫폼은 native
 * Live Activity가 없으므로 graceful no-op.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as LiveActivity from 'live-activity';
import {
  ACTIVE_TRIP_KEY,
  BG_LAST_STATION_KEY,
  DESTINATION_KEY,
  ROUTE_KEY,
} from '../../../shared/constants/storageKeys';
import { BACKEND_SSOT_MIRROR_MAX_AGE_MS } from '../../../shared/constants/realtime';
import type { LineNumber, Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { createLogger } from '../../../shared/utils/logger';
import {
  findStationByName,
  findStationByNameAndLine,
  resolveConsistentStationLine,
} from '../../../shared/utils/stationLookup';
import { buildLiveActivityData } from './stationNotification';
import { isLaDismissed } from './laDismissSentinel';
import { shouldSkipDeviceLiveActivityWrite } from './liveActivityPushChannel';
import { readBackendSsotMirror, type BackendSsotMirrorEntry } from './backendSsotMirror';

const logger = createLogger('SilentPushLaRefresh');

/**
 * 안전 JSON 파싱 — 손상된 entry는 null로 처리해 BG handler 전체가 throw하지 않도록 한다.
 */
function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * BG_LAST_STATION 형식 — `backgroundLocationTask`가 적재. WhileInUse 사용자는 BG task가
 * 동작하지 않으므로 키가 비어 있는 게 정상 — 그 경우 boardingLock의 boarding station을
 * 폴백 currentStation으로 사용한다 (대안: 위치 정보 없으면 LA 갱신 무의미하므로 no-op).
 */
interface BgLastStation {
  station: Station;
  distanceKm: number;
  timestamp: number;
}

function readBgLastStation(raw: string | null): BgLastStation | null {
  const parsed = safeParse<unknown>(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { distanceKm?: unknown }).distanceKm !== 'number' ||
    !(parsed as { station?: unknown }).station
  ) {
    return null;
  }
  return parsed as BgLastStation;
}

/**
 * destination을 결정 — DESTINATION_KEY 손상/부재면 null. 정상 케이스만 통과 (id 보장).
 */
function readDestination(raw: string | null): Station | null {
  const parsed = safeParse<Partial<Station>>(raw);
  if (!parsed || typeof parsed.id !== 'string') return null;
  return parsed as Station;
}

/**
 * #2589 — backend SSoT mirror의 currentStationId(+line)를 stations.json Station으로 resolve.
 *
 * ADR-038 정합 가드(`resolveConsistentStationLine`) 경유 — mirror의 currentStationLine이 그 역이
 * 실제 서비스하지 않는 노선을 가리켜도(성수 7호선 색 클래스, #2556) 실제 서비스 노선으로 교정한다.
 * currentStationLine 부재(legacy v1 mirror)면 name-only fallback.
 */
function resolveMirrorStation(mirror: BackendSsotMirrorEntry): Station | null {
  if (!mirror.currentStationLine) {
    return findStationByName(mirror.currentStationId);
  }
  // resolveConsistentStationLine이 항상 해당 역이 실제 서비스하는 line을 반환하므로(그런 역이
  // stations.json에 있다면) 아래 findStationByNameAndLine은 그 line으로 항상 성공한다 — 역명
  // 자체가 없으면 이 시점에도 null(정상 케이스, findStationByName과 동일 결과).
  const consistentLine = resolveConsistentStationLine(
    mirror.currentStationId,
    mirror.currentStationLine as LineNumber,
  );
  return findStationByNameAndLine(mirror.currentStationId, consistentLine);
}

/**
 * #900 Seam D 본체. silent push handler가 호출하는 단일 진입점.
 * 예외는 caller로 전파하지 않는다 — silent push 처리 흐름 끝에서 호출되며 LA refresh 실패가
 * 알람 발사/ACK 흐름을 막아서는 안 된다.
 */
export async function refreshLiveActivityFromBackgroundContext(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    if (!LiveActivity.isLiveActivityEnabled()) {
      logger.info('LA disabled — skip refresh');
      return;
    }
    // #926 (Seam E3) — 사용자가 LA를 dismiss한 직후에는 silent push가 도착해도 LA를 다시
    // 살리지 않는다. TTL(LA_DISMISS_SENTINEL_TTL_MS, 30분) 안의 sentinel이 있으면 skip.
    // TTL 경과 또는 명시적 clear 후에는 정상 refresh.
    if (await isLaDismissed()) {
      logger.info('LA dismiss sentinel active — skip refresh');
      return;
    }
    const [destRaw, routeRaw, bgRaw, tripToken] = await Promise.all([
      AsyncStorage.getItem(DESTINATION_KEY),
      AsyncStorage.getItem(ROUTE_KEY),
      AsyncStorage.getItem(BG_LAST_STATION_KEY),
      AsyncStorage.getItem(ACTIVE_TRIP_KEY),
    ]);

    const destination = readDestination(destRaw);
    if (!destination) {
      logger.info('destination absent — end LA');
      await LiveActivity.endLiveActivity();
      return;
    }

    // #2589 — currentStation SSoT 결정 순서 (확정 아키텍처: backend추적 → LA 표시).
    // 1순위: backend SSoT mirror (fresh ≤180s — cascade picker와 동일 상한,
    //   BACKEND_SSOT_MIRROR_MAX_AGE_MS). GPS 사망(지하/데스크) 상태에서도 backend가 이미
    //   advance 게이트를 통과한 위치를 신뢰한다.
    // 2순위: BG_LAST_STATION(GPS, backgroundLocationTask 적재) — mirror 부재/stale 시 폴백.
    // 3순위: 없음 — no-op으로 마지막 정상 LA 상태 유지 (boardingLock fallback은 stale
    //   "탑승역" 표시(P1 #3) + 활성 LA 없는 상태에서 새 LA를 시작(P1 #1)할 위험이 있어
    //   의도적으로 채택하지 않음 — 기존 동작 유지).
    const mirror = await readBackendSsotMirror();
    const mirrorFresh =
      mirror !== null && Date.now() - mirror.receivedAt <= BACKEND_SSOT_MIRROR_MAX_AGE_MS;
    const mirrorStation = mirrorFresh && mirror ? resolveMirrorStation(mirror) : null;

    const bg = readBgLastStation(bgRaw);

    let currentStation: Station | null = null;
    let distanceM = 0;
    let source: 'backend-ssot' | 'gps-bg' = 'gps-bg';
    if (mirrorStation) {
      currentStation = mirrorStation;
      // backend mirror는 GPS distance를 싣지 않는다 — backend가 이미 "이 역에 있다"고
      // advance 확정한 상태이므로 0m(도착)로 표시한다.
      distanceM = 0;
      source = 'backend-ssot';
    } else if (bg) {
      currentStation = bg.station;
      distanceM = Math.round(bg.distanceKm * 1000);
      source = 'gps-bg';
    }

    if (!currentStation) {
      logger.info('no currentStation source (mirror stale/absent + BG_LAST_STATION absent) — skip refresh (preserve last LA state)');
      return;
    }
    // #2481 — backend-authority 모드 + 이미 backend가 이 trip의 LA push 채널을 쥐고 있으면
    // device GPS 추정치로 backend의 정확한 "N정거장"을 덮어쓰지 않는다(Wave 2).
    if (shouldSkipDeviceLiveActivityWrite(tripToken)) {
      logger.info('backend-authority active trip — skip BG LA refresh write');
      return;
    }
    const route = safeParse<Route>(routeRaw);

    // BG 컨텍스트는 ETA/alarm을 계산하지 않는다 — silent push가 알람을 별도로 발사하고,
    // ETA는 backend LA push가 권위. LA refresh는 station/route 변동을 빠르게 반영하는 용도.
    // sourceLabel은 silent push 출처를 자백할 수도 있으나, #327 정책상 positionTrain은
    // 라벨 미부착이라 inputs로 넘기지 않아도 동일 결과.
    const data = buildLiveActivityData(
      currentStation,
      distanceM,
      destination,
      route,
      null,
      false,
      null,
    );
    await LiveActivity.updateLiveActivity(data);
    // #2589 — V/X 대시보드(DebugModal alarm log)에서 currentStation SSoT 출처 관측용.
    logger.info(
      `la-refresh source=${source}: ${currentStation.name} → ${destination.name}`,
    );
  } catch (e) {
    logger.warn('refresh failed:', e);
  }
}

// Test 환경 노출. 내부 helper들도 부분적으로 검증 가능하도록 노출하지만 production import는
// 본 진입점 함수 하나만 사용한다.
export const __test__ = {
  readBgLastStation,
  readDestination,
  resolveMirrorStation,
};
