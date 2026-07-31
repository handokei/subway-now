/**
 * safetyNetScheduler (#2089) — OS 예약 스케줄러 3종(alarmScheduler / tripBoundScheduler /
 * boardingLockScheduler) 통합 후속. 하드닝 매트릭스 사용자 확정(2026-07-31, 이슈 #2089 코멘트) 반영.
 *
 * **새 역할**: Phase 2 전환으로 OS 예약 스케줄러는 "주 발사 채널"에서 "취침모드 한정
 * backend-outage 백업"으로 격하됐다. 본 모듈은 sleepMode가 켜진 trip에 대해서만, 환승/도착
 * waypoint의 "1역 전" 예상 시각 + {@link SAFETY_NET_BUFFER_MS} 버퍼에 단일 OS local notification을
 * 예약한다(예전처럼 (early, imminent) 2 phase가 아니다) — backend가 살아있다면 그 전에 원격
 * visible push / sleep-alarm-companion이 먼저 도달하므로, 본 알람은 backend가 침묵했을 때만
 * 사용자에게 도달하는 최후 안전망이다.
 *
 * 정책 gate(sleepMode 확인 / trip 등록·해제)는 호출자(`useSafetyNetScheduler` 훅, `silentPushTask`)
 * 책임 — 본 모듈은 순수 예약/취소 메커니즘만 제공한다.
 *
 * **보존 하드닝** (2026-07-31 매트릭스):
 *   - 중복역 occurrenceIdx 정합 (#1193) — {@link withOccurrenceIndices}.
 *   - iOS 64-cap 분배 (#1757) — {@link SAFETY_NET_MAX_WAYPOINTS}.
 *   - retry-with-backoff cancel (#1415/#1525) — {@link cancelIdentifiersWithRetry}.
 *   - delivered-tray cleanup(축소) (#1924) — {@link cancelAllSafetyNetAlarms}.
 *
 * **폐기** (더 이상 이 파일에 없음): rolling window(#918 A3 — 예약 단위가 waypoint당 1건으로
 * 줄어 window 개념 자체 소멸), motion gate(#1357 — 백업 발사에 motion 게이트는 miss 위험만
 * 추가), route-sig staleness(#918 — trip 재등록 시 항상 전체 재예약이라 대체 가능).
 *
 * **정책 통합**: sleep 첫-환승 suppress(#632)는 "1역차 금지" 정책(stops<=1 waypoint는 애초에
 * 등록 skip — {@link deriveSafetyNetWaypoints})으로 일반화 흡수.
 *
 * **대체**: cross-channel cancel(#1355/#1356, bl↔tba 상호 취소)은 단일 채널이 되며 필요 없어졌고,
 * companion(sleep-alarm-companion) 수신 시 취소({@link cancelSafetyNetByStationKind})로 대체.
 *
 * **결정적 identifier**: `AlarmLocalAuthority.buildAlarmLocalId(tripToken, station, kind)` 규칙을
 * 그대로 재사용 — companion 발사(로컬 TTS/진동)와 safety-net(OS 예약)이 같은 식별자 공간을 공유해
 * 두 채널이 항상 같은 트립/역/종류를 가리킨다는 것을 identifier만으로 보증한다.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { resolveAllTargets } from './stationAlarm';
import type { AlarmEvent } from './stationAlarm';
import { buildAlarmContent } from './stationNotification';
import { buildAlarmLocalId, type AlarmLocalKind } from './alarmLocalAuthority';
import { isSameStationName, type Route } from '../../../shared/utils/stationRoute';
import { HOP_TIME_MS } from '../../../shared/constants/boardingLock';
import { SAFETY_NET_MAX_WAYPOINTS } from '../../../shared/constants/iosScheduledLimit';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('SafetyNetScheduler');

/**
 * `buildAlarmLocalId`가 생성하는 identifier의 리터럴 접두(`alarm-`)를 그대로 OS 예약
 * prefix로 재사용한다 — trip 종료 시 prefix 매칭으로 일괄 cancel(#1924/#1415/#1525 보존)에 사용.
 */
export const SAFETY_NET_ALARM_PREFIX = 'alarm-';

/** iOS interruption level — 백업 채널이지만 사용자 도달이 최우선이라 timeSensitive 고정. */
const INTERRUPTION_LEVEL = 'timeSensitive';

