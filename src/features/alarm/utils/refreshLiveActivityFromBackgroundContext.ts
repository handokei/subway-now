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
 * AsyncStorage SSOT(`ROUTE_KEY` / `DESTINATION_KEY` / `BG_LAST_STATION_KEY` / `BOARDING_LOCK_KEY`)
 * 를 읽어 LA를 재계산해 한 번 발사한다.
 *
 *   - destination 없음 → trip 종료 의미 → `endLiveActivity` 호출
 *   - currentStation 결정 불가 (BG_LAST_STATION 부재 + lock의 boarding station 매칭 실패)
 *     → no-op (안전: 기존 LA 마지막 정상 상태 유지)
 *   - 그 외 → `buildLiveActivityData` → `updateLiveActivity`
 *
 * zustand store는 BG에서 접근 불가하므로 AsyncStorage만 사용한다. iOS 외 플랫폼은 native
 * Live Activity가 없으므로 graceful no-op.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as LiveActivity from 'live-activity';
import {
  BG_LAST_STATION_KEY,
  DESTINATION_KEY,
  ROUTE_KEY,
} from '../../../shared/constants/storageKeys';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { createLogger } from '../../../shared/utils/logger';
import { buildLiveActivityData } from './stationNotification';

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
    const [destRaw, routeRaw, bgRaw] = await Promise.all([
      AsyncStorage.getItem(DESTINATION_KEY),
      AsyncStorage.getItem(ROUTE_KEY),
      AsyncStorage.getItem(BG_LAST_STATION_KEY),
    ]);

    const destination = readDestination(destRaw);
    if (!destination) {
      logger.info('destination absent — end LA');
      await LiveActivity.endLiveActivity();
      return;
    }

    const bg = readBgLastStation(bgRaw);
    // bg가 없으면 LA 갱신용 currentStation 추정 불가 → no-op으로 마지막 정상 상태 유지.
    // boardingLock fallback은 사용자가 다수 역 진행한 후에도 boarding station을 표시해
    // stale을 부르고(P1 #3), 활성 LA 없는 상태에서 update가 새 LA를 시작해(P1 #1)
    // lockscreen에 의도치 않은 LA를 띄울 위험. 둘 다 본 가드로 차단.
    if (!bg) {
      logger.info('BG_LAST_STATION absent — skip refresh (preserve last LA state)');
      return;
    }
    const currentStation = bg.station;
    const distanceM = Math.round(bg.distanceKm * 1000);
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
    logger.info(`LA refreshed: ${currentStation.name} → ${destination.name}`);
  } catch (e) {
    logger.warn('refresh failed:', e);
  }
}

// Test 환경 노출. 내부 helper들도 부분적으로 검증 가능하도록 노출하지만 production import는
// 본 진입점 함수 하나만 사용한다.
export const __test__ = {
  readBgLastStation,
  readDestination,
};
