import type { TravelDirection } from '../types/exitSide';
import type { PlatformExitSide, TerminusRelation } from '../types/platformExitSide';
import { lookupDirectionalExitSide, lookupPlatformExitSide } from './platformExitSideLookup';
import { findStationById } from './stationLookup';

export type ExitSideResolution =
  | { side: PlatformExitSide; reason: 'directional' | 'platform' }
  | { side: null; reason: 'directional-undetermined' | 'no-data' | 'unknown-station-id' };

interface ResolveExitSideInput {
  stationId: string;
  direction?: TravelDirection;
  terminus: TerminusRelation;
}

/**
 * #3177 — 역 id로 하차문 좌/우를 판정한다. 이름 조회가 없어 환승역에서 다른 노선 값을 빌려오지 않는다.
 *   1) stations.json에 없는 id → unknown-station-id
 *   2) direction이 있고 방향별 위키 항목이 있으면 그 값(근거 없으면 null=directional-undetermined, 구조값으로 대체 금지)
 *   3) 그 외 승강장 구조 기반 값(platform), 데이터가 없으면 no-data
 */
export function resolveExitSideForStation({
  stationId,
  direction,
  terminus,
}: ResolveExitSideInput): ExitSideResolution {
  if (!findStationById(stationId)) return { side: null, reason: 'unknown-station-id' };
  const directional = direction ? lookupDirectionalExitSide(stationId, direction, terminus) : null;
  if (directional) {
    const { side } = directional;
    return side ? { side, reason: 'directional' } : { side: null, reason: 'directional-undetermined' };
  }
  const platformSide = lookupPlatformExitSide(stationId);
  return platformSide ? { side: platformSide, reason: 'platform' } : { side: null, reason: 'no-data' };
}
