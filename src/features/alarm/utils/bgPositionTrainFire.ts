/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: `undergroundConsensusFire.ts`와 동일하게 여러 features
 * (nearest-station/route/arrival/widget)의 util을 조합하는 orchestrator다. Phase 5 enforce
 * 모드에서 file-level disable로 옵트인.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { processLocationUpdate } from './stationPipeline';
import { getBoardingLock } from './boardingLockStorage';
import { isPendingTrainCode } from '../../../shared/constants/boardingLock';
import { getFiredAlarms } from './notificationState';
import { persistBgFireResult } from './bgFirePersist';
import { isMinimalAlarmEnabled } from '../../../shared/constants/debugFlags';
import { passesLockedStationGate } from '../../nearest-station/utils/lockedStationGate';
import { pollTrainPositionsIfDue } from '../../nearest-station/tasks/bgPositionTrainPoll';
import { pickCandidateTrains } from '../../arrival/utils/pickCandidateTrains';
import { computeRouteArc } from '../../route/utils/routeProgress';
import { trackTrainProgress } from '../../route/utils/trackTrainProgress';
import { getStationById, type Route } from '../../../shared/utils/stationRoute';
import { DESTINATION_KEY, SLEEP_MODE_KEY, ROUTE_KEY, BG_LAST_STATION_KEY } from '../../../shared/constants/storageKeys';
import type { Station } from '../../../shared/types/station';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('BgPositionTrainFire');

/**
 * #2383 (Part of #2381) — position-train-lock BG 발사 경로.
 *
 * lock 활성(trainCode 존재) tick에서 realtimePosition API(`fetchTrainPositions`)로 그 trainCode
 * 열차의 실제 현재 역(`statnNm`)을 직접 조회해 발사한다. `isUndergroundProfile()`/`wifiStation`
 * 게이트를 걸지 않는다 — 환경(지상/지하) 오분류(2026-08-26 덤프: `surface=91%`)와 GPS accuracy
 * 상태에 완전히 독립적인 것이 이 경로의 핵심이다. 호출자(`backgroundLocationTask.ts`)는 GPS
 * accuracy 게이트보다 앞서 이 함수를 먼저 시도해야 한다 — 그래야 GPS가 "정상"(9~40m,
 * gate-accuracy 미강등)인데 지하라 위치가 틀린 케이스에서도 이 경로가 개입할 수 있다
 * (이번 덤프가 증명한 정확한 실패 지점).
 *
 * arrival API(`getArrival`)는 재사용하지 않는다 — `ArrivalInfo`에는 열차의 실제 currentStation이
 * 없어(폴링 대상 역으로 접근 중인 열차만 반환) waypoint 근사로는 열차를 실제로 못 찾는 근본
 * 결함이 있었다(#2383 최초 구현 rework). `pickCandidateTrains`(realtimePosition 전용, FG와 동일
 * 계약)로 각 train의 실제 `statnNm`을 그대로 `CandidateTrain.currentStationName`에 매핑한다.
 *
 * `trackTrainProgress`(순수 함수, GPS 게이트 없음)를 재사용 — `positionTrainResult`
 * (`useFusedNearestStation.ts:859`)는 GPS 게이트(864·882)가 있어 재사용하지 않는다(issue #2383
 * 명시 정정). userLocation은 넘기지 않는다 — 지하에서 무의미하고, lock.trainCode sticky 매칭이
 * disambiguation을 대체한다. lock 게이트(노선/arc-window/forward-only) 검증은
 * `passesLockedStationGate`로 별도 수행(`useFusedNearestStation.ts:924~943`와 동일 로직 추출).
 *
 * 반환값 — true: 이번 tick에서 station을 채택해 `processLocationUpdate`까지 완료(호출자는 GPS
 * 경로로 fall through하지 말고 이번 tick을 마쳐야 함). false: 게이트 미충족/후보 없음 —
 * 호출자는 기존 GPS 파이프라인(또는 #2382 WiFi/consensus 경로)으로 계속 진행.
 */
export async function evaluatePositionTrainFire(): Promise<boolean> {
  if (!isMinimalAlarmEnabled()) return false;

  const lock = await getBoardingLock();
  // #2407 — trainCode pending(fallback lock, 미확정) 상태에서는 이 경로(realtimePosition 정밀추적)를
  // skip한다. pending sentinel을 실 trainCode처럼 매칭에 넣으면 항상 미매칭이라 false negative만
  // 쌓인다 — 호출자(backgroundLocationTask)가 기존 GPS/route 파이프라인으로 graceful degrade.
  if (!lock?.trainCode || isPendingTrainCode(lock.trainCode)) return false;

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

  // pickCandidateTrains anchor — BG_LAST_STATION(진행한 마지막 확인 역)이 있으면 그 역,
  // 없으면 탑승역. anchorStationName은 window(±3역, DEFAULT_WINDOW_STATIONS) 후보 필터링에만
  // 쓰이므로 정확한 station 객체가 아니라 이름만 필요하다.
  let anchorStationName = origin.name;
  if (lastStationJson) {
    try {
      const parsed = JSON.parse(lastStationJson) as { station?: { name?: string } };
      if (parsed?.station?.name) anchorStationName = parsed.station.name;
    } catch {
      // graceful — anchor는 탑승역 유지.
    }
  }

  const positions = await pollTrainPositionsIfDue(lock.boardingLine);
  if (!positions) return false;

  const candidates = pickCandidateTrains({
    positions: [positions],
    line: lock.boardingLine,
    anchorStationName,
  });
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
    // #327 — lock trainCode+realtimePosition으로 확정된 station은 GPS가 아닌 train 데이터 기반 확정.
    fusionSource: 'position-train',
  });

  await persistBgFireResult({ alarmEvent, nearest, destination, firedAlarms, storedRoute });

  return true;
}
