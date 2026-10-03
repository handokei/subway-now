/**
 * silent push 위치 게이트(`checkSilentPushLocationGate`) 임계값 모음.
 *
 * 기존 inline 값(`src/features/alarm/utils/silentPushLocationGate.ts`)을
 * #1209 D3에서 분리.
 *
 * 임계값 운영 원칙:
 * - lock 활성 경로(`THRESHOLDS_M`): trainCode/노선이 확정되어 좁은 거리(300~400m)로
 *   false positive를 차단할 수 있다.
 * - lockless 경로(`LOCKLESS_INTERMEDIATE_THRESHOLDS_M`): sticky station 좌표가
 *   실제 위치와 500m 이상 어긋날 수 있어 좁은 임계로는 정상 trip도 모두 미스한다
 *   (2026-06-12 14건 silent push 전부 out-of-range 사고). 800m/1200m로 넓혀
 *   "사용자 명시 의향 trip은 lock 활성과 동급 보장" 원칙을 충족한다.
 * - hop window(`LOCKLESS_HOP_WINDOW_TOLERANCE`): D1 estimator가 현재 hop을 제공할 경우,
 *   payload hop과 ±1 이내면 거리 검증을 우회한다 (좌표 drift 무시).
 */

/**
 * phase × kind별 발사 허용 거리(m). lock 활성 경로 + lockless의 transfer/destination 경로.
 */
export const THRESHOLDS_M = {
  early: { transfer: 800, destination: 800, intermediate: 600 },
  imminent: { transfer: 400, destination: 400, intermediate: 300 },
} as const;

/**
 * lockless 경로의 intermediate kind 전용 widened 임계값(m).
 *
 * D1(#1207) hop estimator 미연결 시 fallback. sticky station 좌표 drift를 수용해
 * lock 활성 대비 ~2.6배 넓힘.
 */
export const LOCKLESS_INTERMEDIATE_THRESHOLDS_M = {
  early: 1200,
  imminent: 800,
} as const;

/**
 * D1 estimator 연동 시 사용. `currentHopIndex`/`payloadHopIndex` 차이가 이 값 이하면
 * 거리 검증을 우회하고 pass.
 */
export const LOCKLESS_HOP_WINDOW_TOLERANCE = 1;
