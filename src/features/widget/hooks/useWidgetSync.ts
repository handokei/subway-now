import { useEffect } from 'react';
import { saveStationToWidget, clearWidgetStation } from '../api/widgetStorage';
import type { Station } from '../../../shared/types/station';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('widgetSync');

/**
 * GPS 기반 fused 현재역을 destination/route와 무관하게 위젯에 동기화한다 (#1079).
 *
 * 위젯은 (stationName, lineColor, distanceM) 3개만 표시하므로 trip 진행 여부와
 * 독립적으로 갱신되어야 한다. 기존에는 HomeScreen useEffect가
 * `!destination`이면 early-return하면서 saveStationToWidget까지 함께 막혀,
 * 목적지 미설정/다른 탭/HomeScreen 미진입 시 위젯이 "감지 중"에서 갱신되지 않았다.
 *
 * dedupe(station.id 기준)는 widgetStorage 내부 모듈 스코프에서 처리된다.
 */
export function useWidgetSync(station: Station | null, distanceKm: number | null): void {
  useEffect(() => {
    if (!station || distanceKm == null) {
      clearWidgetStation().catch((e) => logger.error('위젯 해제 실패:', e));
      return;
    }
    saveStationToWidget(station, distanceKm).catch((e) =>
      logger.error('위젯 저장 실패:', e),
    );
  }, [station, distanceKm]);
}