/** Android channel id — 기존 스케줄러 3종과 동일. */
const ALARM_CHANNEL_ID = 'station-alarm';

/**
 * "1역 전" 추정 시각 이후 버퍼(ms). backend가 살아있다면 이 버퍼 안에 원격 채널이 먼저
 * 도달하므로, 안전망은 backend가 outage일 때만 실질적으로 사용자에게 닿는다.
 */
export const SAFETY_NET_BUFFER_MS = 180_000;

export interface SafetyNetWaypoint {
  stationName: string;
  kind: AlarmLocalKind;
  /** 이 waypoint까지 남은 정거장 수. */
  stops: number;
  /** 직전 waypoint(또는 trip 시작)로부터 이 waypoint까지의 leg 소요 시간(ms). */
  legMs: number;
}

interface SafetyNetWaypointWithOccurrence extends SafetyNetWaypoint {
  /** #1193 — 같은 (kind, stationName)이 route에 중복 등장할 때의 0-based 등장 순서. */
  occurrenceIdx: number;
}

export interface SafetyNetNotificationData {
  channel: 'safety-net';
  tripToken: string;
  station: string;
  kind: AlarmLocalKind;
  occurrenceIdx: number;
}

/**
 * hopIndex / target name으로 route의 leg seconds 필드를 선택.
 * `tripBoundScheduler.legSecondsForHop` / `boardingLockScheduler.legSecondsAt`와 동형 —
 * 세 스케줄러가 각자 두던 중복 helper를 본 파일 하나로 흡수(#2089 통합).
 */
function legSecondsForHop(route: NonNullable<Route>, hopIndex: number, targetName: string): number {
  if (route.type === 'direct') return route.travelSeconds;
  if (route.type === 'transfer') {
    if (isSameStationName(route.transferName, targetName)) return route.secondsToTransfer;
    return route.secondsFromTransfer;
  }
  if (hopIndex < route.transfers.length) return route.transfers[hopIndex].secondsToTransfer;
  return route.secondsAfterLastTransfer;
}

/**
 * route + destinationName에서 safety-net 대상 waypoint(환승 + 도착)를 산출한다.
 *
 * **"1역차 금지" 정책** (#632 sleep 첫-환승 suppress를 흡수한 일반화 — 2026-07-31 매트릭스
 * "정책 통합"): `stops <= 1`인 waypoint는 등록 자체를 skip한다. "1 station before"라는 개념은
 * 남은 정거장이 1개뿐이면 성립하지 않는다(그 시점이 곧 출발/직전 waypoint 시점과 같아진다) —
 * 옛 코드는 "탑승 직후 첫 hop이 transfer일 때만" 좁게 skip했지만, 본 정책은 모든 leg에 대해
 * 구조적으로 동일하게 적용한다.
 */
export function deriveSafetyNetWaypoints(
  route: Route,
  destinationName: string | null,
): SafetyNetWaypoint[] {
  if (!route || !destinationName) return [];
  const targets = resolveAllTargets(route, destinationName);
  const waypoints = targets.map((t, i) => {
    const legSeconds = legSecondsForHop(route, i, t.name);
    const legMs = legSeconds * 1000;
    return {
      stationName: t.name,
      kind: t.alarmType,
      stops: t.stops,
      legMs: Number.isFinite(legMs) && legMs > 0 ? legMs : HOP_TIME_MS,
    };
  });
  return waypoints.filter((w) => w.stops > 1);
}

/** #1193 — (kind, stationName) 단위로 0-based occurrence를 부여한다. */
function withOccurrenceIndices(
  waypoints: ReadonlyArray<SafetyNetWaypoint>,
): SafetyNetWaypointWithOccurrence[] {
  const seen = new Map<string, number>();
  return waypoints.map((wp) => {
    const key = `${wp.kind}:${wp.stationName}`;
    const occurrenceIdx = seen.get(key) ?? 0;
    seen.set(key, occurrenceIdx + 1);
    return { ...wp, occurrenceIdx };
  });
}

/**
 * 결정적 identifier. `AlarmLocalAuthority.buildAlarmLocalId`를 base로 재사용하고,
 * 중복 occurrence(#1193)만 `#n` suffix로 구분한다(`stationAlarm.alarmKey`와 동일 관례).
 */
