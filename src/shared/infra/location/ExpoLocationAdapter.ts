/**
 * ExpoLocationAdapter — LocationPort의 expo-location 구현체.
 *
 * ADR Roadmap — Feature-based + Ports & Adapters Phase 3/5 (#886).
 *
 * 위치 정책:
 *   본 어댑터는 `shared/infra/`에 있다. 이유는 다른 도메인(alarm의 silentPushLocationGate,
 *   향후 backgroundLocation 통합 등)도 같은 expo-location 인스턴스를 공유하기 위함.
 *   nearest-station features가 shared infra를 사용하는 방향은 정상 (features → shared).
 *
 * 현재 상태 (Phase 3):
 *   본 어댑터는 LocationPort 구현의 thin entrypoint만 제공한다.
 *   nearest-station 도메인 내부의 기존 expo-location 직접 호출은 의도적으로 유지되며
 *   (PR 크기/회귀 위험 관리), Phase 5에서 일괄 본 어댑터 경유로 전환한다.
 *
 * 신규 호출자(향후 추가되는 위치 게이트/현재역 매칭 경로)는 가능한 한 본 어댑터를 통해 호출하라.
 *
 * @see src/features/nearest-station/ports/LocationPort.ts — 인터페이스 명세
 */

import * as Location from 'expo-location';
// NOTE: ESLint 경계 룰("shared/는 features/를 import 할 수 없다") 명목상 위반.
// 본 import는 'features/nearest-station/ports/LocationPort'의 **타입만** 참조하는 컴파일타임 의존이며,
// 런타임 의존 방향은 여전히 features → shared (nearest-station 도메인이 본 어댑터를 호출)이다.
// Phase 5에서 LocationPort를 도메인 단일성에 맞춰 위치 재판단 후 룰을 enforce(error)로 승격한다.
import type { LocationFix, LocationPermissionResult, LocationPort } from '../../ports/LocationPort';

async function getCurrentPosition(): Promise<LocationFix> {
  const { coords, timestamp } = await Location.getCurrentPositionAsync({});
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy ?? null,
    speed: coords.speed ?? null,
    timestamp,
  };
}

async function requestForegroundPermissions(): Promise<LocationPermissionResult> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return { granted: status === 'granted', background: false };
}

/**
 * LocationPort 싱글톤 — 앱 부팅 시 DI 지점에서 nearest-station 도메인에 주입한다.
 * 현재는 import-time 노출만 제공. Phase 5에서 명시적 DI 컨테이너로 전환 예정.
 */
export const expoLocationAdapter: LocationPort = {
  getCurrentPosition,
  requestForegroundPermissions,
};
