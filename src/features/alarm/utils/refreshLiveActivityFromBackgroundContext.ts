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
 *     1. backend SSoT mirror (fresh ≤180s, `resolveBackendSsotMirrorStation` 경유 — line 불일치는
 *        거부(null)해 다음 tier로. 활성 LA 없으면 update-only 가드로 no-op) — GPS 사망 상태에서도 우선
 *     2. BG_LAST_STATION(GPS) — mirror 부재/stale/거부 시 폴백
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
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { createLogger } from '../../../shared/utils/logger';
import { buildLiveActivityData } from './stationNotification';
import { isLaDismissed } from './laDismissSentinel';
import { shouldSkipDeviceLiveActivityWrite } from './liveActivityPushChannel';
import { readBackendSsotMirror, resolveBackendSsotMirrorStation, isBackendSsotMirrorFresh } from './backendSsotMirror';
import { updateLiveActivityFromMirrorStation } from './liveActivityMirrorSync';

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
 * 동작하지 않으므로 키가 비어 있는 게 정상 — 이 경우 currentStation 결정 순서(#2589, 파일 상단
 * 헤더 참조)의 2순위가 채택 실패하고, 1순위(backend SSoT mirror)도 없으면 3순위(no-op)로 떨어진다.
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
    // #926 (Seam E3) — 사용자가 LA를 dismiss한 직후에는 silent push가 도착해도 LA를 다시
    // 살리지 않는다. TTL(LA_DISMISS_SENTINEL_TTL_MS, 30분) 안의 sentinel이 있으면 skip.
    // TTL 경과 또는 명시적 clear 후에는 정상 refresh.
    if (await isLaDismissed()) {
      logger.info('LA dismiss sentinel active — skip refresh');
      return;
    }
    // #2589 (code review 효율) — destination/tripToken만 먼저 읽어 destination-absent 조기
    // return과 #2481 backend-authority skip 게이트를 최소 I/O로 먼저 판정한다. 두 게이트 모두
    // route/bg/mirror 값이 필요 없으므로, skip되는 trip에서 route/bg/mirror read를 낭비하지 않는다.
    const [destRaw, tripToken] = await Promise.all([
      AsyncStorage.getItem(DESTINATION_KEY),
      AsyncStorage.getItem(ACTIVE_TRIP_KEY),
    ]);

    const destination = readDestination(destRaw);
    if (!destination) {
      logger.info('destination absent — end LA');
      await LiveActivity.endLiveActivity();
      return;
    }

    // #2481 — backend-authority 모드 + 이미 backend가 이 trip의 LA push 채널을 쥐고 있으면
    // device GPS 추정치로 backend의 정확한 "N정거장"을 덮어쓰지 않는다(Wave 2).
    //
    // #2659 — 이 판정을 **GPS 분기 직전으로 미룬다**(이전에는 여기서 early return). mirror 분기가
    // 쓰는 값은 GPS 추정치가 아니라 backend 자신의 SSoT라 이 게이트의 근거가 적용되지 않는데,
    // early return이 두 분기를 한꺼번에 막아 LA writer가 backend LA push 하나만 남아 있었다
    // (2026-09-16 라이드: `laPushDelivery=0/0` → LA 13분 정체). read 낭비(route/bg/mirror)는
    // GPS-only로 skip되는 trip에서만 발생하며, mirror 채널을 살리는 값에 비해 무시할 수준이다.
    const backendAuthoritySkipsGpsWrite = shouldSkipDeviceLiveActivityWrite(tripToken);

    // #2589 — currentStation SSoT 결정 순서 (확정 아키텍처: backend추적 → LA 표시).
    // 1순위: backend SSoT mirror (fresh ≤180s — cascade picker와 동일 상한,
    //   BACKEND_SSOT_MIRROR_MAX_AGE_MS). GPS 사망(지하/데스크) 상태에서도 backend가 이미
    //   advance 게이트를 통과한 위치를 신뢰한다. 역/노선 resolve는 FG cascade picker
    //   (`useFusedNearestStation` ssotGuardResult)와 동일한 `resolveBackendSsotMirrorStation`을
    //   공유 — line 불일치는 "보정"이 아니라 "거부"(null)해 다음 tier로 넘긴다(code review 1/2번,
    //   판정 로직 drift 방지).
    // 2순위: BG_LAST_STATION(GPS, backgroundLocationTask 적재) — mirror 부재/stale/거부 시 폴백.
    // 3순위: 없음 — no-op으로 마지막 정상 LA 상태 유지 (boardingLock fallback은 stale
    //   "탑승역" 표시(P1 #3) 위험이 있어 의도적으로 채택하지 않음 — 기존 동작 유지).
    const [routeRaw, bgRaw, mirror] = await Promise.all([
      AsyncStorage.getItem(ROUTE_KEY),
      AsyncStorage.getItem(BG_LAST_STATION_KEY),
      readBackendSsotMirror(),
    ]);
    const mirrorFresh = isBackendSsotMirrorFresh(mirror);
    const mirrorStation = mirrorFresh && mirror ? resolveBackendSsotMirrorStation(mirror) : null;

    const bg = readBgLastStation(bgRaw);
    const route = safeParse<Route>(routeRaw);

    // #2589 (code review 3번, P1 #1 클래스) — mirror-sourced 경로는 update-only. 활성 LA가
    // 없으면 native `update()`가 내부적으로 `start()`로 fall-through해 BG 컨텍스트에서
    // 사용자가 본 적 없는 새 LA를 생성할 위험이 있다(LiveActivityManager.swift). 기존
    // BG_LAST_STATION 경로는 이 가드 없이 그대로 둔다(현행 보존 지시) — mirror 경로만 신규
    // 위험이라 새로 도입.
    // #2610 (b) — mirror 결정 이후 3단계(update-only 가드 → buildLiveActivityData →
    // updateLiveActivity)는 `updateLiveActivityFromMirrorStation`으로 추출. FG
    // (`useForegroundLaMirrorSync`)와 동일 함수를 공유해 backend-ssot 소스의 LA 갱신 동작이
    // BG/FG 양쪽에서 drift하지 않는다(순수 추출, 동작 100% 동일).
    if (mirrorStation) {
      await updateLiveActivityFromMirrorStation(mirrorStation, destination, route);
      return;
    }

    if (backendAuthoritySkipsGpsWrite) {
      logger.info('backend-authority active trip — skip BG LA refresh write (gps 분기)');
      return;
    }

    if (!bg) {
      logger.info(
        'no currentStation source (mirror stale/absent/rejected + BG_LAST_STATION absent) — skip refresh (preserve last LA state)',
      );
      return;
    }
    // #2806 — GPS-BG 분기(BG_LAST_STATION)도 update-only여야 한다. 활성 LA가 없을 때 native
    // `update()`가 `start()`로 fall-through해 BG 컨텍스트에서 `Activity.request`가 throw →
    // 이 함수 최상단 catch(:204)로 전파돼 (silent push 핸들러 쪽에서) 일반 알림 폴백으로 이어지는
    // 경로였다(실기기 dump la-fallback-notification×14, 전부 트립 경계). mirror 경로(#2610,
    // updateLiveActivityFromMirrorStation)엔 이미 있던 동일 가드를 이 분기에도 적용한다. LA 신규
    // 생성은 정식 트립 시작 경로(`useLiveActivityPreBoardingLifecycle`)에서만 담당한다.
    if (!LiveActivity.hasActiveLiveActivity()) {
      logger.info(
        'la-refresh source=gps-bg but no active LA — skip (update-only, no create, #2806)',
      );
      return;
    }

    const currentStation = bg.station;
    const distanceM = Math.round(bg.distanceKm * 1000);

    // BG 컨텍스트는 ETA/alarm을 계산하지 않는다 — silent push가 알람을 별도로 발사하고,
    // ETA는 backend LA push가 권위. LA refresh는 station/route 변동을 빠르게 반영하는 용도.
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
      `la-refresh source=gps-bg: ${currentStation.name} → ${destination.name}`,
    );
  } catch (e) {
    logger.warn('refresh failed:', e);
  }
}

