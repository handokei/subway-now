/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: `undergroundConsensusFire.ts`와 동일하게 여러 features
 * (nearest-station/route/arrival/widget)의 util을 조합하는 orchestrator다. Phase 5 enforce
 * 모드에서 file-level disable로 옵트인.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { processLocationUpdate } from './stationPipeline';
import { alarmKey } from './stationAlarm';
import { getBoardingLock } from './boardingLockStorage';
import { getFiredAlarms, setFiredAlarms } from './notificationState';
import { isMinimalAlarmEnabled } from '../../../shared/constants/debugFlags';
import { passesLockedStationGate } from '../../nearest-station/utils/lockedStationGate';
import { pollUndergroundArrivalIfDue } from '../../nearest-station/tasks/bgUndergroundArrivalPoll';
import { computeRouteArc } from '../../route/utils/routeProgress';
import { forwardWaypointStations } from '../../route/utils/forwardWaypointStations';
import { trackTrainProgress } from '../../route/utils/trackTrainProgress';
import { buildCandidateTrainsFromArrival } from '../../arrival/utils/buildCandidateTrainsFromArrival';
import { saveStationToWidget } from '../../widget/api/widgetStorage';
import { buildWidgetTripContext } from '../../widget/utils/buildTripContext';
import { getStationById, type Route } from '../../../shared/utils/stationRoute';
import {
  DESTINATION_KEY,
  SLEEP_MODE_KEY,
  ROUTE_KEY,
  ALARM_EVENT_KEY,
  BG_LAST_STATION_KEY,
} from '../../../shared/constants/storageKeys';
import type { Station } from '../../../shared/types/station';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('BgPositionTrainFire');

/** 스펙 "다음 1~2역" — quota 보호를 위해 폴링은 첫 waypoint 하나만 수행(#2381 25s 쿨다운 계승). */
const FORWARD_WAYPOINT_LOOKAHEAD = 2;

/**
 * #2383 (Part of #2381) — position-train-lock BG 발사 경로.
 *
 * lock 활성(trainCode 존재) tick에서 arvlCd로 "그 trainCode 열차가 지금 어느 역"을 직접 판정해
 * 발사한다. `isUndergroundProfile()`/`wifiStation` 게이트를 걸지 않는다 — 환경(지상/지하) 오분류
 * (2026-08-26 덤프: `surface=91%`)와 GPS accuracy 상태에 완전히 독립적인 것이 이 경로의 핵심이다.
 * 호출자(`backgroundLocationTask.ts`)는 GPS accuracy 게이트보다 앞서 이 함수를 먼저 시도해야 한다
 * — 그래야 GPS가 "정상"(9~40m, gate-accuracy 미강등)인데 지하라 위치가 틀린 케이스에서도 이
 * 경로가 개입할 수 있다(이번 덤프가 증명한 정확한 실패 지점).
 *
 * `trackTrainProgress`(순수 함수, GPS 게이트 없음)를 재사용 — `positionTrainResult`
 * (`useFusedNearestStation.ts:859`)는 GPS 게이트(864·882)가 있어 재사용하지 않는다(issue #2383
 * 명시 정정). lock 게이트(노선/arc-window/forward-only) 검증은 `passesLockedStationGate`로
 * 별도 수행(`useFusedNearestStation.ts:924~943`와 동일 로직 추출).
 *
 * 반환값 — true: 이번 tick에서 station을 채택해 `processLocationUpdate`까지 완료(호출자는 GPS
 * 경로로 fall through하지 말고 이번 tick을 마쳐야 함). false: 게이트 미충족/후보 없음 —
 * 호출자는 기존 GPS 파이프라인(또는 #2382 WiFi/consensus 경로)으로 계속 진행.
 */
export async function evaluatePositionTrainFire(): Promise<boolean> {
  if (!isMinimalAlarmEnabled()) return false;

  const lock = await getBoardingLock();
  if (!lock || !lock.trainCode) return false;

  const destJson = await AsyncStorage.getItem(DESTINATION_KEY);
  if (!destJson) return false;

  let destinationRaw: unknown;
  try {
    destinationRaw = JSON.parse(destJson);
  } catch {
    logger.error('목적지 JSON 파싱 실패');
    return false;
  }
  if (
    !destinationRaw ||
    typeof destinationRaw !== 'object' ||
    typeof (destinationRaw as { id?: unknown }).id !== 'string'
  ) {
    logger.error('목적지에 id가 없음');
    return false;
  }
  const destination = destinationRaw as Station;

  const [sleepJson, routeJson, lastStationJson] = await Promise.all([
    AsyncStorage.getItem(SLEEP_MODE_KEY),
    AsyncStorage.getItem(ROUTE_KEY),
    AsyncStorage.getItem(BG_LAST_STATION_KEY),
  ]);
  const sleepMode = sleepJson ? JSON.parse(sleepJson) === true : false;
  const storedRoute: Route = routeJson ? JSON.parse(routeJson) : null;
  if (!storedRoute) return false;

  const origin = getStationById(lock.boardingStationId);
  if (!origin) return false;

  const arc = computeRouteArc(storedRoute, origin, destination);
  const arcStations = arc?.stations ?? [];
  if (arcStations.length === 0) return false;

  // 폴링 anchor — BG_LAST_STATION(진행한 마지막 확인 역)이 있으면 그 역, 없으면 탑승역.
  let anchorStationId = lock.boardingStationId;
  if (lastStationJson) {
    try {
      const parsed = JSON.parse(lastStationJson) as { station?: { id?: string } };
      if (parsed?.station?.id) anchorStationId = parsed.station.id;
    } catch {
      // graceful — anchor는 boardingStationId 유지.
    }
  }

  const waypoints = forwardWaypointStations(arcStations, anchorStationId, FORWARD_WAYPOINT_LOOKAHEAD);
  if (waypoints.length === 0) return false;
  const [waypoint] = waypoints;

  const arrival = await pollUndergroundArrivalIfDue(waypoint.name, waypoint.line);
  if (!arrival) return false;

  const candidates = buildCandidateTrainsFromArrival(arrival, waypoint.name, lock.trainCode);
  const trainProgress = trackTrainProgress({
    candidates,
    lastConfirmedTrainNo: lock.trainCode,
    segmentStations: arcStations,
    boardingStationId: lock.boardingStationId,
  });
  if (!trainProgress) return false;

  const { currentStation } = trainProgress;
  if (!passesLockedStationGate(currentStation, lock, arcStations)) return false;

  const firedAlarms = await getFiredAlarms(destination.id);
  const { alarmEvent, nearest } = await processLocationUpdate({
    lat: currentStation.lat,
    lng: currentStation.lng,
    destination,
    firedAlarms,
    sleepMode,
    storedRoute,
    speedMps: null,
    source: 'bg',
    // #327 — lock trainCode+arvlCd로 확정된 station은 GPS가 아닌 train 데이터 기반 확정.
    fusionSource: 'position-train',
  });

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

  return true;
}
