// #3191 PR-1 — 지상 정지 fix 유지 술어(shouldHoldStationaryFix) 임계값.
// 근거: tasks/plan-2026-10-22-s1-sagajeong-surface-stale-gate.md §3 (v5 규칙).

// L이 "지상 품질 정지 fix"이려면 정확도가 이 값(m) 이하여야 한다.
// 실측 거부 사례: 지하 복귀 fix acc 44 / 50 / 61.
export const STATIONARY_HOLD_MAX_ACCURACY_M = 30;

// fix 자체의 속도가 이 값(m/s) 미만이어야 정지 fix. 실측 거부: 터널 13.9 m/s 등.
export const STATIONARY_HOLD_MAX_SPEED_MPS = 0.5;

// 기압 ΔP 이동 증거를 L.ts 보다 얼마나 앞서까지 볼지(ms). L 직전에 시작된 하강(E7 06:29:33 → L 06:29:34)을 잡는다.
export const STATIONARY_HOLD_BARO_LOOKBACK_MS = 180_000;

// #3191 PR-2 (G2, 사용자 결정 D1) — 지상 판별자: fix와 GPS 최근접역 사이 거리가 이 값(m) 이상일 때만 hold.
// 지하 플랫폼에서는 acc 24~27 fix가 승강장 바로 옆(<=100m)에 찍힌다(W 덤프 L597-607, 용마산 64m 등 표본 10건).
// 집(>=222m)·뚝섬 사무실(161m) 같은 지상 정지 지점은 남기고 역사·승강장 표본은 전부 거부하는 경계.
export const STATIONARY_HOLD_MIN_NEAREST_STATION_M = 150;

// #3191 PR-2 (D2(b)) — 기압계가 "하강을 볼 수 있는" 상태의 정의.
// 첫 reading 후 이 시간이 지나야(콜드스타트 워밍업) 한다.
export const STATIONARY_HOLD_BARO_WARMUP_MS = 30_000;
// 마지막 reading이 이 시간 안이어야(기압 공백·BG 정지 중이면 하강을 못 본다) 한다.
export const STATIONARY_HOLD_BARO_FRESH_MS = 30_000;

// 센서·권한·리스너 자체가 실패한 사유 — 이때만 기압계가 못 본다고 본다. 'readings'(stop verdict의
// 30초 baseline 부족)는 ΔP 추적과 무관하므로 실패가 아니다(barometerState.ts: ΔP 추적은 reset 영향 없음).
export const STATIONARY_HOLD_BARO_FAILURE_REASONS: readonly string[] = [
  'sensor',
  'permission',
  'listener-failed',
  'flag-on-dormant',
];
