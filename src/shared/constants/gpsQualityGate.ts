// #2070 — fusion 결정 tier 입력용 GPS 품질 게이트.
// 2026-07-29 지하 위치서비스 리서치: 지하 CLLocation은 65m~km 오차 + 최대 2분+ 지연·결측이 흔하다.
// 좌표값 자체는 결정에 쓰지 않는 원칙(memory/feedback_no_gps_for_decision.md)을 유지하되,
// "게이트 미달" 자체를 지하 진입 후보 신호로 재활용한다.
//
// 100m: Apple Core Location 가이드 기준 통상 신뢰 구간 상한. 지상 fix는 대부분 10~50m로
// 여유 있게 통과하고, 지하 WiFi/Cell 삼각측량(수백m~수km)은 확실히 배제한다.
export const GPS_QUALITY_GATE_MAX_ACCURACY_M = 100;
// 15s: MAX_LOCATION_AGE_MS(location.ts)와 동일 기준 — 환승 알람 동기화 수준의 신선도 요구.
export const GPS_QUALITY_GATE_MAX_AGE_MS = 15_000;

// #2070 — 품질 저하 transition 이벤트 임계값. 두 조건 중 하나라도 충족하면 "지하 진입 후보"로
// 간주해 기존 subsurface/environment 판정 로직에 입력으로 추가한다(판정 로직 대체 아님).
//
// 급락: 직전 게이트 통과 fix 대비 accuracy가 이 값(m) 초과로 나빠지면 급락으로 판정.
export const GPS_QUALITY_DEGRADE_JUMP_M = 100;
// 부재: 게이트 통과 fix가 이 시간(ms) 이상 없으면 부재로 판정.
export const GPS_QUALITY_GATE_ABSENCE_MS = 30_000;
