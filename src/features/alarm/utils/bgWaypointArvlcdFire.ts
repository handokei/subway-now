/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: `bgPositionTrainFire.ts`와 동일하게 여러 features(nearest-station/
 * arrival/widget)의 util을 조합하는 orchestrator다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { processLocationUpdate } from './stationPipeline';
import { getBoardingLock } from './boardingLockStorage';
import { isPendingTrainCode } from '../../../shared/constants/boardingLock';
import { getFiredAlarms } from './notificationState';
import { persistBgFireResult } from './bgFirePersist';
import { alarmKey, resolveAllTargets, type CurrentTarget } from './stationAlarm';
import { isMinimalAlarmEnabled } from '../../../shared/constants/debugFlags';
import { isImminentByArrivalCode } from '../../arrival/utils/imminentArrivalSignal';
import { pollWaypointArrivalIfDue } from '../../nearest-station/tasks/bgWaypointArrivalPoll';
import { findStationByNameAndLine } from '../../../shared/utils/stationRoute';
import { DESTINATION_KEY, SLEEP_MODE_KEY, ROUTE_KEY } from '../../../shared/constants/storageKeys';
import { logWaypointArvlcdFireDiagnostic } from './alarmLog';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import type { AlarmPhaseId } from '../../../shared/types/alarm';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('BgWaypointArvlcdFire');

/**
 * waypoint 종류별 "완료" 판정 phase. `resolveAllTargets`가 반환하는 `CurrentTarget.alarmType`
 * (`stationAlarm.ts`)과 `ALARM_PHASES`(`alarmPhases.ts`)의 관계: transfer waypoint는 도착역이
 * 아니므로 etaSeconds가 항상 null이라 `early` phase만 평가 가능(`evaluateAlarmPhase` 참고,
 * imminent는 `isFinal`(최종 waypoint)에만 평가된다). destination waypoint는 최종 leg라 `early`→
 * `imminent` 순으로 진행하며, `imminent`가 곧 "곧 도착" 사용자 노출 알람이므로 완료 기준이다.
 */
const COMPLETION_PHASE_ID: Record<CurrentTarget['alarmType'], AlarmPhaseId> = {
  transfer: 'early',
  destination: 'imminent',
};

/** waypoint가 이미 사용자에게 발사됐는지 — 다음 미발사 waypoint로 폴링 대상을 진행시키기 위함. */
function isTargetAlreadyFired(firedAlarms: Set<string>, target: CurrentTarget): boolean {
  return firedAlarms.has(alarmKey({ phaseId: COMPLETION_PHASE_ID[target.alarmType], stationName: target.name }));
}

/**
 * #2480 — FG #396(`useStationAlarm`)의 waypoint arvlCd 직폴 신호를 BG spine으로 이식.
 *
 * 배경: FG는 다음 waypoint의 도착정보를 직접 폴링해 lock된 열차가 ENTERING/ARRIVED면 그 신호를
 * `evaluateAlarmPhase`(#396) 판정에 흘려보낸다 — GPS/WiFi/열차위치매칭 전부 무관, 셀룰러로 지하도
 * OK. BG(취침/잠금=실사용 무대)엔 이 클린 신호가 없어 `#2381`(WiFi 필수)/`#2383`(전체 열차위치
 * 매칭)만으로는 커버 못 하는 케이스(9/2 저녁 용마산 도착 0건)가 남는다. 이 함수는 그 arvlCd
 * 폴링 자체를 BG에 이식한다 — FG의 imminent 직결 배선(early phase gate 우회)까지 그대로 옮기지는
 * 않는다. 대신 `processLocationUpdate`(전체 파이프라인: `evaluateAlarmPhase`의 early/imminent
 * 순차 + hop-window/sleep/dedup 게이트)에 정확한 waypoint 좌표를 주입해 재사용한다 — 첫 발사는
 * `early`(destination도 동일), 이어지는 tick에서 `imminent`가 발사된다. 사용자 체감(정확한
 * waypoint에서 알람)은 FG와 동등하되, 기존 dedup/게이트 경로를 우회하지 않는 것이 이 선택의 이유.
 *
 * `#2383`(`evaluatePositionTrainFire`)과 병행 — 대체가 아니다. 호출자(`backgroundLocationTask.ts`)
 * 는 `#2383`을 먼저 시도하고 실패(false)한 tick에서만 이 함수를 시도한다. 둘 다 gate-free이며
 * fired(true)면 그 tick의 나머지 파이프라인(GPS 경로 등)으로 fall through하지 않는다.
 *
 * 경계: 이 spine은 `lock.trainCode`를 소비만 한다 — 어느 leg든 lock.trainCode가 real(PENDING
 * sentinel 아님)이면 그 waypoint를 발사 대상으로 삼는다. 환승 후 re-lock(`#2323`)은 이 이슈
 * 밖이다 — 이 함수는 re-lock 결과(트립 진행 중 lock이 갱신된 경우)를 소비할 뿐, re-lock 자체를
 * 수행하지 않는다.
 *
 * 반환값 — true: arvlCd로 내 열차의 도착이 확증돼 `processLocationUpdate`까지 완료(파이프라인
 * 내부 dedup/hop-window/sleep 게이트로 이번 tick에 실제 발사는 없었을 수 있음 — `evaluatePositionTrainFire`
 * 와 동일하게 "채택 성공"이 반환 기준). 호출자는 GPS 경로로 fall through하지 말고 이번 tick을
 * 마쳐야 한다. false: 게이트 미충족/도착 미확증 — 호출자는 기존 파이프라인으로 계속 진행.
 */
