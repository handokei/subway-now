import { useTrainPositions } from './useTrainPositions';
import type { LinePositions } from '../api/positionApi';
import type { LineNumber } from '../types/station';
import type { PositionProvider } from '../providers/types';

/**
 * 활성 호선 K=3 동시 폴링 — Phase 3 Stage 1+2의 useFusedNearestStation 패턴 동일.
 * Rules of Hooks 제약으로 슬롯 개수 고정. activeLines가 그보다 적으면 null 슬롯으로 no-op.
 *
 * 호출 비용은 useTrainPositions 모듈 싱글톤 캐시(positionCache)가 line 단위로 dedup —
 * useFusedNearestStation과 동시에 같은 호선을 폴링해도 한 번만 호출됨.
 */
export function useActiveLinePositions(
  activeLines: LineNumber[],
  provider?: PositionProvider,
): (LinePositions | null)[] {
  const l0 = activeLines[0] ?? null;
  const l1 = activeLines[1] ?? null;
  const l2 = activeLines[2] ?? null;
  const p0 = useTrainPositions(l0, provider);
  const p1 = useTrainPositions(l1, provider);
  const p2 = useTrainPositions(l2, provider);
  return [p0.positions, p1.positions, p2.positions];
}
