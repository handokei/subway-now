import * as Location from 'expo-location';

// 20m 이동마다 콜백 (역간 평균 1km 기준 충분, false alarm 방지).
const TRACKING_DISTANCE_INTERVAL_M = 20;
// 거리 변화 없어도 30s마다 콜백 강제 (Android 약신호 환경 보강).
const TRACKING_TIME_INTERVAL_MS = 30_000;
// #2344 (V8a) — 정지 확정(motion stationary) 구간의 완화 interval. surface(30s) 대비 3배.
// accuracy/distanceInterval은 미접촉(정지 중엔 거리 변화 자체가 거의 없어 distanceInterval
// 트리거는 의미가 작다) — 배터리 절감은 timeInterval 완화만으로 충분하고, 이동 재개 감지는
// getCurrentMotionStationary()가 매 tick 재평가하므로 별도 폴링 공백이 생기지 않는다.
const TRACKING_STATIONARY_TIME_INTERVAL_MS = 90_000;

// 백그라운드 위치 추적 프로파일. `foregroundService`는 i18n 의존이 있어 호출부에서 인라인으로
// 결합한다.
//
// - `timeInterval`: Android에서 거리 변화가 없어도 주기적 콜백 보장 (지하/터널 약신호 환경).
// - `pausesUpdatesAutomatically: false`: iOS의 stationary 오판으로 인한 업데이트 중단 차단.
// - `activityType: AutomotiveNavigation`: iOS가 GPS를 가장 공격적으로 유지하도록 차량 내비 프로필 사용.
// - `deferredUpdatesInterval` 미설정: 백그라운드 batching 비활성화 (회귀 가드 #189).
//
// #808 — `accuracy: High` 유지 결정 (BestForNavigation 미채택):
//   BestForNavigation은 GPS-only로 ~5m 정확도를 노리지만 fallback이 없다. 지하철 사용자는
//   지하/터널 비중이 크고 GPS lock이 끊기는 환경 → BestForNavigation은 fix 자체를 못 얻는
//   구간이 길어진다. High는 GPS lock 실패 시 WiFi BSSID / Cell tower triangulation으로
//   fallback해 50~100m fix를 계속 흘려보낸다(useFusedNearestStation에서 realtimePosition fusion이
//   GPS 부정확도를 보정 — 표시는 가능, 알람은 별도 엄격 게이트로 차단). 배터리 영향도 BestForNavigation
//   대비 낮다. 본 앱은 차량 내비가 아니라 지하철 추적이므로 정확도 vs 배터리 vs 지하 가용성 균형이
//   High가 최적.
// #2344 — profile object 인프라. accuracy는 두 프로파일 모두 High로 유지(미접촉) — interval만
// stationary에서 완화한다. accuracy 강등은 별 이슈(#2345)가 이 인프라(전환 지점 일반화)를 재사용.
const BASE_TRACKING_OPTIONS = {
  accuracy: Location.Accuracy.High,
  activityType: Location.LocationActivityType.AutomotiveNavigation,
  pausesUpdatesAutomatically: false,
  distanceInterval: TRACKING_DISTANCE_INTERVAL_M,
  showsBackgroundLocationIndicator: true,
} as const;

export const LOCATION_TRACKING_OPTIONS = {
  ...BASE_TRACKING_OPTIONS,
  timeInterval: TRACKING_TIME_INTERVAL_MS,
} as const;

export const LOCATION_TRACKING_OPTIONS_STATIONARY = {
  ...BASE_TRACKING_OPTIONS,
  timeInterval: TRACKING_STATIONARY_TIME_INTERVAL_MS,
} as const;

/** BG location 추적 프로파일. 'surface'=기본(30s), 'stationary'=정지 확정 시 완화(90s). */
export type BgLocationProfile = 'surface' | 'stationary';

/**
 * profile → 추적 옵션 매핑의 SSoT. 신규 프로파일이 추가돼도(#2345 accuracy 강등 등) 이 함수
 * 한 곳만 확장하면 되도록 전환 지점을 일반화한다.
 */
export function locationTrackingOptionsForProfile(profile: BgLocationProfile) {
  return profile === 'stationary' ? LOCATION_TRACKING_OPTIONS_STATIONARY : LOCATION_TRACKING_OPTIONS;
}
