// 15s: 환승 알람은 역 통과 시점과 동기화돼야 하므로 오래된 좌표를 강하게 거부한다.
// BG `timeInterval`(30s, locationTracking.ts)보다 짧다 — stationary 상태에서 OS가
// 캐시된 fix를 넘기면 의도적으로 drop. "실시간성 우선, 나쁜 좌표 거부" 정책.
export const MAX_LOCATION_AGE_MS = 15_000;
// 200m: 지하역 GPS 자연 열화 수용. 역간 평균 거리(800m+) 대비 안전 마진 충분.
export const MAX_ACCURACY_M = 200;
export const MAX_STATION_DISTANCE_KM = 1.0;
