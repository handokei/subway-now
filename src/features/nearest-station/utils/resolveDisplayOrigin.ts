import type { Station } from '../../../shared/types/station';

/**
 * 현재역 표시명이 고착된 fused cascade가 아니라 실제 위치를 따르도록 한다 (#2454, R2).
 *
 * 사용자가 route arc를 벗어나면 fused cascade(`effectiveOrigin`의 상위 원천인 `result`)는
 * off-arc 위치를 reconcile하지 못해 trip origin(예: 뚝섬)에 stuck된다. 이때
 * `currentStationDisplayDemoted`(#2125)가 true가 되어 표시 계층에 "cascade를 신뢰할 수
 * 없다"는 신호를 준다. 기존에는 이 신호를 정직 강등(placeholder 텍스트)에만 썼는데, 그
 * 결과 화면에는 STALE한 이름(뚝섬)은 안 보이지만 실제 위치(잠실) 정보도 함께 사라졌다.
 *
 * raw GPS `liveResult`(sticky/cascade 개입 없는 실제 최근접, #1568)는 바로 이 순간에도
 * 사용자의 실제 위치(잠실)를 정확히 반영한다. cascade가 demoted 상태일 때는 표시명이
 * liveResult를 따라가도록 해 "이름=실제위치"가 되게 한다 — LINE 배지는 이미 raw GPS
 * variants를 쓰므로 이름이 여기 합류하면 자연히 같은 역을 가리키게 된다.
 *
 * fire path(SSOT: `effectiveOrigin`/`result`) 자체는 건드리지 않는다 — 알람/도착정보/경로
 * 계산은 여전히 기존 fallback chain을 그대로 쓴다. 이 함수는 표시 전용이다.
 */
export function resolveDisplayOrigin(
  effectiveOrigin: Station | null,
  liveStation: Station | null,
  isDemoted: boolean,
  isCustomOrigin: boolean,
): Station | null {
  if (isCustomOrigin) return effectiveOrigin;
  if (isDemoted) return liveStation;
  return effectiveOrigin;
}
