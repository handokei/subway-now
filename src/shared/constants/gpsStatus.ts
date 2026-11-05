import { AppState, AppStateStatus } from 'react-native';

/**
 * #852 — useNearestStation의 GPS watch 구독 상태 라벨.
 * AppState 'active' 동안만 watchPositionAsync 활성, 'background'/'inactive'에서는 stopWatch().
 * silent push wake 시에도 watch는 미동작 — 사용자가 디버그 모달에서 "왜 안 바뀌지" 확인 가능하도록 노출.
 *
 * string union — UI 라벨/dump key 양쪽에서 그대로 사용한다.
 */
export type GpsActiveState = 'fg' | 'bg';

export const GPS_ACTIVE: GpsActiveState = 'fg';
export const GPS_INACTIVE: GpsActiveState = 'bg';

/**
 * AppState.currentState → GpsActiveState 매핑.
 * 'active'만 fg, 그 외(background/inactive/unknown)는 bg로 간주 — watch가 정지된 상태와 일치.
 * AppState 자체를 직접 비교하지 않고 함수로 래핑 — 테스트에서 mock 가능 + 다른 호출처에서 재사용.
 */
export function appStateToGpsActive(state: AppStateStatus): GpsActiveState {
  return state === 'active' ? GPS_ACTIVE : GPS_INACTIVE;
}

/**
 * 현재 AppState 기준 GPS watch 활성 여부. 초기 마운트 시 hook 초기값 계산용.
 *
 * UI hook은 화면이 살아있을 때만 마운트되므로 마운트 시점은 일반적으로 'active'다.
 * 단 RN/Jest 환경에서 `AppState.currentState`가 `'unknown'`으로 시작할 수 있어,
 * 명시적 'active'만 fg로 인정. 마운트 직후 AppState change listener가 실제 상태로 정정한다.
 */
export function currentGpsActive(): GpsActiveState {
  return appStateToGpsActive(AppState.currentState);
}