function buildIdentifier(
  tripToken: string,
  station: string,
  kind: AlarmLocalKind,
  occurrenceIdx: number,
): string {
  const base = buildAlarmLocalId(tripToken, station, kind);
  return occurrenceIdx > 0 ? `${base}#${occurrenceIdx}` : base;
}

async function scheduleOne(params: {
  identifier: string;
  tripToken: string;
  stationName: string;
  kind: AlarmLocalKind;
  occurrenceIdx: number;
  fireMs: number;
}): Promise<void> {
  const { identifier, tripToken, stationName, kind, occurrenceIdx, fireMs } = params;
  // "1역 전" 문구는 early phase 메시지와 의미가 같다 — content 생성만 재사용, phase 개념 자체는
  // 본 모듈에 없다(단일 fire).
  const event: AlarmEvent = { phaseId: 'early', type: kind, stationName };
  const { title, body } = buildAlarmContent(event);
  const data: SafetyNetNotificationData = {
    channel: 'safety-net',
    tripToken,
    station: stationName,
    kind,
    occurrenceIdx,
  };
  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title,
      body,
      data: data as unknown as Record<string, unknown>,
      sound: 'alarm.wav',
      ...(Platform.OS === 'android' && {
        channelId: ALARM_CHANNEL_ID,
        priority: Notifications.AndroidNotificationPriority.MAX,
      }),
      ...(Platform.OS === 'ios' && { interruptionLevel: INTERRUPTION_LEVEL }),
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(fireMs) },
  });
}

export interface RegisterSafetyNetParams {
  tripToken: string;
  route: Route;
  destinationName: string | null;
  /** 누적 ETA 기준점(trip 시작 시각, ms epoch). */
  startTime: number;
  /** 현재 시각(ms epoch). past-time 가드용. 기본 Date.now(). */
  now?: number;
}

export interface RegisterSafetyNetResult {
  scheduled: number;
}

/**
 * trip 등록 시점(sleepMode ON 확인은 호출자 책임) 호출 — destinationName까지 모든 waypoint에
 * 단일 안전망 알람을 예약한다. 과거 시각(`fireMs <= startTime` 또는 `<= now`)은 skip.
 */
export async function registerSafetyNetAlarms(
  params: RegisterSafetyNetParams,
): Promise<RegisterSafetyNetResult> {
  const { tripToken, route, destinationName, startTime } = params;
  const nowMs = params.now ?? Date.now();
  const waypoints = withOccurrenceIndices(deriveSafetyNetWaypoints(route, destinationName));
  if (waypoints.length === 0) return { scheduled: 0 };

  // #1757 보존 — iOS 64-cap 회피. 실질적으로 도달하지 않는 방어적 상한.
  const capped = waypoints.slice(0, SAFETY_NET_MAX_WAYPOINTS);

  let cumulativeMs = startTime;
  let scheduled = 0;
  for (const wp of capped) {
    cumulativeMs += wp.legMs;
    const earlyLeadMs = wp.legMs / wp.stops;
    const fireMs = cumulativeMs - earlyLeadMs + SAFETY_NET_BUFFER_MS;
    if (fireMs <= startTime || fireMs <= nowMs) continue;
    const identifier = buildIdentifier(tripToken, wp.stationName, wp.kind, wp.occurrenceIdx);
    await scheduleOne({
      identifier,
      tripToken,
      stationName: wp.stationName,
      kind: wp.kind,
      occurrenceIdx: wp.occurrenceIdx,
      fireMs,
    });
    scheduled++;
  }
  logger.info(
    `registered ${scheduled}/${capped.length} safety-net alarms tripToken=${tripToken.slice(0, 8)}`,
  );
  return { scheduled };
}

/**
 * #1415/#1353 R1 — cancel 1차 reject 시 1회 재시도(#1525 Promise.allSettled 정책 보존).
 * tripBoundScheduler.cancelIdentifiersWithRetry / boardingLockScheduler.cancelAndDismiss와
 * 동형 — 3종 통합으로 이 파일 한 곳에만 존재.
 */
