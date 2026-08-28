/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: `bgPositionTrainFire.ts` / `undergroundConsensusFire.ts`와 동일하게
 * widget feature의 util을 조합하는 orchestrator다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { alarmKey } from './stationAlarm';
import { setFiredAlarms } from './notificationState';
import { saveStationToWidget } from '../../widget/api/widgetStorage';
import { buildWidgetTripContext } from '../../widget/utils/buildTripContext';
import { ALARM_EVENT_KEY, BG_LAST_STATION_KEY } from '../../../shared/constants/storageKeys';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import type { PipelineResult } from './stationPipeline';

export interface PersistBgFireResultInputs extends PipelineResult {
  destination: Station;
  firedAlarms: Set<string>;
  storedRoute: Route;
}

/**
 * BG 자가감지 발사 경로(`bgPositionTrainFire.ts` / `undergroundConsensusFire.ts`)가 공유하는
 * `processLocationUpdate` 후처리 — firedAlarms bookkeeping, `ALARM_EVENT_KEY` 저장,
 * `BG_LAST_STATION_KEY` 저장, 위젯 forward. 두 경로 모두 GPS 좌표 없이(train/consensus 좌표로)
 * 완결된 독립 경로라 `backgroundLocationTask.ts`의 GPS 경로 후처리와 별도로 이 후처리를
 * 각자 수행했는데, 그 후처리 로직 자체가 완전히 동일해 SonarCloud 신규 중복으로 추출했다.
 */
export async function persistBgFireResult({
  alarmEvent,
  nearest,
  destination,
  firedAlarms,
  storedRoute,
}: PersistBgFireResultInputs): Promise<void> {
  if (alarmEvent) {
    firedAlarms.add(alarmKey(alarmEvent));
    await Promise.all([
      setFiredAlarms(destination.id, firedAlarms),
      AsyncStorage.setItem(ALARM_EVENT_KEY, JSON.stringify(alarmEvent)),
    ]);
  }

  if (nearest) {
    await AsyncStorage.setItem(
      BG_LAST_STATION_KEY,
      JSON.stringify({
        station: nearest.station,
        distanceKm: nearest.distanceKm,
        timestamp: Date.now(),
      }),
    );
    const tripContext = buildWidgetTripContext({
      destination,
      currentStation: nearest.station,
      route: storedRoute,
    });
    await saveStationToWidget(nearest.station, nearest.distanceKm, undefined, undefined, tripContext);
  }
}
