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

// #1280 — foreground(WhileInUse) 위치 업로드 throttle 간격.
// BG 위치 task가 못 도는 WhileInUse 권한에서 FG fix-watch가 ~10s마다 backend로 좌표를 송신해
// POST /position 채널을 점등한다. BG `timeInterval`(30s)보다 짧아 FG 활성 동안은 더 촘촘히
// 위치 지능을 먹인다. 연속 fix가 이 간격보다 자주 들어와도 1회로 묶인다.
//
// #2093 (A) — BG task(`backgroundLocationTask`)도 동일 상수를 공유한다. iOS가 신호 재포착 후
// 배치 catch-up으로 짧은 간격에 연속 location update를 몰아 보내면 BG task invocation마다
// 무조건 uploadPosition을 호출해 POST /position이 2Hz까지 폭주(evidence: 08:44:15~08:45:11
// 59회)했다 — FG hook의 in-memory ref 쓰로틀과 달리 BG task는 invocation마다 새 컨텍스트라
// AsyncStorage(`BG_LAST_POSITION_UPLOAD_AT_KEY`) 기반으로 같은 간격을 강제한다.
export const POSITION_UPLOAD_MIN_INTERVAL_MS = 10_000;

// #1313 — foreground GPS watch 샘플링 파라미터. subsurface(지하) 여부로 갈린다.
// 지상/warmup/미지원에서는 High@2s를 그대로 유지(정확도 우선), 지하에서만 throttle.
//
// 지상(기본): High + distanceInterval:0 + timeInterval:2000.
//  GPS hardware fix를 최대한 자주 흘려보낸다. subsurface가 true로 확정되기 전까지는
//  항상 이 값을 사용한다(undefined/false 포함) — 확신 없이 GPS를 절대 낮추지 않는다.
export const FG_WATCH_SURFACE_TIME_INTERVAL_MS = 2_000;
// 지하(subsurface 확정): Balanced + distanceInterval:0 + timeInterval:12000.
//  지하 GPS는 WiFi BSSID/Cell triangulation으로 300~1500m라 알람에 무의미(useStationAlarm 게이트가
//  별도 차단) — 표시 전용. 위치 지능은 WiFi SSID/기압계/backend dead-reckoning이 담당하므로
//  FG watch는 12s로 늦춰 배터리를 아낀다. WiFi 역 DB가 ~19개 역만 커버해 표시 공백을 피하려고
//  완전 정지가 아닌 보수적 throttle을 택했다. High→Balanced로 고정밀 측위 시도도 줄인다.
//  #1983~#2100 히스토리: 한때 accuracy를 High로 통일(#1983, 지하 fix 정확도 확보 목적)했으나
//  #2074 품질 게이트가 지하 fix를 전량 폐기하는 게 확인돼(#2100) Balanced로 재전환 — 상세 근거는
//  useNearestStation.ts의 FG_WATCH_OPTIONS_SUBSURFACE 주석 참고.
export const FG_WATCH_SUBSURFACE_TIME_INTERVAL_MS = 12_000;

// iOS CoreLocation은 속도를 측정할 수 없을 때 음수(보통 -1)를 반환한다.
// stationary/indoor/cold-start 등에서 자주 발생 — null로 정규화해 다운스트림이
// "측정 불가"와 "정지(0 m/s)"를 명확히 구분하도록 한다.
// 참고: Apple docs — CLLocation.speed: "A negative value indicates an invalid speed."
export const GPS_SPEED_INVALID = -1;

/**
 * GPS speed가 의미 있는 값인지(>= 0) 판정. null/undefined/음수는 모두 invalid.
 * GPS_SPEED_INVALID 게이트 적용 지점이 여럿(`useNearestStation`의 fix/drop 분기 등)이라
 * helper로 분리해 의미를 한 곳에 모은다.
 */
export function isValidGpsSpeedMps(value: number | null | undefined): value is number {
  return value != null && value >= 0;
}
