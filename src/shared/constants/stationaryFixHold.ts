// #3191 PR-1 — 지상 정지 fix 유지 술어(shouldHoldStationaryFix) 임계값.
// 근거: tasks/plan-2026-10-22-s1-sagajeong-surface-stale-gate.md §3 (v5 규칙).

// L이 "지상 품질 정지 fix"이려면 정확도가 이 값(m) 이하여야 한다.
// 실측 거부 사례: 지하 복귀 fix acc 44 / 50 / 61.
export const STATIONARY_HOLD_MAX_ACCURACY_M = 30;

// fix 자체의 속도가 이 값(m/s) 미만이어야 정지 fix. 실측 거부: 터널 13.9 m/s 등.
export const STATIONARY_HOLD_MAX_SPEED_MPS = 0.5;

// 기압 ΔP 이동 증거를 L.ts 보다 얼마나 앞서까지 볼지(ms). L 직전에 시작된 하강(E7 06:29:33 → L 06:29:34)을 잡는다.
export const STATIONARY_HOLD_BARO_LOOKBACK_MS = 180_000;
