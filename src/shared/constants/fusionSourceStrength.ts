/**
 * #2204 (ADR-026 ①잔여, 적대적 검증 HOLE 대응) — fusion "실관측 신호" 게이트.
 *
 * `fusionConfidenceStrength.ts`(#1541)와 같은 원칙을 `FusionSource`(신호 *출처*) 축에 적용한다.
 * 실관측(강) source: backend-ssot / boarding-lock / boarding-lock-interp / position-train /
 * position(station 단위 trainSttus 직접 매칭) / arrival(도착 API 매칭) / wifi-ssid — 모두 GPS
 * 좌표 자체가 아닌 독립 신호(트랙 위치, 도착 API, SSID 매칭, 사용자 명시 의향)로 확정된 출처.
 * 약(추정) source: gps(거리 기반 최근접) / route-progress(1D map matching 시간 적분) — 둘 다
 * GPS 좌표만으로 산출되며 실측 검증이 없다.
 *
 * 이전 게이트(`useStationAlarm.ts` phase 게이트, `useFusedNearestStation.ts` trainProgressing)는
 * `estimator 전략`(stationProgressEstimator.strategy가 시간 적분인지)으로 게이팅했다. 그런데
 * fusion `source`가 route-progress/gps인데 estimator strategy는 시간 적분이 아닌 조합(예:
 * live-position 실패 후 cascade가 route-progress로 fallback)이 가능해 estimator 전략만 보는
 * 게이트는 이 조합을 놓친다 — 실제로 판정에 쓰인 신호(`source`)를 직접 보는 것이 SSOT.
 */
import type { FusionSource } from '../types/fusion';

export const STRONG_FUSION_SOURCE: ReadonlySet<FusionSource> = new Set<FusionSource>([
  'backend-ssot',
  'boarding-lock',
  'boarding-lock-interp',
  'position-train',
  'position',
  'arrival',
  'wifi-ssid',
]);

export function isStrongFusionSource(source: FusionSource | undefined | null): boolean {
  return source != null && STRONG_FUSION_SOURCE.has(source);
}
