import { useMemo, useRef } from 'react';
import type { LineNumber } from '../../../shared/types/station';
import type {
  CongestionDirection,
  CongestionEntry,
} from '../../../shared/types/congestion';
import type { CongestionProvider } from '../providers/types';
import { createCongestionProvider } from '../providers/factory';

interface UseCongestionParams {
  stationName: string | null | undefined;
  line: LineNumber | null | undefined;
  direction: CongestionDirection | null | undefined;
  /** 명시 시각 — 기본값은 hook 호출 시점. 테스트/디버그에서 주입한다. */
  now?: Date;
}

/**
 * 현재 역+방향+시간대에 해당하는 시간대 평균 혼잡도를 반환한다.
 *
 * - 입력 필수값 중 하나라도 비어 있으면 `null` (UI는 미표시).
 * - lookup 실패(미커버 노선/역/시간대)도 `null`.
 * - 시간대 평균 데이터는 앱 lifetime 동안 정적이라 polling 없이 useMemo로 충분.
 *
 * #1097 P0-A PoC. UI 진입(Live Activity / HomeScreen)은 후속 PR.
 */
export function useCongestion({
  stationName,
  line,
  direction,
  now,
}: UseCongestionParams): CongestionEntry | null {
  const providerRef = useRef<CongestionProvider | null>(null);
  if (!providerRef.current) {
    providerRef.current = createCongestionProvider();
  }

  return useMemo(() => {
    if (!stationName || !line || !direction) return null;
    const at = now ?? new Date();
    return providerRef.current!.getCongestion(stationName, line, direction, at);
  }, [stationName, line, direction, now]);
}
