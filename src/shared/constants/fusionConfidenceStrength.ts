/**
 * #1541 — fusion confidence "강 신호" 게이트 (S8, Epic #1533 / ADR-016).
 *
 * 강 신호: 실측 신호 기반(boarding-lock = 사용자 명시 의향, position-train = 트랙 1D
 * 진행도, arrival-confirmed = 도착 확정, wifi-ssid = SSID 매칭). 약 신호: 시간 적분
 * 또는 거리 기반 추정(gps-only, route-progress, *-interp 등).
 *
 * 용례:
 *  - customOrigin SSOT override (S8): 강 신호로 다른 station을 가리킬 때만 사용자
 *    명시 의향(customOrigin) unlock. ADR-014 §4 "사용자 명시 의향 동급 보호" 원칙상
 *    약한 신호로 덮어쓰지 않는다.
 *  - 후속 게이트에서 동일 set를 재사용해 cross-feature 일관성을 보장.
 */
import type { FusionConfidence } from '../types/fusion';

export const STRONG_FUSION_CONFIDENCE: ReadonlySet<FusionConfidence> = new Set<FusionConfidence>([
  'boarding-lock',
  'position-train',
  'arrival-confirmed',
  'wifi-ssid',
]);

export function isStrongFusionConfidence(confidence: FusionConfidence | undefined | null): boolean {
  return confidence != null && STRONG_FUSION_CONFIDENCE.has(confidence);
}
