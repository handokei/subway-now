/**
 * R-10 (Epic #1008, #1168) — fusion 신호 우선순위 SSOT.
 *
 * `docs/research/r10-fusion-signal-priority.md` §4.2의 명시 trust table을 코드로 옮긴 단일 표.
 * 기존에는 우선순위가 `useFusedNearestStation`(771줄) 안에 if/else 5단계로 분산되어 있고,
 * `pickFusedStation`은 동점 시 `winnerPosScore >= winnerArrScore` 한 줄로 source 라벨을 결정했다.
 * 본 표는:
 *
 *   1) "어느 신호가 더 신뢰되는가"를 단일 배열로 명시 — 새 신호(wifi-ssid #913, sensor fusion #921)
 *      추가 시 표에 한 줄 끼우면 결정 트리가 명확.
 *   2) `pickFusedStation` 동점 tie-break에서 implicit `>=` 비교를 `getTierRank` lookup으로 교체.
 *      현 동작과 동치(position이 arrival보다 우선)지만 spec 위반 신호가 추가될 때 자동 정렬됨.
 *   3) tier가 결정되면 호출자가 측정/로그에 그 라벨을 사용할 수 있도록 export.
 *
 * 본 PR은 spec과 직접 매칭되는 (source, confidence) 조합만 등재. estimator override 단계
 * (`boarding-lock-interp`)와 `gps-only-underground` 강등은 `useFusedNearestStation`의 별도 layer에서
 * 처리되므로 표에 자리만 잡고 호출자는 변경하지 않는다 (B1/B2 미결인 동안 단계적 적용 — spec §6).
 */

import type { FusionConfidence, FusionSource } from '../../../shared/types/fusion';

/**
 * 단일 결정 단계 라벨. 숫자가 작을수록(=배열에서 앞일수록) 더 신뢰되는 신호.
 * 'wifi-ssid'는 #913 이후 추가될 단계로, 현재 코드 경로에서는 산출되지 않지만
 * 자리만 미리 박아둔다(미통합이라 결정 트리에 영향 없음).
 */
export type FusionTier =
  | 'wifi-ssid'
  | 'boarding-lock-train-match'
  | 'position-train-locked'
  | 'position-train'
  | 'fused-position'
  | 'fused-arrival-confirmed'
  | 'fused-arrival-arriving'
  | 'route-progress'
  | 'estimator-live-position'
  | 'estimator-arrival-eta'
  | 'estimator-reanchored-hop'
  | 'gps-only-underground'
  | 'gps-only';

/**
 * 명시 trust table — 더 앞일수록 신뢰 우선.
 * spec `docs/research/r10-fusion-signal-priority.md` §4.2와 1:1 대응.
 */
export const FUSION_TIER_PRIORITY: readonly FusionTier[] = [
  'wifi-ssid',
  'boarding-lock-train-match',
  'position-train-locked',
  'position-train',
  'fused-position',
  'fused-arrival-confirmed',
  'fused-arrival-arriving',
  'route-progress',
  'estimator-live-position',
  'estimator-arrival-eta',
  'estimator-reanchored-hop',
  'gps-only-underground',
  'gps-only',
] as const;

/**
 * tier → rank (0 = 최고 신뢰). 동률 비교를 단일 정수 비교로 환원.
 * `FUSION_TIER_PRIORITY` 배열 순서가 SSOT이므로 추가/재배열 시 별도 수정 불필요.
 */
export function getTierRank(tier: FusionTier): number {
  // indexOf는 readonly 배열에서도 안전. 표에 없으면 -1 → 정렬 시 최상위로 잘못 가지 않도록
  // Infinity(=최하위)로 환산.
  const idx = FUSION_TIER_PRIORITY.indexOf(tier);
  return idx >= 0 ? idx : Number.POSITIVE_INFINITY;
}

/**
 * `pickFusedStation`이 산출하는 (source, confidence) 조합을 단일 tier로 매핑한다.
 *
 * 매핑 규칙(spec §1.4와 일관):
 * - source='wifi-ssid'         → 'wifi-ssid'
 * - source='boarding-lock'     → 'boarding-lock-train-match'
 * - source='boarding-lock-interp' → 'estimator-live-position'
 *   (현 구현은 estimator override를 boarding-lock-interp 한 라벨로만 표시. ADR-008 stage별 세분화는
 *    후속 — spec §6 "B2 결정 전 estimator tier 세분화 보류".)
 * - source='position-train'    → 'position-train-locked' or 'position-train'
 *   (lock 활성 여부는 호출자 컨텍스트라 본 함수만으로는 구분 불가 → 보수적으로 'position-train' 반환.
 *    호출자가 lock 일치를 알고 있으면 직접 'position-train-locked' 산출.)
 * - source='position'          → 'fused-position'
 * - source='arrival'           → confidence='arrival-confirmed' → 'fused-arrival-confirmed'
 *                              → confidence='arrival-arriving'  → 'fused-arrival-arriving'
 * - source='route-progress'    → 'route-progress'
 * - source='gps' + confidence='gps-only-underground' → 'gps-only-underground'
 * - source='gps'               → 'gps-only'
 */
export function tierFor(source: FusionSource, confidence: FusionConfidence): FusionTier {
  switch (source) {
    case 'wifi-ssid':
      return 'wifi-ssid';
    case 'boarding-lock':
      return 'boarding-lock-train-match';
    case 'boarding-lock-interp':
      return 'estimator-live-position';
    case 'position-train':
      return 'position-train';
    case 'position':
      return 'fused-position';
    case 'arrival':
      return confidence === 'arrival-confirmed'
        ? 'fused-arrival-confirmed'
        : 'fused-arrival-arriving';
    case 'route-progress':
      return 'route-progress';
    case 'gps':
      return confidence === 'gps-only-underground' ? 'gps-only-underground' : 'gps-only';
  }
}
