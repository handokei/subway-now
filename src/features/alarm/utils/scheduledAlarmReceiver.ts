/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 사전 예약 알람 fire-time 재검증 게이트(#1704)가 features/route의
 * routeToWaypoints를 호출해 사용자 currentStation 기반 hop distance를 계산한다. 알람 발사 정확도가
 * route의 segment 순회 로직(intermediate name 추출 포함)에 본질적으로 의존하므로 직접 import가
 * 자연스러움. 후속 PR에서 routeToWaypoints를 src/shared/utils/로 추출하거나 orchestration 슬라이스로
 * 이전 예정. ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';
import {
  getFiredAlarms,
  setFiredAlarms,
  setLastFiredAlarmStationName,
} from './notificationState';
import {
  ACTIVE_TRIP_KEY,
  DESTINATION_KEY,
  ROUTE_KEY,
  STICKY_STATION_KEY,
} from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
import { recordFiredAlarm } from './prescheduledMetrics';
import {
  deriveSafetyNetWaypoints,
  readSafetyNetData,
  type SafetyNetNotificationData,
} from './safetyNetScheduler';
import { getTripStartedAt } from './tripStartStorage';
import { alarmKey } from './stationAlarm';
import { logSuppressedSafetyNetRevalidation } from './alarmLog';
import { readBackendSsotMirror } from './backendSsotMirror';
import { getStationById, isSameStationName } from '../../../shared/utils/stationRoute';
import { routeToWaypoints } from '../../route/utils/routeWaypoints';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';

const logger = createLogger('ScheduledAlarmReceiver');

interface DestinationMeta {
  /** firedAlarms를 격리하는 데 쓰이는 destination id(#462). */
  id: string | null;
  /** safety-net waypoint 산출에 쓰이는 destination 역명. */
  name: string | null;
}

/**
 * 현재 trip의 destination을 AsyncStorage에서 1회 읽고 파싱한다. id/name을 한 번의 parse로
 * 함께 추출 — `revalidateSafetyNetAlarm`(name 필요)과 fired-set 격리(id 필요) 양쪽이 같은
 * DESTINATION_KEY를 각자 다시 읽고 파싱하면 파싱 실패 조건이 항상 동일해 한쪽 catch 분기가
 * 구조적으로 도달 불가능해진다 — 단일 파서로 통합해 그 문제를 원천 제거.
 */
function parseDestinationMeta(raw: string | null): DestinationMeta {
  if (!raw) return { id: null, name: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      id: typeof parsed?.id === 'string' ? parsed.id : null,
      name: typeof parsed?.name === 'string' ? parsed.name : null,
    };
  } catch {
    return { id: null, name: null };
  }
}

function safeParseRoute(raw: string | null): Route {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Route;
  } catch {
    return null;
  }
}

/**
 * #1704 — position-mismatch 게이트 임계값. 사용자 currentStation에서 fire 대상 stationName까지
 * 이 hop 수 이상 떨어져 있으면 suppress.
 *
 * 5 hop 선택 근거: 2호선/1호선 환승 평균 2-3 hop 사이, BG fire 정상 임계(1역 전)보다 충분히 여유.
 * evidence: 14:04 신촌(2-018) → 종로3가(1-027) trip에서 사용자 신촌 위치인데 종로3가 미리
 * fire(약 6+ hop 미래) — 5 hop 임계로 차단.
 *
 * mirror가 5 min 이상 stale이면 게이트 자체를 skip(보수 fallback) — false negative 차단.
 */
const POSITION_MISMATCH_HOP_THRESHOLD = 5;
const POSITION_MISMATCH_MIRROR_STALE_MS = 5 * 60 * 1_000;

/**
 * #1704 — sticky station 영속화 데이터에서 Station을 안전하게 추출.
 * 형식: `{station: Station, lockedAt: number}` JSON (useStickyStation.writePersistedLock과 일치).
 * 파싱 실패 / 필수 필드 결손 시 null 반환 — fallback path가 graceful skip.
 *
 * stations.json id로 단일 조회해 stale data와 정합성 확보 — sticky write 시점 이후 stations.json
 * 갱신이 있어도 게이트 결정이 최신 데이터 기준으로 일관.
 */
