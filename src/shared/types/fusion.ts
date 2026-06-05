/**
 * Fusion 신호 분류 type — nearest-station fusion(`pickFusedStation`)에서 산출되는 결과의
 * confidence/source 식별자. cross-feature(alarm 알림 dedup, debug UI 등)에서 참조되므로
 * shared로 추출 (#890, Phase 5).
 */

/**
 * fusion 결과 신뢰도 — UI/로깅용. 점수 ≥ 100이면 confirmed, 0 < x < 100이면 arriving.
 * 신호원(arrival/position/route-progress)은 source 필드로 분리 식별.
 * 'route-progress'는 1D map matching 진행도 기반(Phase A) — GPS 점프에 면역이지만
 * 도착/위치 API와 달리 자체 검증 신호가 아니라 별도 confidence로 둔다.
 */
export type FusionConfidence =
  | 'boarding-lock'
  | 'boarding-lock-interp'
  | 'position-train'
  | 'arrival-confirmed'
  | 'arrival-arriving'
  | 'route-progress'
  | 'gps-only';

/**
 * fusion 신호 출처. position-train이 가장 정확(특정 trainNo 추적 → 현재역),
 * position은 station 단위 trainSttus 직접 매칭, arrival은 추정(곧 도착),
 * route-progress는 트랙 1D 진행도, gps는 거리 기반.
 * 알람 dedup·로깅에서 source별 정책 분기에 사용.
 */
export type FusionSource =
  | 'boarding-lock'
  | 'boarding-lock-interp'
  | 'position-train'
  | 'position'
  | 'arrival'
  | 'route-progress'
  | 'gps';