export async function evaluateWaypointArvlcdFire(): Promise<boolean> {
  if (!isMinimalAlarmEnabled()) return false;

  const lock = await getBoardingLock();
  // real trainCode만 소비 — pending(fallback lock, 미확정) sentinel은 imminent 판정에 쓸 수 없다
  // (`isImminentByArrivalCode`는 trainCode 매칭이므로 sentinel은 항상 미매칭 → false negative만
  // 쌓인다. `evaluatePositionTrainFire`의 #2407과 동일 가드).
  if (!lock?.trainCode || isPendingTrainCode(lock.trainCode)) {
    void logWaypointArvlcdFireDiagnostic(!lock?.trainCode ? 'skip-no-lock' : 'skip-pending-traincode', {
      hasTrainCode: !!lock?.trainCode,
    });
    return false;
  }

  const destJson = await AsyncStorage.getItem(DESTINATION_KEY);
  if (!destJson) {
    void logWaypointArvlcdFireDiagnostic('skip-no-destination');
    return false;
  }

  let destinationRaw: unknown;
  try {
    destinationRaw = JSON.parse(destJson);
  } catch {
    logger.error('목적지 JSON 파싱 실패');
    void logWaypointArvlcdFireDiagnostic('skip-bad-destination');
    return false;
  }
  if (
    !destinationRaw ||
    typeof destinationRaw !== 'object' ||
    typeof (destinationRaw as { id?: unknown }).id !== 'string'
  ) {
    logger.error('목적지에 id가 없음');
    void logWaypointArvlcdFireDiagnostic('skip-bad-destination');
    return false;
  }
  const destination = destinationRaw as Station;

  const routeJson = await AsyncStorage.getItem(ROUTE_KEY);
  const storedRoute: Route = routeJson ? JSON.parse(routeJson) : null;
  if (!storedRoute) {
    void logWaypointArvlcdFireDiagnostic('skip-no-route');
    return false;
  }

  const targets = resolveAllTargets(storedRoute, destination.name);
  const firedAlarms = await getFiredAlarms(destination.id);
  const nextTarget = targets.find((t) => !isTargetAlreadyFired(firedAlarms, t));
  if (!nextTarget) {
    void logWaypointArvlcdFireDiagnostic('skip-no-next-target');
    return false;
  }

  const arrival = await pollWaypointArrivalIfDue(nextTarget.name, nextTarget.approachLine);
  if (!isImminentByArrivalCode(arrival, lock.trainCode)) {
    void logWaypointArvlcdFireDiagnostic('skip-not-imminent', { waypointName: nextTarget.name });
    return false;
  }

  const targetStation = findStationByNameAndLine(nextTarget.name, nextTarget.approachLine);
  if (!targetStation) {
    void logWaypointArvlcdFireDiagnostic('skip-no-target-station', { waypointName: nextTarget.name });
    return false;
  }

  const sleepJson = await AsyncStorage.getItem(SLEEP_MODE_KEY);
  const sleepMode = sleepJson ? JSON.parse(sleepJson) === true : false;

  const { alarmEvent, nearest } = await processLocationUpdate({
    lat: targetStation.lat,
    lng: targetStation.lng,
    destination,
    firedAlarms,
    sleepMode,
    storedRoute,
    speedMps: null,
    source: 'bg',
    // #327 — arvlCd 직폴(GPS 무관)로 확정된 station은 GPS가 아닌 열차 도착정보 기반 확정.
    fusionSource: 'position-train',
  });

  await persistBgFireResult({ alarmEvent, nearest, destination, firedAlarms, storedRoute });

  void logWaypointArvlcdFireDiagnostic('engaged', { waypointName: nextTarget.name });

  // #2383(evaluatePositionTrainFire)과 동일 계약 — arvlCd로 채택에 성공(파이프라인 실행 완료)
  // 했다는 사실 자체가 반환 기준. 내부 dedup/hop-window/sleep 게이트가 이번 tick 발사를
  // suppress했더라도(alarmEvent=null) 이미 GPS-independent 신호로 위치가 확정된 tick이므로
  // 호출자는 GPS 파이프라인으로 fall through하지 않아야 한다.
  return true;
}
