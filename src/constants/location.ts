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
// GPS jump gate (#527): 이전 fix 대비 물리적으로 불가능한 좌표 점프 차단.
// 50 m/s: 지하철 최고 속도(~22 m/s) + 안전 마진. 표준 운행에선 절대 초과 불가.
export const MAX_PLAUSIBLE_SPEED_MPS = 50;
// 100m 미만 이동은 GPS 노이즈 범위로 간주하고 속도 검사를 면제.
// 짧은 간격(< 1s) 두 fix가 거의 같은 위치일 때 d/dt가 비정상적으로 부풀어 false-positive
// 차단이 발생하는 것을 막는다. 21:29 사고(25km)는 이 임계값보다 한참 위라 영향 없음.
export const MIN_JUMP_DISTANCE_M = 100;
