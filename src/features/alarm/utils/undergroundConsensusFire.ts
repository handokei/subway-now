/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: stationPipeline.ts / backgroundLocationTask.ts와 동일하게 여러
 * features(nearest-station/widget)의 util을 조합하는 orchestrator다. Phase 5 enforce 모드에서
 * file-level disable로 옵트인.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { processLocationUpdate } from './stationPipeline';
import { getBoardingLock } from './boardingLockStorage';
import { getFiredAlarms } from './notificationState';
import { persistBgFireResult } from './bgFirePersist';
import { isMinimalAlarmEnabled } from '../../../shared/constants/debugFlags';
import { isUndergroundProfile } from '../../nearest-station/utils/bgLocationProfile';
import { undergroundSSOTConsensus } from '../../nearest-station/utils/undergroundSSotConsensus';
import { pollUndergroundArrivalIfDue } from '../../nearest-station/tasks/bgUndergroundArrivalPoll';
import { getCurrentWifiSsid } from '../../nearest-station/utils/wifiSsidNative';
import { lookupStationBySsid } from '../../nearest-station/utils/wifiSsidLookup';
import {
  getLatestAccelerometerSnapshot,
  classifyAccelerometerPattern,
} from '../../nearest-station/utils/accelerometerFingerprint';
import {
  getCurrentCellularTech,
  startCellularTechUpdates,
  classifyCellularEnvironment,
} from '../../nearest-station/utils/cellularTech';
import { DESTINATION_KEY, SLEEP_MODE_KEY, ROUTE_KEY } from '../../../shared/constants/storageKeys';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('UndergroundConsensusFire');

/**
 * #2381 — 지하(GPS dead) BG 자가감지. `backgroundLocationTask.ts`의 gate-accuracy 연속 실패 →
 * 'underground' profile 강등(#2345) + BoardingLock 존재(탑승 line 확정) tick에서만 진입한다.
 *
 * WiFi SSID로 candidate station을 얻고(BG에서 nil이 흔하지만 기존 position-upload 경로와 동일
 * 패턴으로 시도 — 새 신호 아님), 그 station의 arvlCd(Gap A, `bgUndergroundArrivalPoll`) +
 * accelerometer + cellular 환경 vote를 `undergroundSSOTConsensus`(FG `useFusedNearestStation`과
 * 동일 순수 util, Gap B)로 평가한다. 채택되면 기존 `processLocationUpdate`(stationPipeline)에
 * 그 station 좌표를 흘려 기존 검증된 fire-once/sleep/dedup 게이트를 그대로 통과시킨다 —
 * 새 발사 로직 발명 없음.
 *
 * **스펙 편차 (issue #2381 대비)**: 이슈 본문은 "탑승 line 다음 waypoint 역" arrival 폴링을
 * 제안했으나, `undergroundSSOTConsensus`(FG와 동일 계약)는 arrival이 candidate station과
 * 동일 station이어야 station-pair가 성립한다(`findStationaryTrain(arrival, candidate.line)`) —
 * 아직 도달하지 않은 역의 arrival로는 candidate를 형성할 수 없고, BG는 positionTrainResult
 * (GPS 기반 fusion)도 없어 대체 후보가 없다. 따라서 폴링 대상을 WiFi 후보 station으로 조정 —
 * WiFi 미해상 tick은 폴링 자체를 skip한다(quota 보호, "조건부 폴링" 의도는 보존).
 * 대안(route 다음 waypoint를 candidate로 승격)은 GPS 없는 dead-reckoning 추정이라
 * ADR-015 §5(GPS input reject) 정신에 위배될 소지가 있어 배제했다.
 *
 * BG task는 alarmEvent/nearest 후처리(firedAlarms bookkeeping, BG_LAST_STATION_KEY, 위젯 저장)를
 * `backgroundLocationTask.ts` 안에서 GPS 경로와 별도로 수행한다 — 그 로직을 그대로 재사용하지
 * 않고 여기서 다시 수행하는 이유는 이 함수가 GPS 좌표 없이(consensus station 좌표로) 완결된
 * 독립 경로이기 때문(surgical: 기존 GPS 경로 코드를 건드리지 않는다).
 *
 * 반환 없음(void) — 게이트 미충족/consensus 미채택은 조용히 no-op, 호출자(backgroundLocationTask)는
 * 항상 `return`으로 이번 tick을 마친다(GPS 좌표가 무효하므로 GPS 경로로 fall through하지 않음).
 */
export async function evaluateUndergroundConsensusFire(): Promise<void> {
  if (!isMinimalAlarmEnabled()) return;

  const lock = await getBoardingLock();
  if (!lock) return;

  const underground = await isUndergroundProfile();
  if (!underground) return;

  const wifiSsid = await getCurrentWifiSsid().catch(() => null);
  const wifiStation = lookupStationBySsid(wifiSsid);
  if (!wifiStation) return;

  const destJson = await AsyncStorage.getItem(DESTINATION_KEY);
  if (!destJson) return;

  let destinationRaw: unknown;
  try {
    destinationRaw = JSON.parse(destJson);
  } catch {
    logger.error('목적지 JSON 파싱 실패');
    return;
  }
  if (
    !destinationRaw ||
    typeof destinationRaw !== 'object' ||
    typeof (destinationRaw as { id?: unknown }).id !== 'string'
  ) {
    logger.error('목적지에 id가 없음');
    return;
  }
  const destination = destinationRaw as Station;

  const [sleepJson, routeJson] = await Promise.all([
    AsyncStorage.getItem(SLEEP_MODE_KEY),
    AsyncStorage.getItem(ROUTE_KEY),
  ]);
  const sleepMode = sleepJson ? JSON.parse(sleepJson) === true : false;
  const storedRoute: Route = routeJson ? JSON.parse(routeJson) : null;

  const arrival = await pollUndergroundArrivalIfDue(wifiStation.name, wifiStation.line);

  // #1542 (ADR-016 S9) 패턴 재사용 — cellular listener도 idempotent 시작 보장 (native module
  // 내부 가드, 미지원/실패는 graceful null).
  startCellularTechUpdates();
  const cellularEnvironmentVote = classifyCellularEnvironment(getCurrentCellularTech());
  const accelerometerPattern = classifyAccelerometerPattern(getLatestAccelerometerSnapshot());

  const consensus = undergroundSSOTConsensus({
    wifiStation,
    // BG는 GPS 기반 candidate-train fusion(trackTrainProgress)이 없어 positionTrainResult 부재.
    // WiFi station pair 단독 + env vote(cellular/accel)로 quorum 평가(보수적 — PR 본문 명시).
    positionTrainResult: null,
    arrival,
    cellularEnvironmentVote,
    accelerometerPattern,
    tripStartedAt: lock.boardedAt,
  });
  if (!consensus) return;

  const firedAlarms = await getFiredAlarms(destination.id);
  const { alarmEvent, nearest } = await processLocationUpdate({
    lat: consensus.station.lat,
    lng: consensus.station.lng,
    destination,
    firedAlarms,
    sleepMode,
    storedRoute,
    speedMps: null,
    source: 'bg',
    // #327 — consensus로 채택된 station은 GPS가 아닌 train 데이터 기반 확정.
    fusionSource: 'position-train',
  });

  await persistBgFireResult({ alarmEvent, nearest, destination, firedAlarms, storedRoute });
}
