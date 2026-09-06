/**
 * #1935 — silent push 채널에서 widget storage update를 호출하는 단일 진입점.
 *
 * `feedback_whileinuse_must_work` paradigm 충족 — WhileInUse 권한 사용자도 silent push
 * 도달 시점에 BG widget이 갱신되도록 보장. backend silent push는 권한에 무관하게 도달하므로
 * 본 채널에 widget update를 wire해 BG GPS 미작동 보완.
 *
 * 동작:
 *  1. SSoT 또는 BG context로 station/distance 결정 (`lookupStationFromSsot`)
 *  2. destination/route 기반 tripContext 구성 (#1781 widget tripContext wire)
 *  3. `saveStationToWidget(station, distance, savedAt, { force: true }, tripContext)`
 *     `force: true` — silent push 도달은 명시적 freshness 갱신 trigger (dedupe 우회).
 *
 * 결정 불가 시 no-op (위젯 마지막 정상 상태 유지). 예외는 caller로 전파하지 않는다.
 */

import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import type { BgLastStationContext, SsotStationInput } from '../../../shared/types/widgetRefresh';
import { createLogger } from '../../../shared/utils/logger';
import { saveStationToWidget } from '../api/widgetStorage';
import { buildWidgetTripContext } from './buildTripContext';
import { lookupStationFromSsot } from './lookupStationFromSsot';

const logger = createLogger('SilentPushWidget');

/**
 * Wire entry — silent push handler가 호출. SSoT 우선, BG context fallback.
 *
 * tripContext.currentStationName은 resolved station 기준(SSoT가 advance한 권위 역).
 * nextTransferName은 route에서 첫 환승(direct route → undefined). destination 없으면
 * tripActive=false로 stamp해 widget UI가 nearest-station 모드로 fallback.
 *
 * @param ssot       silent push payload `ssot` 슬라이스 (currentStationId/Line). null이면 BG fallback만.
 * @param bgContext  BG_LAST_STATION_KEY mirror. WhileInUse 사용자는 보통 null.
 * @param destination DESTINATION_KEY parsed. null이면 trip 비활성.
 * @param route      ROUTE_KEY parsed. null이면 환승 정보 없음(direct로 간주).
 * @param savedAt    widget storage savedAt epoch ms. 기본 Date.now().
 */
export async function updateWidgetFromSilentPush(
  ssot: SsotStationInput | null | undefined,
  bgContext: BgLastStationContext | null,
  destination: Station | null,
  route: Route,
  savedAt: number = Date.now(),
): Promise<void> {
  try {
    const resolved = lookupStationFromSsot(ssot, bgContext);
    if (!resolved) {
      logger.info('skip: station resolve failed (no SSoT, no BG context)');
      return;
    }
    const tripContext = buildWidgetTripContext({
      destination,
      currentStation: resolved.station,
      route,
      allowInactive: true,
    });
    await saveStationToWidget(
      resolved.station,
      resolved.distanceKm,
      savedAt,
      { force: true },
      tripContext,
    );
    // resolved.station은 항상 존재(Station) → currentStation null 분기로 undefined가 반환될 수 없다.
    logger.info(`widget updated: ${resolved.station.name} (tripActive=${tripContext?.tripActive})`);
  } catch (e) {
    logger.warn('update failed:', e);
  }
}
