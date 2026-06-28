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
import { parseScheduledAlarmIdentifier } from './alarmScheduler';
import {
  getFiredAlarms,
  setFiredAlarms,
  setLastFiredAlarmStationName,
} from './notificationState';
import {
  DESTINATION_KEY,
  ROUTE_KEY,
  STICKY_STATION_KEY,
} from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
import { recordFiredAlarm } from './prescheduledMetrics';
import {
  TRIP_BOUND_ALARM_PREFIX,
  getRegisteredTripRouteSig,
  parseTripBoundAlarmIdentifier,
} from './tripBoundScheduler';
import { getTripStartedAt } from './tripStartStorage';
import { alarmKey, resolveAllTargets } from './stationAlarm';
import {
  parseBoardingLockAlarmIdentifier,
  routeSignature,
  getRegisteredBlRouteSig,
  BOARDING_LOCK_ALARM_PREFIX,
} from './boardingLockScheduler';
import { logSuppressedTbaRevalidation } from './alarmLog';
import { readBackendSsotMirror } from './backendSsotMirror';
import {
  getStationById,
  isSameStationName,
} from '../../../shared/utils/stationRoute';
import { routeToWaypoints } from '../../route/utils/routeWaypoints';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import type { AlarmPhaseId } from './alarmPhases';

const logger = createLogger('ScheduledAlarmReceiver');

/**
 * 현재 trip의 destinationId를 AsyncStorage에서 읽는다. firedAlarms를 destinationId로
 * 격리하기 위해(#462) 발화 reconcile 시점에 필요하다. 파싱 실패 또는 미설정이면 null.
 */
