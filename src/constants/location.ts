// 15s: 환승 알람은 역 통과 시점과 동기화돼야 하므로 오래된 좌표를 강하게 거부한다.
// BG `timeInterval`(30s, locationTracking.ts)보다 짧다 — stationary 상태에서 OS가
// 캐시된 fix를 넘기면 의도적으로 drop. "실시간성 우선, 나쁜 좌표 거부" 정책.
export const MAX_LOCATION_AGE_MS = 15_000;
// 200m: 알람 트리거용 엄격 게이트. 역간 평균 거리(800m+) 대비 안전 마진.
// false alarm 방지 위해 그대로 유지 — 알람 경로(useStationAlarm)에서만 사용.
export const MAX_ACCURACY_M = 200;
// 1500m: UI 표시용 완화 게이트. 지하 플랫폼/터널의 horizontalAccuracy(300~1500m)도
// 일단 수용해 "추정 현재역"을 끊김 없이 보여준다. 알람은 별도 엄격 게이트로 차단.
export const MAX_ACCURACY_M_DISPLAY = 1500;
export const MAX_STATION_DISTANCE_KM = 1.0;
