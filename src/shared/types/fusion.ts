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
 *
 * #903 (Seam G) — 'gps-only-underground' 추가. GPS-only 결과인데 기압계 dP/dt가 지하 진입을
 * 시사하면 강등 라벨을 붙여 early/transfer 알람 발사를 보류한다(stationAlarm 게이트).
 * gps-only와 동급 신뢰지만 지하 fix는 wifi/cell 삼각측량 fallback이 보고된 좌표일 가능성이 높아
 * 알람 정확도 측면에서 별도 분기가 필요하다.
 *
 * #913 (Epic #912) — 'wifi-ssid' 추가. 지하에서 wifi가 잡힐 때 SSID 패턴 직접 매칭으로
 * 역을 확정한다(예: `T_subway_용마산`). GPS 무관 100% 확정 신호이므로 cascade의
 * 첫 단계로 사용되며 boarding-lock과 동급 신뢰로 취급(별도 source 필드로 식별).
 */
export type FusionConfidence =
  | 'boarding-lock'
  | 'boarding-lock-interp'
  | 'position-train'
  | 'arrival-confirmed'
  | 'arrival-arriving'
  | 'route-progress'
  | 'gps-only'
  | 'gps-only-underground'
  | 'wifi-ssid';

/**
 * fusion 신호 출처. position-train이 가장 정확(특정 trainNo 추적 → 현재역),
 * position은 station 단위 trainSttus 직접 매칭, arrival은 추정(곧 도착),
 * route-progress는 트랙 1D 진행도, gps는 거리 기반.
 * 알람 dedup·로깅에서 source별 정책 분기에 사용.
 *
 * #913 (Epic #912) — 'wifi-ssid'는 지하 SSID 매칭 결과. cascade의 가장 앞 단계로
 * 사용되며 GPS/arrival 호출 없이 역을 확정한다.
 */
export type FusionSource =
  | 'boarding-lock'
  | 'boarding-lock-interp'
  | 'position-train'
  | 'position'
  | 'arrival'
  | 'route-progress'
  | 'gps'
  | 'wifi-ssid';
