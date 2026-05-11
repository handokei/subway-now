import * as Location from 'expo-location';

// 20m 이동마다 콜백 (역간 평균 1km 기준 충분, false alarm 방지).
const TRACKING_DISTANCE_INTERVAL_M = 20;
// 거리 변화 없어도 30s마다 콜백 강제 (Android 약신호 환경 보강).
const TRACKING_TIME_INTERVAL_MS = 30_000;

// 백그라운드 위치 추적 옵션 — 플랫폼 공통 설정.
// i18n 의존이 있는 `foregroundService`만 호출부에서 인라인으로 결합한다.
//
// - `timeInterval`: Android에서 거리 변화가 없어도 주기적 콜백 보장 (지하/터널 약신호 환경).
// - `pausesUpdatesAutomatically: false`: iOS의 stationary 오판으로 인한 업데이트 중단 차단.
// - `activityType: AutomotiveNavigation`: iOS가 GPS를 가장 공격적으로 유지하도록 차량 내비 프로필 사용.
// - `deferredUpdatesInterval` 미설정: 백그라운드 batching 비활성화 (회귀 가드 #189).
export const LOCATION_TRACKING_OPTIONS = {
  accuracy: Location.Accuracy.High,
  activityType: Location.LocationActivityType.AutomotiveNavigation,
  pausesUpdatesAutomatically: false,
  distanceInterval: TRACKING_DISTANCE_INTERVAL_M,
  timeInterval: TRACKING_TIME_INTERVAL_MS,
  showsBackgroundLocationIndicator: true,
} as const;
