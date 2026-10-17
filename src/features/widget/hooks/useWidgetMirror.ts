import { useEffect } from 'react';
import type { Station } from '../../../shared/types/station';
import { saveStationToWidget, type WidgetTripContext } from '../api/widgetStorage';
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
 * - station 없음 (loading / locationUncertain 같은 일시적 null) → **no-op**.
 *   위젯은 마지막 알려진 역 + savedAt freshness 로 stale UX 를 자가 처리한다.
 *   여기서 UserDefaults 를 비우면 transient null 마다 위젯이 "감지 중" 으로 고착되는
 *   회귀가 발생한다 (#1239). 명시적 clear 가 필요한 경로(알람 종료 등)는 별도
 *   `clearWidgetStation` caller(`stationNotification`, `SharedGroupAdapter`)가 담당.
 *
 * #1781 — trip 활성 시 `tripContext`를 전달하면 현재역·환승역·도착역을 위젯에 추가 표시.
 * trip 비활성(tripContext=undefined)이면 기존 nearest station UI 유지 (regression 차단).
 * deps는 50m bucket + tripContext 식별자로 정규화해 GPS tick마다 불필요한 effect 재실행을 막는다.
 */
export function useWidgetMirror(
  station: Station | null | undefined,
  distanceKm: number | null | undefined,
  tripContext?: WidgetTripContext,
): void {
  const bucket = distanceBucket(distanceKm);
  const stationId = station?.id ?? null;
  // deps 식별자: trip 활성 여부 + 목적지 + 환승역. 값이 바뀔 때만 effect 재실행.
  const tripKey = tripContext
    ? `${String(tripContext.tripActive)}:${tripContext.currentStationName}:${tripContext.destinationName}:${tripContext.nextTransferName ?? ''}`
    : null;

  useEffect(() => {
    if (!station || distanceKm == null) {
      return;
    }
    saveStationToWidget(station, distanceKm, undefined, undefined, tripContext ?? undefined).catch((e) =>
      logger.error('save 실패:', e),
    );
    // station/distanceKm/tripContext은 ref로만 사용. stationId/bucket/tripKey가 effect 재실행 트리거.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId, bucket, tripKey]);
}
