import { useEffect } from 'react';
import type { Station } from '../../../shared/types/station';
import { saveStationToWidget, clearWidgetStation } from '../api/widgetStorage';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('WidgetMirror');

// 위젯이 사용자 체감 가능한 최소 거리 단위. widgetStorage.ts의 dedupe bucket과 동일하게 맞춰
// useEffect deps가 같은 50m 안에서는 안정적으로 유지되도록 한다. 다른 bucket으로 재정의하면
// effect 재실행이 dedupe 게이트와 어긋나 무용한 호출이 발생한다.
const DISTANCE_BUCKET_M = 50;

function distanceBucket(distanceKm: number | undefined | null): number | null {
  if (distanceKm == null) return null;
  const distanceM = Math.max(0, Math.round(distanceKm * 1000));
  return Math.floor(distanceM / DISTANCE_BUCKET_M);
}

/**
 * nearest station 결과를 iOS 홈 위젯에 단방향 mirror.
 *
 * - station 존재 (500m 반경 내 감지) → `saveStationToWidget`
 * - station 없음 → `clearWidgetStation` 으로 위젯이 "감지 중" fallback 표시
 *
 * 위젯 lifecycle은 destination/route 상태와 분리되어 항상 nearest station을 반영한다(#1094).
 * deps는 50m bucket으로 정규화해 GPS tick마다 불필요한 effect 재실행을 막는다.
 */
export function useWidgetMirror(
  station: Station | null | undefined,
  distanceKm: number | null | undefined,
): void {
  const bucket = distanceBucket(distanceKm);
  const stationId = station?.id ?? null;

  useEffect(() => {
    if (!station || distanceKm == null) {
      clearWidgetStation().catch((e) => logger.error('clear 실패:', e));
      return;
    }
    saveStationToWidget(station, distanceKm).catch((e) =>
      logger.error('save 실패:', e),
    );
    // station/distanceKm은 ref로만 사용. stationId/bucket이 effect 재실행 트리거.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId, bucket]);
}