/**
 * #2659 — mirror가 **전진했을 때만** LA refresh를 1회 돌리는 push-독립 진입점.
 *
 * 배경: 이 모듈의 본 진입점을 호출하는 곳은 silent push 핸들러 하나뿐이었다(코드 확인,
 * 2026-09-16). 그래서 BG 상태에서 LA를 갱신할 수 있는 device 경로가 push 배달에 100% 종속됐고,
 * 지하에서 push가 13분 밀린 라이드에서 LA가 탑승역에 얼어붙었다. 반면 backend SSoT mirror는
 * `backgroundLocationTask` → `uploadPosition` → `POST /position` 응답(#2261)으로 같은 구간 내내
 * HTTP로 갱신되고 있었다 — 즉 **pull 채널은 열려 있는데 LA를 깨우는 트리거가 없었다.**
 *
 * `backgroundLocationTask`가 position upload 직후 호출한다. mirror의 `currentStationId`가
 * 직전 호출과 같으면 no-op — BG tick(~10초)마다 native LA update를 호출하면 #2660(발열) 맥락에
 * 역행하므로, "backend가 역을 전진시켰을 때"로만 좁힌다.
 *
 * mirror 부재/stale(=trip 종료 후 clear 포함)이면 dedup 기억을 비워, 다음 trip이 같은 역에서
 * 시작해도 첫 전진을 놓치지 않는다.
 */
let lastMirrorAdvanceKey: string | null = null;

/**
 * dedup 키 — 역명 단독이 아니라 `역명:노선`. `currentStationId`는 실제로는 역 **이름**이고
 * 노선은 `currentStationLine`에 따로 실린다(`resolveBackendSsotMirrorStation` 참조). 환승역은
 * 이름이 그대로인 채 노선만 바뀌므로(왕십리/잠실/종로3가…), 이름만 비교하면 환승 advance를
 * "같은 역"으로 보고 LA를 안 깨운다 — 이 앱의 핵심 시나리오에서 조용히 깨지는 함정
 * ([[lesson_transfer_graph_name_normalization_drift]]과 같은 클래스).
 */
function mirrorAdvanceKey(mirror: { currentStationId: string; currentStationLine?: string }): string {
  return `${mirror.currentStationId}:${mirror.currentStationLine ?? ''}`;
}

export async function refreshLiveActivityOnMirrorAdvance(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    const mirror = await readBackendSsotMirror();
    if (!isBackendSsotMirrorFresh(mirror) || !mirror) {
      lastMirrorAdvanceKey = null;
      return;
    }
    const key = mirrorAdvanceKey(mirror);
    if (key === lastMirrorAdvanceKey) return;
    lastMirrorAdvanceKey = key;
    await refreshLiveActivityFromBackgroundContext();
  } catch (e) {
    logger.warn('mirror-advance LA refresh 실패 (graceful)', e);
  }
}

// Test 환경 노출. 내부 helper들도 부분적으로 검증 가능하도록 노출하지만 production import는
// 본 진입점 함수 하나만 사용한다.
export const __test__ = {
  readBgLastStation,
  readDestination,
  resetMirrorAdvanceDedup: () => {
    lastMirrorAdvanceKey = null;
  },
};
