import type { Station } from '../../../shared/types/station';

/**
 * 현재역 NAME과 LINE 배지의 정합성을 보장한다 (#2454, R2).
 *
 * `rawVariants`(useFusedNearestStation의 `variants`, 즉 raw GPS `useNearestStation`
 * 출력)는 fused 파이프라인과 독립적으로 매 polling마다 live 위치를 반영해 갱신된다.
 * fused 파이프라인이 stall되어 표시용 `effectiveOrigin`이 lock/tripOrigin 등 stale
 * fallback으로 물러나면, rawVariants는 여전히 다른(live) 역을 가리켜 NAME(예: 뚝섬)과
 * LINE 배지(예: 잠실의 2·8호선)가 서로 다른 역을 가리키는 모순이 생긴다.
 *
 * rawVariants가 effectiveOrigin과 같은 역(정확히 같은 name — findNearestStation의
 * variants도 `s.name === result.station.name`으로 grouping)일 때만 원본 다중 노선
 * 배지를 쓰고, 다르면 effectiveOrigin 단일 노선으로 강등해 배지가 항상 표시된 NAME과
 * 같은 역을 가리키도록 보장한다.
 */
export function resolveOriginLineVariants(
  effectiveOrigin: Station | null,
  rawVariants: Station[],
  isCustomOrigin: boolean,
): Station[] {
  if (!effectiveOrigin) return [];
  if (isCustomOrigin || rawVariants.length <= 1) return [effectiveOrigin];
  if (rawVariants[0].name !== effectiveOrigin.name) return [effectiveOrigin];
  return rawVariants;
}