async function cancelIdentifiersWithRetry(identifiers: string[]): Promise<number> {
  if (identifiers.length === 0) return 0;
  const firstPass = await Promise.allSettled(
    identifiers.map((id) => Notifications.cancelScheduledNotificationAsync(id)),
  );
  const rejected: string[] = [];
  for (let i = 0; i < firstPass.length; i++) {
    if (firstPass[i].status === 'rejected') rejected.push(identifiers[i]);
  }
  let firstPassSuccess = 0;
  for (const r of firstPass) {
    if (r.status === 'fulfilled') firstPassSuccess++;
  }
  if (rejected.length === 0) return firstPassSuccess;

  logger.warn(
    `cancel reject pass-1: count=${rejected.length} ids=${rejected.slice(0, 3).join(',')}${rejected.length > 3 ? '...' : ''}`,
  );
  const secondPass = await Promise.allSettled(
    rejected.map((id) => Notifications.cancelScheduledNotificationAsync(id)),
  );
  let retryRescued = 0;
  const stillRejected: string[] = [];
  for (let i = 0; i < secondPass.length; i++) {
    if (secondPass[i].status === 'fulfilled') {
      retryRescued++;
    } else {
      stillRejected.push(rejected[i]);
    }
  }
  if (stillRejected.length > 0) {
    logger.warn(
      `cancel reject pass-2 (final): count=${stillRejected.length} ids=${stillRejected.slice(0, 3).join(',')}${stillRejected.length > 3 ? '...' : ''}`,
    );
  }
  return firstPassSuccess + retryRescued;
}

/**
 * trip 종료 시 호출 — `tripToken`의 모든 safety-net 알람을 pending queue에서 cancel한다.
 *
 * #1924 보존(축소) — delivered tray(이미 OS가 자체 fire한 항목)도 함께 dismiss한다. 옛
 * tripBoundScheduler와 달리 채널이 하나뿐이라 prefix 매칭 범위만 tripToken 단위로 좁아졌다.
 */
export async function cancelAllSafetyNetAlarms(tripToken: string): Promise<void> {
  const prefix = `${SAFETY_NET_ALARM_PREFIX}${tripToken}-`;
  const all = await Notifications.getAllScheduledNotificationsAsync();
  const targets = all.filter((req) => req.identifier.startsWith(prefix));
  const cancelled = await cancelIdentifiersWithRetry(targets.map((req) => req.identifier));

  let dismissedCount = 0;
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    const delivered = presented.filter((n) => n.request.identifier.startsWith(prefix));
    if (delivered.length > 0) {
      const results = await Promise.allSettled(
        delivered.map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') dismissedCount++;
      }
    }
  } catch (e) {
    logger.warn(`cancelAllSafetyNetAlarms: delivered tray 조회 실패, pending cancel만 적용: ${e}`);
  }

  if (cancelled > 0 || dismissedCount > 0) {
    logger.info(`cancelled ${cancelled} pending + dismissed ${dismissedCount} safety-net alarms`);
  }
}

/**
 * OS 알림 request에서 safety-net 메타데이터(`content.data`)를 안전하게 추출한다.
 * `scheduledAlarmReceiver`가 fire-time reconcile 시 재사용 — identifier 문자열 파싱 대신
 * 구조화된 data를 신뢰(옛 3종 스케줄러의 identifier `:` split 파싱 방식과 달리 tripToken
 * 자체가 dash를 포함할 수 있어 문자열 파싱이 본질적으로 불안전하기 때문).
 */
export function readSafetyNetData(
  req: Notifications.NotificationRequest,
): SafetyNetNotificationData | null {
  if (!req.identifier.startsWith(SAFETY_NET_ALARM_PREFIX)) return null;
  const data = req.content.data as Partial<SafetyNetNotificationData> | null | undefined;
  if (!data || data.channel !== 'safety-net') return null;
  if (typeof data.station !== 'string' || typeof data.tripToken !== 'string') return null;
  if (data.kind !== 'transfer' && data.kind !== 'destination') return null;
  const occurrenceIdx = typeof data.occurrenceIdx === 'number' ? data.occurrenceIdx : 0;
  return { channel: 'safety-net', tripToken: data.tripToken, station: data.station, kind: data.kind, occurrenceIdx };
}

