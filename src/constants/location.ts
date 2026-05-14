// 15s: 환승 알람은 역 통과 시점과 동기화돼야 하므로 오래된 좌표를 강하게 거부한다.
// BG `timeInterval`(30s, locationTracking.ts)보다 짧다 — stationary 상태에서 OS가
// 캐시된 fix를 넘기면 의도적으로 drop. "실시간성 우선, 나쁜 좌표 거부" 정책.
export const MAX_LOCATION_AGE_MS = 15_000;
// 200m: 알람 트리거용 엄격 게이트. 역간 평균 거리(800m+) 대비 안전 마진.
// false alarm 방지 위해 그대로 유지 — 알람 경로(useStationAlarm)에서만 사용.
export const MAX_ACCURACY_M = 200;
// 250m: UI 표시용 게이트. Apple Core Location 가이드(100m 초과는 통상 필터링)와
// 역간 평균 거리(800m+)를 함께 고려한 보수 값. 부정확 fix(±1.5km)로 엉뚱한 역을
// 단정하는 사고를 방지. 이 게이트로 drop된 동안은 useNearestStation이 result를
// 갱신하지 않고 locationUncertain=true로 노출해 호출자가 "위치 확인 중" 상태로 표시한다.
// Position-first fusion(useFusedNearestStation)이 활성화되면 realtimePosition이 우선이므로
// GPS 게이트의 영향 범위는 fallback 경로에 한정된다.
export const MAX_ACCURACY_M_DISPLAY = 250;
export const MAX_STATION_DISTANCE_KM = 1.0;