async function getCurrentDestinationId(): Promise<string | null> {
  const raw = await AsyncStorage.getItem(DESTINATION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

interface ParsedAlarmIdentifier {
  prefix: 'alarm' | 'tba' | 'bl';
  phaseId: string;
  stationName: string;
  /**
   * #1367 — 같은 stationName이 route에 중복 등장하는 trip(순환선)에서 hop별 dedup이 collide하지
   * 않도록 보존되는 0-based occurrence. `tba:` parser만 suffix를 분리해 채우고, `alarm:`/`bl:`는
   * occurrence 표기가 없으므로 항상 0 — silent push 채널과 통합 dedup key 공간을 공유한다.
   */
  occurrenceIdx: number;
}

/**
 * `alarm:` / `tba:` / `bl:` 세 prefix 단일 진입점 (#918 A3 PR2, #1282).
 * 세 경로의 phaseId/stationName 추출 로직이 같으므로 호출자는 prefix 분기만 본다.
 */
function parseAlarmIdentifier(identifier: string): ParsedAlarmIdentifier | null {
  if (identifier.startsWith(BOARDING_LOCK_ALARM_PREFIX)) {
    const p = parseBoardingLockAlarmIdentifier(identifier);
    return p
      ? { prefix: 'bl', phaseId: p.phase, stationName: p.stationName, occurrenceIdx: 0 }
      : null;
  }
  if (identifier.startsWith(TRIP_BOUND_ALARM_PREFIX)) {
    const p = parseTripBoundAlarmIdentifier(identifier);
    return p
      ? {
          prefix: 'tba',
          phaseId: p.phaseId,
          stationName: p.stationName,
          occurrenceIdx: p.occurrenceIdx,
        }
      : null;
  }
  const p = parseScheduledAlarmIdentifier(identifier);
  return p
    ? { prefix: 'alarm', phaseId: p.phaseId, stationName: p.stationName, occurrenceIdx: 0 }
    : null;
}

function safeParseRoute(raw: string | null): Route {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Route;
  } catch {
    return null;
  }
}

function parseDestinationName(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * #1704 — position-mismatch 게이트 임계값. 사용자 currentStation에서 fire 대상 stationName까지
 * 이 hop 수 이상 떨어져 있으면 suppress.
 *
 * 5 hop 선택 근거: 2호선/1호선 환승 평균 2-3 hop 사이, BG fire 정상 임계(early phase=3 stops,
 * imminent=1 stop)보다 충분히 여유. evidence: 14:04 신촌(2-018) → 종로3가(1-027) trip에서
 * 사용자 신촌 위치인데 종로3가 미리 fire(약 6+ hop 미래) — 5 hop 임계로 차단.
 *
 * mirror가 5 min 이상 stale이면 게이트 자체를 skip(보수 fallback) — false negative 차단.
 */
const POSITION_MISMATCH_HOP_THRESHOLD = 5;
const POSITION_MISMATCH_MIRROR_STALE_MS = 5 * 60 * 1_000;

/**
 * 사전 예약 알람(`tba:` / `bl:`)의 fire-time 재검증 공통 구현 (#918 A3 PR2, #729 흡수, #1282).
 *
 * OS가 예약된 시각에 발사한 알람이 *현재* 시점에도 유효한지 확인한다. 두 채널이 동일한
 * route-sig + waypoint 검증을 공유하므로 단일 헬퍼로 추출하고, 채널별 차이만 인자로 분리한다:
 *   - `requireTripStart`: `tba:`는 tripStart 존재를 선행 게이트로 요구한다(`true`). `bl:`은 lock
 *     scheduler가 SSOT이라 tripStart 게이트가 불필요하므로 `false`.
 *   - `getRegisteredSig`: 채널의 예약 시점 route-sig 영속화 getter.
 *
 * 검증 순서:
 *   1) (requireTripStart 시) tripStart 존재 — trip이 종료되지 않았다.
 *   2) ROUTE_KEY/DESTINATION_KEY 기반 현재 sig가 등록 시점 sig와 동일 — 목적지/환승 변경 없음.
 *   3) 파싱된 stationName이 현재 route waypoint 시퀀스 안에 있음 — 방어 검증.
 *   4) (#1704) 사용자 currentStation 대비 fire 대상이 N hop 미래가 아님 — backend SSoT mirror +
 *      sticky station fallback으로 위치 결정. 둘 다 부재/stale이면 보수적으로 게이트 skip.
 *
 * 한 가지라도 실패하면 reason과 함께 alarmLog에 적재하고 'suppress'를 반환한다.
 * 호출자는 fired set / lastStationName 갱신을 skip해 stale 알람이 후속 상태를 오염시키지 않게 한다.
 */
type RevalidationSuppressReason = Parameters<typeof logSuppressedTbaRevalidation>[0]['reason'];

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

async function revalidatePrescheduledAlarm(
  parsed: { phaseId: string; stationName: string },
  options: {
    requireTripStart: boolean;
    getRegisteredSig: () => Promise<string | null>;
  },
): Promise<'pass' | 'suppress'> {
  // phaseId는 'early'/'imminent' 둘 중 하나 — alarmLog에는 그대로 통과시켜도 안전.
  const phaseId = parsed.phaseId as AlarmPhaseId;
  const suppress = (reason: RevalidationSuppressReason): 'suppress' => {
    logSuppressedTbaRevalidation({ reason, stationName: parsed.stationName, phaseId });
    return 'suppress';
  };

  if (options.requireTripStart && (await getTripStartedAt()) === null) {
    return suppress('revalidate-no-trip');
  }

  const [routeRaw, destRaw, registeredSig] = await Promise.all([
    AsyncStorage.getItem(ROUTE_KEY),
    AsyncStorage.getItem(DESTINATION_KEY),
    options.getRegisteredSig(),
  ]);
  const route: Route = safeParseRoute(routeRaw);
  const destinationName = parseDestinationName(destRaw);
  const currentSig = routeSignature(route, destinationName);

  // registeredSig 부재 / 현재 sig 미산출 / 두 값 불일치 모두 mismatch로 묶는다.
  // (registeredSig 부재는 cancel* 직후 잔여 OS 발사 케이스.)
  if (registeredSig === null || currentSig === null || registeredSig !== currentSig) {
    return suppress('revalidate-route-sig-mismatch');
  }

  // 방어 검증: parsed stationName이 현재 waypoint 시퀀스에 존재해야 한다.
  // currentSig !== null이면 route, destinationName 둘 다 non-null 보장됨.
  const targets = resolveAllTargets(route as NonNullable<Route>, destinationName as string);
  if (!targets.some((t) => t.name === parsed.stationName)) {
    return suppress('revalidate-waypoint-mismatch');
  }

  // #1704 — 위치 게이트: 사용자 currentStation 대비 fire 대상이 N hop 이상 미래면 suppress.
  // 기존 게이트 통과 후 진입 — backend SSoT mirror + sticky station 둘 다 부재/stale이면 skip(보수).
  // 2026-06-23 사용자 trip evidence (14:04 신촌→종로3가 미리 fire, 14:18 합정→공덕/군자 미리 fire) 차단.
  const positionGate = await evaluatePositionMismatch({
    route: route as NonNullable<Route>,
    destinationName: destinationName as string,
    targetStationName: parsed.stationName,
  });
  if (positionGate === 'suppress') {
    return suppress('revalidate-position-mismatch');
  }

  return 'pass';
}

/** `tba:` 알람 재검증 — tripStart 게이트 + trip-bound sig (#918 A3 PR2, #729 흡수). */
function revalidateTbaAlarm(parsed: {
  phaseId: string;
  stationName: string;
}): Promise<'pass' | 'suppress'> {
  return revalidatePrescheduledAlarm(parsed, {
    requireTripStart: true,
    getRegisteredSig: getRegisteredTripRouteSig,
  });
}

/**
 * `bl:` 알람 재검증 (#1282 → #1415/#1353 R1).
 *
 * #1415/#1353 R1 (stale-fire cluster) — `requireTripStart=true`로 강화.
 *
 * 회귀 evidence (2026-06-22 / 2026-06-19 사용자 trip):
 *   - 6/22 14:19 사용자 을지로3가 위치인데 `bl:5호선:1:imminent:애오개` stale fire
 *   - 6/22 14:25 사용자 상왕십리 위치인데 `bl:2호선:1:imminent:아현` stale fire
 *   - 6/19 15:51 사용자 고속터미널 위치인데 `bl:7호선:N:imminent:용마산` stale fire (이전 trip의 destination)
 *
 * Root cause chain: backend cron auto-end → silent push trip-ended 도착 → device cleanup
 * (`purgeBoardingLockSchedulerQueue` + `runTripBoundCleanups`)이 OS queue cancel을 시도하지만,
 * race / 직렬 cancel reject / expo-notifications 내부 큐 반영 지연으로 일부 `bl:` 사전 예약이 OS
 * 큐에 잔존. 이후 ETA 도달 시 OS가 잔존 알람을 직접 발사 → 사용자 체감 "정적인데 다음역 stale fire".
 *
 * 기존 정책(`requireTripStart=false`)은 "lock SSOT이라 tripStart 게이트가 불필요"라는 가정에
 * 의존했으나, lock release / trip cleanup 후의 race window를 가드하지 못했다. tripStart 게이트는
 * 가장 강력한 trip-종료 신호이므로 `bl:` 채널에도 동일하게 적용한다 — `bl:` 사전 예약은 항상 trip
 * 컨텍스트 내에서 의미 있는 알람이고, trip이 끝났다면 lock 유무와 무관하게 stale.
 *
 * 트레이드오프 (의도적):
 *   - Trip 종료 직후 OS가 발사한 직전 `bl:` 알람이 race로 `tripStartedAt=null` 상태에서 도달하면
 *     `revalidate-no-trip`으로 suppress될 수 있다. 그러나 trip 종료 = lock 무효 = stale 알람이라
 *     이 silence는 의도적 — false positive (잘못 발사) 방지가 사용자 가치 직결 (ADR-010 동급).
 *   - 새 trip 시작 직후 backend가 새 `bl:` sig를 등록하기 전 race window에서 도달한 알람은 본
 *     게이트가 아닌 `revalidate-route-sig-mismatch`로 분류 — 새 trip의 sig가 다르기 때문.
 */
function revalidateBlAlarm(parsed: {
  phaseId: string;
  stationName: string;
}): Promise<'pass' | 'suppress'> {
  return revalidatePrescheduledAlarm(parsed, {
    requireTripStart: true,
    getRegisteredSig: getRegisteredBlRouteSig,
  });
}

/**
 * prefix별 사전 예약 알람 재검증 디스패처. `alarm:`은 BoardingLock scheduler cancel/reschedule이
 * SSOT이므로 재검증 없이 'pass'. `tba:` / `bl:`만 채널별 게이트를 거친다.
 * reconcile 단건/ drain batch 두 호출자가 공유한다.
 */
function revalidateByPrefix(parsed: ParsedAlarmIdentifier): Promise<'pass' | 'suppress'> {
  if (parsed.prefix === 'tba') return revalidateTbaAlarm(parsed);
  if (parsed.prefix === 'bl') return revalidateBlAlarm(parsed);
  return Promise.resolve('pass');
}

/**
 * 사전 예약된 `alarm:` / `tba:` / `bl:` 알림이 OS에 의해 발사된 직후 클라이언트 상태를 갱신한다.
 * 사전 예약 알람은 클라이언트 콜백을 거치지 않으므로(`alarmScheduler.ts`), 이 함수가
 * FG/BG 양쪽 발화 모두에 대한 상태 동기화 단일 진입점이다.
 *
 * - FIRED_ALARMS_KEY에 `phaseId:stationName` 추가 → FG 복귀 시 useStationAlarm 하이드레이션이
 *   해당 phase를 이미 발화된 것으로 간주해 중복 발화를 막는다.
 * - LAST_FIRED_ALARM_STATION_NAME_KEY를 해당 역 이름으로 갱신 → BGAppRefreshTask가
 *   다음 사이클에서 Arrival API를 올바른 기준역으로 호출.
 *
 * `tba:` (#918 A3 PR2, #729 흡수): revalidateTbaAlarm이 stale/misfire를 차단한 뒤 위 동작 수행.
 * `alarm:` 경로는 BoardingLock scheduler cancel/reschedule이 SSOT이므로 별도 재검증 없이 통과.
 */
export async function reconcileScheduledAlarmDelivery(
  identifier: string,
  actualFireMs: number = Date.now(),
): Promise<void> {
  // #918 A3 measurement — `tba:` prefix 사전 예약 알람 발사 시각 ledger 기록.
  // `alarm:` prefix와 무관 — graceful no-op for non-tba identifier.
  await recordFiredAlarm({ identifier, actualFireMs });

  const parsed = parseAlarmIdentifier(identifier);
  if (!parsed) return;

  if ((await revalidateByPrefix(parsed)) === 'suppress') {
    // #1354 — suppress 시 OS scheduled queue에 동일 identifier가 남아 다음 ETA에 또
    // 발사되어 정적 misfire가 영구 재발한다. 사전 예약은 fire-and-forget이므로 명시 cancel 필요.
    // cancelScheduledNotificationAsync는 이미 발사된 항목에도 안전 (tripBoundScheduler.ts:681).
    await Notifications.cancelScheduledNotificationAsync(identifier);
    // #1924 — delivered tray에서도 제거. cancelScheduledNotificationAsync는 pending queue
    // (removePendingNotificationRequests) 만 대상이라 이미 OS가 자체 fire 한 항목은 delivered
    // tray(removeDeliveredNotifications) 에 그대로 남는다. 사용자가 swipe-dismiss 하지 않는 한
    // 다음 FG 복귀 drain 시 같은 identifier를 또 read → 같은 reason으로 다시 suppress →
    // alarm log "revalidate-*" 무한 재적재 (2026-06-27 dump 56회 evidence).
    await Notifications.dismissNotificationAsync(identifier);
    return;
  }

  const destinationId = await getCurrentDestinationId();
  // destinationId가 없으면 이미 trip이 종료/변경된 알람의 잔여 발화 — 상태 갱신 스킵.
  // setLastFiredAlarmStationName은 trip 종속성이 약하므로 유지한다(다음 사이클 기준역 갱신용).
  if (destinationId) {
    const fired = await getFiredAlarms(destinationId);
    // #1367 — alarmKey()로 silent push 채널과 동일 dedup key 공간 공유. occurrenceIdx>0 OS scheduled
    // 알람도 phaseId:station#n 형식으로 등록 → 후속 silent push가 같은 hop 발사 시 dedup 적중.
    fired.add(
      alarmKey({
        phaseId: parsed.phaseId,
        stationName: parsed.stationName,
        occurrenceIdx: parsed.occurrenceIdx,
      }),
    );
    await setFiredAlarms(destinationId, fired);
  }
  await setLastFiredAlarmStationName(parsed.stationName);
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

  // #918 A3 — `tba:` prefix BG-fired 알람도 ledger에 fire ts 기록. Notification.date(epoch ms)
  // 가 OS의 실제 발사 시각 — drain 시점(=FG resume)이 아닌 발사 시점을 정확히 측정.
  for (const n of presented) {
    const fireMs = typeof n.date === 'number' ? n.date : Date.now();
    await recordFiredAlarm({ identifier: n.request.identifier, actualFireMs: fireMs });
  }

  // #918 A3 PR2 — `tba:` 항목은 발사 시점 재검증을 거친다. suppress인 경우 fired set /
  // lastStationName 갱신에 포함하지 않아 stale 알람이 후속 상태(BG arrival 기준역 등)를 오염시키지
  // 않게 한다. `alarm:` 경로는 기존 BoardingLock SSOT을 신뢰해 통과.
  // #1282 — `bl:` 항목도 동일하게 route-sig 재검증을 거친다.
  const accepted: ParsedAlarmIdentifier[] = [];
  for (const n of presented) {
    const parsed = parseAlarmIdentifier(n.request.identifier);
    if (!parsed) continue;
    if ((await revalidateByPrefix(parsed)) === 'suppress') {
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
    accepted.push(parsed);
  }

  const destinationId = await getCurrentDestinationId();
  let lastStationName: string | null = null;
  if (destinationId) {
    const fired = await getFiredAlarms(destinationId);
    let firedChanged = false;
    for (const parsed of accepted) {
      // #1367 — unified dedup key (silent push와 동일 공간). occurrenceIdx>0면 `#n` suffix.
      const key = alarmKey({
        phaseId: parsed.phaseId,
        stationName: parsed.stationName,
        occurrenceIdx: parsed.occurrenceIdx,
      });
      if (!fired.has(key)) {
        fired.add(key);
        firedChanged = true;
      }
      lastStationName = parsed.stationName;
    }
    if (firedChanged) await setFiredAlarms(destinationId, fired);
  } else {
    // destinationId 미설정 — fired set 갱신은 스킵하고 lastStationName만 추출.
    for (const parsed of accepted) {
      lastStationName = parsed.stationName;
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
 * 사전 예약 `alarm:` 알림 수신 리스너 등록. 멱등 — 중복 호출은 첫 핸들을 그대로 반환한다.
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
    // #918 A3 — Notification.date는 OS가 기록한 실제 발사 시각(epoch ms). Date.now() 폴백.
    void reconcileScheduledAlarmDelivery(
      notification.request.identifier,
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