/**
 * companion(sleep-alarm-companion) 수신 또는 station-passed 시 호출 — 같은 station + kind의
 * 안전망 예약을 occurrence 무관 전부 cancel한다.
 *
 * 옛 `cancelTbaByStationPhase` / `cancelBlByStationPhase`(#1355 D1 / #1356 E1, cross-channel
 * cancel)의 대체(#2089 매트릭스 "대체" 항목) — 채널이 하나뿐이라 "반대 채널 cleanup"이 아니라
 * "이미 다른 경로(companion/GPS)로 사용자에게 전달된 waypoint의 안전망 제거"로 목적이 바뀐다.
 */
export async function cancelSafetyNetByStationKind(
  stationName: string,
  kind: AlarmLocalKind,
): Promise<void> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  const targets = all.filter((req) => {
    const data = readSafetyNetData(req);
    return data !== null && data.kind === kind && isSameStationName(data.station, stationName);
  });
  if (targets.length === 0) return;
  const cancelled = await cancelIdentifiersWithRetry(targets.map((req) => req.identifier));
  if (cancelled > 0) {
    logger.info(`cancelled ${cancelled} safety-net alarms station=${stationName} kind=${kind}`);
  }
}

export interface RescheduleSafetyNetParams {
  tripToken: string;
  route: Route;
  destinationName: string | null;
  /** 정정 대상 waypoint의 canonical 역명(backend payload.nextStation). */
  stationName: string;
  /** 새 도착 시각(ms epoch, waypoint 자체 도착 기준). */
  newArrivalMs: number;
  /** #1193 — 정정 대상 occurrence(0-based). 미지정 시 0. */
  occurrenceIdx?: number;
  now?: number;
}

export interface RescheduleSafetyNetResult {
  cancelled: number;
  scheduled: number;
}

/**
 * backend reschedule silent push 수신 시 호출 — 해당 waypoint의 기존 예약을 cancel하고
 * newArrivalMs 기준 "1역 전 + 버퍼"로 재예약한다.
 *
 * past-time / route 매칭 실패는 graceful no-op(정정 신호 폐기) — 옛 rescheduleTripBoundAlarm /
 * rescheduleHopForLock과 동일 정책.
 */
export async function rescheduleSafetyNetAlarm(
  params: RescheduleSafetyNetParams,
): Promise<RescheduleSafetyNetResult> {
  const { tripToken, route, destinationName, stationName, newArrivalMs } = params;
  const occurrenceIdx = params.occurrenceIdx ?? 0;
  const nowMs = params.now ?? Date.now();

  if (newArrivalMs <= nowMs) {
    logger.info(`reschedule skip: past-time newArrivalMs=${newArrivalMs} now=${nowMs}`);
    return { cancelled: 0, scheduled: 0 };
  }

  const waypoints = withOccurrenceIndices(deriveSafetyNetWaypoints(route, destinationName));
  const target = waypoints.find(
    (w) => isSameStationName(w.stationName, stationName) && w.occurrenceIdx === occurrenceIdx,
  );
  if (!target) {
    logger.info(`reschedule no-op: ${stationName} occurrence=${occurrenceIdx} not found`);
    return { cancelled: 0, scheduled: 0 };
  }

  const all = await Notifications.getAllScheduledNotificationsAsync();
  const matches = all.filter((req) => {
    const data = readSafetyNetData(req);
    return (
      data !== null &&
      data.kind === target.kind &&
      data.occurrenceIdx === occurrenceIdx &&
      isSameStationName(data.station, target.stationName)
    );
  });
  const cancelled =
    matches.length > 0 ? await cancelIdentifiersWithRetry(matches.map((req) => req.identifier)) : 0;

  const earlyLeadMs = target.legMs / target.stops;
  const fireMs = newArrivalMs - earlyLeadMs + SAFETY_NET_BUFFER_MS;
  if (fireMs <= nowMs) {
    logger.info(`reschedule cancel-only: fireMs=${fireMs} <= now=${nowMs}`);
    return { cancelled, scheduled: 0 };
  }

  const identifier = buildIdentifier(tripToken, target.stationName, target.kind, occurrenceIdx);
  await scheduleOne({
    identifier,
    tripToken,
    stationName: target.stationName,
    kind: target.kind,
    occurrenceIdx,
    fireMs,
  });
  logger.info(
    `reschedule done: station=${target.stationName} occurrence=${occurrenceIdx} cancelled=${cancelled} scheduled=1 newArrivalMs=${newArrivalMs}`,
  );
  return { cancelled, scheduled: 1 };
}