function readStickyStation(raw: string | null): Station | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { station?: { id?: unknown } } | null;
    const id = parsed?.station?.id;
    if (typeof id !== 'string' || id.length === 0) return null;
    return getStationById(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * #1704 — route 위 두 stationName의 hop distance(진행 방향 +).
 *
 * `currentStation`을 origin으로 두고 `routeToWaypoints`로 intermediate + transfer + destination
 * 시퀀스(진행 방향 순서 보존)를 구성한다. 시퀀스 내 `targetName` 첫 매칭 index가 곧 hop distance
 * (1-based: 1 = 바로 다음 역). `target`이 시퀀스에 없으면 null (게이트 skip). 같은 역(currentName
 * 자체)이면 0 반환은 본 함수가 아닌 caller에서 currentName==targetName 체크로 처리한다 — 본 함수의
 * 시퀀스는 currentStation 이후만 포함하므로 targetName==currentName이면 시퀀스에 없어 null이 된다.
 *
 * routeToWaypoints는 currentStation이 route 위 어느 leg에 속하든 그 leg부터 destination까지의
 * intermediate를 펼친다. 환승 route에선 환승역 이후 leg도 자동으로 펼쳐진다.
 *
 * 같은 stationName이 여러 번 등장하는 순환 route(2호선 등)는 첫 매칭이 가장 이른 hop이므로
 * 보수적으로 작은 hop distance를 반환 — false positive(suppress) 방지.
 */
function computeHopDistance(
  route: NonNullable<Route>,
  destinationName: string,
  currentStation: Station,
  targetName: string,
): number | null {
  const waypoints = routeToWaypoints(route, destinationName, currentStation);
  /* istanbul ignore next -- routeToWaypoints는 destination waypoint를 항상 push하므로
   * 실제 도달 불가능. defensive guard. */
  if (waypoints.length === 0) return null;
  // currentName(==currentStation.name)은 시퀀스에 포함되지 않음 — routeToWaypoints가
  // intermediates(fromId 제외 ~ toId 제외)를 펼치기 때문. 따라서 sequence[0]은 currentStation의
  // "다음 역"이고, index N은 N+1번째 hop이므로 1-based hop distance = idx + 1.
  const targetIdx = waypoints.findIndex((w) => isSameStationName(w.stationName, targetName));
  if (targetIdx === -1) return null;
  return targetIdx + 1;
}

/**
 * #1704 — fire 대상이 사용자 currentStation보다 N hop 이상 미래인지 판정.
 *
 * source 우선순위:
 *   1) backend SSoT mirror (`BACKEND_SSOT_MIRROR_KEY`) — currentStationId가 가장 신뢰.
 *      receivedAt이 5 min 이상 stale이면 사용 안 함(보수 fallback).
 *   2) sticky station (`STICKY_STATION_KEY`) — name만 보유. mirror 부재 시 fallback.
 *
 * 둘 다 부재/stale이면 'pass' (기존 게이트만 적용). 위치 정보 부재로 false suppress 발생 위험이
 * 크기 때문에 보수적으로 skip.
 *
 * 위치 source 결정 후 `computeHopDistance` 결과가 threshold 이상이면 'suppress'. 음수/0/null은
 * pass (이미 통과한 역이거나 route 외 역은 별 게이트가 담당).
 */
async function evaluatePositionMismatch(input: {
  route: NonNullable<Route>;
  destinationName: string;
  targetStationName: string;
}): Promise<'pass' | 'suppress'> {
  const [mirror, stickyRaw] = await Promise.all([
    readBackendSsotMirror(),
    AsyncStorage.getItem(STICKY_STATION_KEY),
  ]);

  // mirror 신뢰성: receivedAt 5 min 이내일 때만 사용.
  let currentStation: Station | null = null;
  if (mirror && Date.now() - mirror.receivedAt <= POSITION_MISMATCH_MIRROR_STALE_MS) {
    currentStation = getStationById(mirror.currentStationId) ?? null;
  }
  // mirror가 stale이거나 매핑 실패면 sticky로 fallback.
  if (currentStation === null) {
    currentStation = readStickyStation(stickyRaw);
  }
  // 둘 다 부재 — 보수적으로 게이트 skip (기존 동작 유지).
  if (currentStation === null) return 'pass';

  // 사용자가 이미 target에 도달 — 본 게이트는 skip (기존 게이트가 fire 적절성 판정).
  if (isSameStationName(currentStation.name, input.targetStationName)) return 'pass';

  const hopDistance = computeHopDistance(
    input.route,
    input.destinationName,
    currentStation,
    input.targetStationName,
  );
  // route 외 / 매칭 실패는 별 게이트가 담당 — 본 게이트는 skip.
  if (hopDistance === null) return 'pass';
  // hop이 threshold 이상 미래면 suppress. threshold 미만(이미 통과 or 가까움)은 pass.
  return hopDistance >= POSITION_MISMATCH_HOP_THRESHOLD ? 'suppress' : 'pass';
}

/**
 * safety-net 알람(#2089)의 fire-time 재검증.
 *
 * OS가 예약된 시각에 발사한 알람이 *현재* 시점에도 유효한지 확인한다.
 *
 * 검증 순서:
 *   1) tripStart 존재 — trip이 종료되지 않았다.
 *   2) parsed.tripToken이 현재 ACTIVE_TRIP_KEY와 일치 — 다른(이전/차기) trip의 잔여 발화가 아니다.
 *      (구 route-sig 비교의 대체 — 2026-07-31 매트릭스 "route-sig staleness: trip 재등록 시
 *      재예약으로 대체 가능"과 동형: safetyNetScheduler는 trip 전환마다 항상 전체 재예약하므로
 *      tripToken이 다르면 그 자체로 stale 판정에 충분하다.)
 *   3) 파싱된 stationName + kind가 현재 route waypoint 시퀀스 안에 있음 — 방어 검증.
 *   4) (#1704) 사용자 currentStation 대비 fire 대상이 N hop 미래가 아님 — backend SSoT mirror +
 *      sticky station fallback으로 위치 결정. 둘 다 부재/stale이면 보수적으로 게이트 skip.
 *
 * 한 가지라도 실패하면 reason과 함께 alarmLog에 적재하고 outcome='suppress'를 반환한다.
 * 호출자는 fired set / lastStationName 갱신을 skip해 stale 알람이 후속 상태를 오염시키지 않게 한다.
 *
 * pass 시 `destinationId`도 함께 반환한다 — DESTINATION_KEY를 이 함수가 이미 읽고 파싱했으므로
 * 호출자가 fired-set 격리(#462)를 위해 같은 키를 또 읽고 파싱할 필요가 없다({@link parseDestinationMeta}).
 */
interface RevalidateSafetyNetResult {
  outcome: 'pass' | 'suppress';
  /** outcome='pass'일 때만 non-null 의미 있음 — suppress 시 fired-set 작업을 하지 않으므로 null. */
  destinationId: string | null;
}

async function revalidateSafetyNetAlarm(
  parsed: SafetyNetNotificationData,
): Promise<RevalidateSafetyNetResult> {
  const suppress = (
    reason: Parameters<typeof logSuppressedSafetyNetRevalidation>[0]['reason'],
  ): RevalidateSafetyNetResult => {
    logSuppressedSafetyNetRevalidation({ reason, stationName: parsed.station });
    return { outcome: 'suppress', destinationId: null };
  };

  const tripStart = await getTripStartedAt();
  if (tripStart === null) {
    return suppress('revalidate-no-trip');
  }

  const [routeRaw, destRaw, activeTripToken] = await Promise.all([
    AsyncStorage.getItem(ROUTE_KEY),
    AsyncStorage.getItem(DESTINATION_KEY),
    AsyncStorage.getItem(ACTIVE_TRIP_KEY),
  ]);
  if (activeTripToken === null || activeTripToken !== parsed.tripToken) {
    return suppress('revalidate-trip-token-mismatch');
  }

  const route: Route = safeParseRoute(routeRaw);
  const destMeta = parseDestinationMeta(destRaw);
  if (!route || !destMeta.name) {
    return suppress('revalidate-trip-token-mismatch');
  }

  // 방어 검증: parsed station+kind가 현재 waypoint 시퀀스에 존재해야 한다.
  const waypoints = deriveSafetyNetWaypoints(route, destMeta.name);
  if (
    !waypoints.some(
      (w) => w.kind === parsed.kind && isSameStationName(w.stationName, parsed.station),
    )
  ) {
    return suppress('revalidate-waypoint-mismatch');
  }

  // #1704 — 위치 게이트: 사용자 currentStation 대비 fire 대상이 N hop 이상 미래면 suppress.
  const positionGate = await evaluatePositionMismatch({
    route: route as NonNullable<Route>,
    destinationName: destMeta.name,
    targetStationName: parsed.station,
  });
  if (positionGate === 'suppress') {
    return suppress('revalidate-position-mismatch');
  }

  return { outcome: 'pass', destinationId: destMeta.id };
}

/**
 * 사전 예약된 safety-net 알림이 OS에 의해 발사된 직후 클라이언트 상태를 갱신한다.
 * 사전 예약 알람은 클라이언트 콜백을 거치지 않으므로, 이 함수가 FG/BG 양쪽 발화 모두에 대한
 * 상태 동기화 단일 진입점이다.
 *
 * - FIRED_ALARMS_KEY에 `early:station`/`imminent:station` 둘 다 추가 → FG 복귀 시 useStationAlarm
 *   하이드레이션 및 후속 silent push 처리가 해당 station을 이미 발화된 것으로 간주해 중복 발화를
 *   막는다. safetyNetScheduler는 phase 개념이 없는 단일 fire지만, dedup key 공간은 live GPS 기반
 *   FG/BG 발화 경로(early/imminent 2 phase)와 공유되므로 둘 다 마킹해야 교차 dedup이 보장된다.
 * - LAST_FIRED_ALARM_STATION_NAME_KEY를 해당 역 이름으로 갱신 → BGAppRefreshTask가
 *   다음 사이클에서 Arrival API를 올바른 기준역으로 호출.
 */
export async function reconcileScheduledAlarmDelivery(
  request: Notifications.NotificationRequest,
  actualFireMs: number = Date.now(),
): Promise<void> {
  await recordFiredAlarm({ identifier: request.identifier, actualFireMs });

  const parsed = readSafetyNetData(request);
  if (!parsed) return;

  const result = await revalidateSafetyNetAlarm(parsed);
  if (result.outcome === 'suppress') {
    // #1354 — suppress 시 OS scheduled queue에 동일 identifier가 남아 다음 ETA에 또
    // 발사되어 정적 misfire가 영구 재발한다. 사전 예약은 fire-and-forget이므로 명시 cancel 필요.
    // cancelScheduledNotificationAsync는 이미 발사된 항목에도 안전.
    await Notifications.cancelScheduledNotificationAsync(request.identifier);
    // #1924 — delivered tray에서도 제거. cancelScheduledNotificationAsync는 pending queue만
    // 대상이라 이미 OS가 자체 fire 한 항목은 delivered tray에 그대로 남는다. 사용자가
    // swipe-dismiss 하지 않는 한 다음 FG 복귀 drain 시 같은 identifier를 또 read → 같은
    // reason으로 다시 suppress → alarm log 무한 재적재 (2026-06-27 dump 56회 evidence).
    await Notifications.dismissNotificationAsync(request.identifier);
    return;
  }

  // destinationId가 없으면 이미 trip이 종료/변경된 알람의 잔여 발화 — 상태 갱신 스킵.
  // setLastFiredAlarmStationName은 trip 종속성이 약하므로 유지한다(다음 사이클 기준역 갱신용).
  if (result.destinationId) {
    const fired = await getFiredAlarms(result.destinationId);
    // early/imminent 둘 다 마킹 — silent push 채널/live GPS 채널과 동일 dedup key 공간 공유(#1367).
    fired.add(alarmKey({ phaseId: 'early', stationName: parsed.station, occurrenceIdx: parsed.occurrenceIdx }));
    fired.add(alarmKey({ phaseId: 'imminent', stationName: parsed.station, occurrenceIdx: parsed.occurrenceIdx }));
    await setFiredAlarms(result.destinationId, fired);
  }
  await setLastFiredAlarmStationName(parsed.station);
}

/**
 * presented tray에 남아있는 사전 예약 알람들을 일괄 reconcile한다.
 * fired set은 한 번 read해서 누적 후 한 번만 write — N번 round-trip 회피.
 */
async function drainDeliveredScheduledAlarms(): Promise<void> {
  let presented: Notifications.Notification[];
  try {
    presented = await Notifications.getPresentedNotificationsAsync();
  } catch (e) {
    logger.error('delivered 알람 조회 실패:', e);
    return;
  }

  // safety-net BG-fired 알람도 ledger에 fire ts 기록. Notification.date(epoch ms)가
  // OS의 실제 발사 시각 — drain 시점(=FG resume)이 아닌 발사 시점을 정확히 측정.
  for (const n of presented) {
    const fireMs = typeof n.date === 'number' ? n.date : Date.now();
    await recordFiredAlarm({ identifier: n.request.identifier, actualFireMs: fireMs });
  }

  // safety-net 항목은 발사 시점 재검증을 거친다. suppress인 경우 fired set / lastStationName
  // 갱신에 포함하지 않아 stale 알람이 후속 상태(BG arrival 기준역 등)를 오염시키지 않게 한다.
  // destinationId는 pass 항목의 revalidate 결과에서 얻는다 — 모두 같은 시점의 DESTINATION_KEY를
  // 읽으므로 항목 간 값은 동일하다(마지막 pass 항목 기준으로 충분).
  const accepted: Array<{ parsed: SafetyNetNotificationData; destinationId: string | null }> = [];
  for (const n of presented) {
    const parsed = readSafetyNetData(n.request);
    if (!parsed) continue;
    const result = await revalidateSafetyNetAlarm(parsed);
    if (result.outcome === 'suppress') {
      // #1354 — drain 경로도 reconcile과 동형으로 suppress 시 OS queue cancel. 같은 identifier를
      // OS가 보존하면 다음 ETA마다 재발사되어 영구 misfire 재발.
      await Notifications.cancelScheduledNotificationAsync(n.request.identifier);
      // #1924 — drain은 직전 getPresentedNotificationsAsync로 delivered tray를 read한 항목을
      // 처리한다. suppress 시 pending queue 만 cancel하면 같은 tray entry가 정리되지 않아 다음
      // FG 복귀 drain 시 또 read → 같은 reason으로 또 suppress → alarm log 재적재
      // (2026-06-27 14:03 trip end 후 14:04~15:48 사이 7 FG 복귀 × 8 entry = 56회 evidence).
      await Notifications.dismissNotificationAsync(n.request.identifier);
      continue;
    }
    accepted.push({ parsed, destinationId: result.destinationId });
  }

  const destinationId = accepted.length > 0 ? accepted[accepted.length - 1].destinationId : null;
  let lastStationName: string | null = null;
  if (destinationId) {
    const fired = await getFiredAlarms(destinationId);
    let firedChanged = false;
    for (const { parsed } of accepted) {
      const keys = [
        alarmKey({ phaseId: 'early', stationName: parsed.station, occurrenceIdx: parsed.occurrenceIdx }),
        alarmKey({ phaseId: 'imminent', stationName: parsed.station, occurrenceIdx: parsed.occurrenceIdx }),
      ];
      for (const key of keys) {
        if (!fired.has(key)) {
          fired.add(key);
          firedChanged = true;
        }
      }
      lastStationName = parsed.station;
    }
    if (firedChanged) await setFiredAlarms(destinationId, fired);
  } else {
    // destinationId 미설정 — fired set 갱신은 스킵하고 lastStationName만 추출.
    for (const { parsed } of accepted) {
      lastStationName = parsed.station;
    }
  }
  if (lastStationName) await setLastFiredAlarmStationName(lastStationName);
}

export interface ScheduledAlarmListenerHandle {
  remove: () => void;
}

let registered: ScheduledAlarmListenerHandle | null = null;
let initialDrainPromise: Promise<void> | null = null;

/**
 * 마운트 시점에 시작된 첫 drain의 완료 Promise.
 * useStationAlarm 하이드레이션이 firedAlarms를 읽기 전에 이 promise를 await해서
 * cold start 직후 drain ↔ hydration race로 인한 중복 발화를 막는다.
 * 리스너가 아직 등록되지 않은 경우 즉시 resolve.
 */
export function awaitInitialScheduledAlarmDrain(): Promise<void> {
  return initialDrainPromise ?? Promise.resolve();
}

/**
 * 사전 예약 safety-net 알림 수신 리스너 등록. 멱등 — 중복 호출은 첫 핸들을 그대로 반환한다.
 *
 * 두 발화 경로를 모두 커버한다:
 * 1) FG 수신 — addNotificationReceivedListener가 즉시 reconcile.
 * 2) BG 발사 후 FG 복귀 — AppState 'active' 진입 시 delivered tray를 drain.
 *    (addNotificationReceivedListener는 BG 발화분을 replay하지 않음.)
 * 등록 시점에도 1회 drain해 콜드 스타트 직전에 발사된 알람을 흡수한다.
 */
export function registerScheduledAlarmListener(): ScheduledAlarmListenerHandle {
  if (registered) return registered;

  initialDrainPromise = drainDeliveredScheduledAlarms();

  const notifSub = Notifications.addNotificationReceivedListener((notification) => {
    void reconcileScheduledAlarmDelivery(
      notification.request,
      typeof notification.date === 'number' ? notification.date : Date.now(),
    );
  });

  const onAppStateChange = (state: AppStateStatus): void => {
    if (state === 'active') void drainDeliveredScheduledAlarms();
  };
  const appStateSub = AppState.addEventListener('change', onAppStateChange);

  registered = {
    remove: () => {
      notifSub.remove();
      appStateSub.remove();
      registered = null;
      initialDrainPromise = null;
    },
  };
  return registered;
}
