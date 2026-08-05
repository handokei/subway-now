/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 본 모듈은 hop time 산출을 위해 features/route의 hopTime.ts를
 * 직접 호출한다(#655/#779 실측 hop 테이블 재사용, 신규 ETA 추정기 금지 원칙). `scheduledAlarmReceiver.ts`가
 * routeToWaypoints를 동일한 이유로 직접 import하는 것과 같은 선례. 후속 PR에서 hopTime을
 * src/shared/utils/로 추출하거나 orchestration 슬라이스로 이전 예정.
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * stationPrescheduler (#918) — OS-level 사전 예약을 "매역"으로 일반화한 2번째 안전망 채널.
 *
 * `safetyNetScheduler`(#2089)가 sleepMode ON trip에 한해 transfer/destination waypoint에만
 * 예약하는 것과 대칭으로, 본 모듈은 **sleepMode OFF**(일반 모드) + **boardingLock 활성** trip에
 * 한해 경로 위 **모든 역**(환승/도착 포함)에 예약한다. 목적은 다르다 — safetyNetScheduler는
 * "backend가 완전히 죽었을 때의 최후 안전망"이고, 본 모듈은 "BG/화면꺼짐에서 APNs 전달 지연
 * (실측 35~51s, 2026-08-03 트립)을 OS가 대신 메꾸는 근본 수리"다.
 *
 * 정책은 호출자(`useStationPrescheduler` 훅, `silentPushTask`) 책임 — 본 모듈은 순수
 * 예약/취소/재예약 메커니즘만 제공한다(safetyNetScheduler와 동일 원칙).
 *
 * **3-소스 identifier 판정** (이슈 #918 "스펙 정정 2026-08-03 2차" — collapse-id 문자열을 그대로
 * pending identifier로 쓰면 `scheduleNotificationAsync`의 same-identifier 교체 규칙 때문에
 * rolling window(앞 12역)가 pending 1개로 붕괴한다는 결함이 조사에서 확인됨):
 *   - pending identifier = 역별 고유 (`safetyNetScheduler`와 동일 접두 패턴).
 *   - collapse-id 문자열(#2122 `buildStationNotifCollapseId`)은 `content.data.collapseId`에만
 *     동봉 — 실제 OS collapsing 대신 앱 레벨 dedup(`recentLocalStationFires`)이 3-소스 멱등을
 *     맡는다. FG는 `scheduledAlarmReceiver`의 알림 수신 리스너가 원격 도착 시 pending 취소를,
 *     BG는 `silentPushTask`가 wake 시점에 pending 취소 + delivered 제거 + markLocalStationFired를
 *     수행한다 — 정착 상태(다음 wake 이후) 기준으로 "역당 배너 정확히 1개"를 보장한다. BG에서
 *     사전예약 발사 후 backend push 도착까지 수 초~수십 초 공존은 허용 잔여(문서화, PR 참고).
 *
 * **rolling window / 64한도**: `safetyNetScheduler`는 sleepMode ON에서만, 본 모듈은 sleepMode
 * OFF에서만 armed — 한 trip에서 두 채널이 동시에 예약되는 경우가 구조적으로 없으므로 cap을
 * 합산할 필요가 없다(각자 `PRESCHEDULED_STATION_WINDOW_SIZE`/`SAFETY_NET_MAX_WAYPOINTS`로
 * 독립 방어). 매 재계산(hop 진행 시)마다 이전 예약을 전량 cancel 후 앞 12역을 다시 예약한다.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Station, LineNumber } from '../../../shared/types/station';
import { buildAlarmContent, buildStationPassedContent, ALARM_SILENT_CHANNEL_ID } from './stationNotification';
import { buildStationNotifCollapseId } from './stationNotifCollapseId';
import { cancelIdentifiersWithRetry } from './safetyNetScheduler';
import { hopTimeMsAt } from '../../route/utils/hopTime';
import { PRESCHEDULED_STATION_WINDOW_SIZE } from '../../../shared/constants/iosScheduledLimit';
import { APNS_TOKEN_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';
import { recordScheduledAlarm } from './prescheduledMetrics';
import { logScheduledPrescheduledAlarm } from './alarmLog';
import type { AlarmEvent } from '../../../shared/types/alarm';

const logger = createLogger('StationPrescheduler');

/** OS 예약 identifier 접두 — `presched-<tripToken.slice(0,16)>-<station>-<kind>#<occurrence>`. */
export const PRESCHED_ALARM_PREFIX = 'presched-';

/** #2158 P1 — prescheduler는 일반모드 전용 채널이라 loud가 존재할 이유가 없다. Android 8+에서는
 *  채널의 sound/importance/bypassDnd가 고정 속성이라 content.sound=false만으로는 loud를 막을 수
 *  없으므로, safetyNetScheduler(취침 전용)가 쓰는 loud 채널('station-alarm', sound:'alarm.wav'
 *  고정)이 아니라 무음 채널('station-alarm-silent')을 재사용한다. */
const ANDROID_CHANNEL_ID = ALARM_SILENT_CHANNEL_ID;
/** #2158 — prescheduler는 일반모드 전용 채널이라 loud(alarm.wav/timeSensitive)가 존재할 이유가
 *  없다. backend의 매역 push(`sendAlertPush` interruption-level=active, 무소리)와 동일 정책. */
const INTERRUPTION_LEVEL = 'active';

/**
 * 역별 알림 종류. 경로의 마지막 역은 'destination', line이 바뀌는 경계 역은 'transfer',
 * 그 외 모든 중간역은 'station-passed'. `arcStations`의 인덱스 구조만으로 결정되므로
 * 노선/역명 하드코딩이 없다(데이터 주도).
 */
export type PrescheduledKind = 'transfer' | 'destination' | 'station-passed';

export interface PrescheduledNotificationData {
  channel: 'presched-station';
  tripToken: string;
  station: string;
  kind: PrescheduledKind;
  occurrenceIdx: number;
  /** #2122 규칙 재사용 — 실제 OS collapsing 용도가 아니라 관측/향후 확장용 메타데이터. */
  collapseId?: string;
}

/** `arcStations[idx]`의 알림 종류를 arc 구조만으로 판정. */
function kindForArcIndex(arcStations: readonly Station[], idx: number): PrescheduledKind {
  if (idx === arcStations.length - 1) return 'destination';
  if (arcStations[idx].line !== arcStations[idx + 1].line) return 'transfer';
  return 'station-passed';
}

interface RawWaypoint {
  stationName: string;
  kind: PrescheduledKind;
  fireMs: number;
}

interface WaypointWithOccurrence extends RawWaypoint {
  occurrenceIdx: number;
}

/** #1193과 동일 패턴 — (kind, stationName) 조합별 0-based 등장 순서. */
function withOccurrenceIndices(waypoints: readonly RawWaypoint[]): WaypointWithOccurrence[] {
  const seen = new Map<string, number>();
  return waypoints.map((wp) => {
    const key = `${wp.kind}:${wp.stationName}`;
    const occurrenceIdx = seen.get(key) ?? 0;
    seen.set(key, occurrenceIdx + 1);
    return { ...wp, occurrenceIdx };
  });
}

function buildIdentifier(
  tripToken: string,
  station: string,
  kind: PrescheduledKind,
  occurrenceIdx: number,
): string {
  const base = `${PRESCHED_ALARM_PREFIX}${tripToken.slice(0, 16)}-${station}-${kind}`;
  return occurrenceIdx > 0 ? `${base}#${occurrenceIdx}` : base;
}

/**
 * `arcStations[currentIdx]`(현재 위치, 실시간 lock trainCode 판정 결과)를 앵커로 다음
 * `PRESCHEDULED_STATION_WINDOW_SIZE`역까지 hop time을 누적해 예상 도착 시각을 산출한다.
 * `hopTimeMsAt`(#655/#779 실측 hop 테이블)을 그대로 재사용 — 신규 ETA 추정기 없음.
 */
function deriveUpcomingWaypoints(
  arcStations: readonly Station[],
  currentIdx: number,
  nowMs: number,
): RawWaypoint[] {
  if (currentIdx < 0 || currentIdx >= arcStations.length - 1) return [];
  const endIdx = Math.min(currentIdx + PRESCHEDULED_STATION_WINDOW_SIZE, arcStations.length - 1);
  const waypoints: RawWaypoint[] = [];
  let cumulativeMs = nowMs;
  for (let i = currentIdx; i < endIdx; i++) {
    cumulativeMs += hopTimeMsAt(arcStations, i, arcStations[i].line as LineNumber);
    const targetIdx = i + 1;
    waypoints.push({
      stationName: arcStations[targetIdx].name,
      kind: kindForArcIndex(arcStations, targetIdx),
      fireMs: cumulativeMs,
    });
  }
  return waypoints;
}

async function resolveCollapseId(): Promise<string | undefined> {
  const deviceToken = await AsyncStorage.getItem(APNS_TOKEN_KEY);
  return deviceToken ? buildStationNotifCollapseId(deviceToken) : undefined;
}

async function scheduleOne(params: {
  identifier: string;
  tripToken: string;
  stationName: string;
  kind: PrescheduledKind;
  occurrenceIdx: number;
  fireMs: number;
  collapseId: string | undefined;
}): Promise<void> {
  const { identifier, tripToken, stationName, kind, occurrenceIdx, fireMs, collapseId } = params;
  // #2158 — 일반모드(취침모드 OFF) 전용 채널이므로 kind와 무관하게 항상 non-loud 알림으로
  // 예약한다. transfer/destination도 backend 매역 push와 동일한 문구를 재사용하되(정보 전달
  // 목적은 동일), 발사는 무소리 + interruption-level=active로 통일 — loud(alarm.wav +
  // timeSensitive)는 safetyNetScheduler(취침모드 전용)만의 권한이다.
  const { title, body } = kind === 'station-passed'
    ? buildStationPassedContent(stationName)
    : buildAlarmContent({ phaseId: 'imminent', type: kind, stationName } as AlarmEvent);
  const data: PrescheduledNotificationData = {
    channel: 'presched-station',
    tripToken,
    station: stationName,
    kind,
    occurrenceIdx,
    collapseId,
  };
  await Notifications.scheduleNotificationAsync({
    identifier,
    content: {
      title,
      body,
      data: data as unknown as Record<string, unknown>,
      sound: false,
      ...(Platform.OS === 'android' && {
        channelId: ANDROID_CHANNEL_ID,
        priority: Notifications.AndroidNotificationPriority.HIGH,
      }),
      ...(Platform.OS === 'ios' && { interruptionLevel: INTERRUPTION_LEVEL }),
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(fireMs) },
  });
  await recordScheduledAlarm({ identifier, scheduledFireMs: fireMs, stationName });
  logScheduledPrescheduledAlarm({ stationName, kind });
}

export interface RegisterPrescheduledParams {
  tripToken: string;
  /** boarding → destination 순서의 ordered station 시퀀스 (`useFusedNearestStation.arcStations`). */
  arcStations: readonly Station[];
  /** arcStations 내 현재 위치 인덱스(실시간 lock trainCode 판정, `currentHopIndex`). */
  currentIdx: number;
  now?: number;
}

export interface RegisterPrescheduledResult {
  scheduled: number;
}

export async function registerPrescheduledStationAlarms(
  params: RegisterPrescheduledParams,
): Promise<RegisterPrescheduledResult> {
  const { tripToken, arcStations, currentIdx } = params;
  const nowMs = params.now ?? Date.now();
  const waypoints = withOccurrenceIndices(deriveUpcomingWaypoints(arcStations, currentIdx, nowMs));
  if (waypoints.length === 0) return { scheduled: 0 };

  const collapseId = await resolveCollapseId();
  let scheduled = 0;
  for (const wp of waypoints) {
    if (wp.fireMs <= nowMs) continue;
    const identifier = buildIdentifier(tripToken, wp.stationName, wp.kind, wp.occurrenceIdx);
    await scheduleOne({
      identifier,
      tripToken,
      stationName: wp.stationName,
      kind: wp.kind,
      occurrenceIdx: wp.occurrenceIdx,
      fireMs: wp.fireMs,
      collapseId,
    });
    scheduled++;
  }
  logger.info(
    `registered ${scheduled}/${waypoints.length} prescheduled station alarms tripToken=${tripToken.slice(0, 8)}`,
  );
  return { scheduled };
}

/** trip 종료 시 호출 — `tripToken`의 모든 사전예약을 pending queue + delivered tray에서 제거. */
export async function cancelAllPrescheduledAlarms(tripToken: string): Promise<void> {
  const prefix = `${PRESCHED_ALARM_PREFIX}${tripToken.slice(0, 16)}-`;
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
    logger.warn(`cancelAllPrescheduledAlarms: delivered tray 조회 실패, pending cancel만 적용: ${e}`);
  }

  if (cancelled > 0 || dismissedCount > 0) {
    logger.info(`cancelled ${cancelled} pending + dismissed ${dismissedCount} prescheduled alarms`);
  }
}

/**
 * OS 알림 request에서 사전예약 메타데이터를 안전하게 추출.
 * `scheduledAlarmReceiver`(fire-time revalidation) + `stationNotification`(원격 도착 시
 * pending 취소)이 재사용한다.
 */
export function readPrescheduledData(
  req: Notifications.NotificationRequest,
): PrescheduledNotificationData | null {
  if (!req.identifier.startsWith(PRESCHED_ALARM_PREFIX)) return null;
  const data = req.content.data as Partial<PrescheduledNotificationData> | null | undefined;
  if (!data || data.channel !== 'presched-station') return null;
  if (typeof data.station !== 'string' || typeof data.tripToken !== 'string') return null;
  if (data.kind !== 'transfer' && data.kind !== 'destination' && data.kind !== 'station-passed') {
    return null;
  }
  const occurrenceIdx = typeof data.occurrenceIdx === 'number' ? data.occurrenceIdx : 0;
  return {
    channel: 'presched-station',
    tripToken: data.tripToken,
    station: data.station,
    kind: data.kind,
    occurrenceIdx,
  };
}

/**
 * 3-소스 dedup — 같은 (station, kind)의 사전예약 pending을 전부 취소한다.
 *
 * 호출자:
 *  - FG: `scheduledAlarmReceiver`가 원격(backend) station-notif 도착을 감지하면 즉시 호출
 *    ("remote 선표시 → 해당 역 pending 로컬 cancel").
 *  - BG: `silentPushTask`가 backend push wake 시점에 호출.
 *
 * occurrence는 무관하게 전부 취소 — 같은 (station, kind)가 route에 중복 등장해도(순환 노선)
 * backend push 시점엔 이미 그 역을 지나는 순간이므로 어느 occurrence든 유효기간이 끝난다.
 */
export async function cancelPrescheduledByStationKind(
  stationName: string,
  kind: PrescheduledKind,
): Promise<void> {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  const targets = all.filter((req) => {
    const data = readPrescheduledData(req);
    return data !== null && data.kind === kind && data.station === stationName;
  });
  if (targets.length === 0) return;
  const cancelled = await cancelIdentifiersWithRetry(targets.map((req) => req.identifier));
  if (cancelled > 0) {
    logger.info(`cancelled ${cancelled} prescheduled alarms (remote arrival) station=${stationName} kind=${kind}`);
  }
}

export interface ReschedulePrescheduledParams {
  tripToken: string;
  stationName: string;
  /**
   * #1193과 동일 — 같은 stationName이 route에 중복 등장하는 경우 정정 대상 occurrence(0-based).
   * 미지정 시 0(첫 등장). backend reschedule payload는 kind를 보내지 않으므로(#725 스키마),
   * 매칭된 기존 pending entry의 `content.data.kind`를 그대로 재사용한다 — route 재파생 불필요.
   */
  occurrenceIdx?: number;
  /** 새 도착 시각(ms epoch). */
  newArrivalMs: number;
  now?: number;
}

export interface ReschedulePrescheduledResult {
  cancelled: number;
  scheduled: number;
}

/**
 * backend reschedule push(`kind: 'reschedule'`) 수신 시 호출 — 해당 역의 기존 사전예약을
 * cancel하고 `newArrivalMs`로 재예약한다.
 *
 * safetyNetScheduler의 reschedule과 동일 원칙(#2089 리뷰 P1-1) — 이미 armed된 예약이 없으면
 * (예: sleepMode가 그 사이 켜져 애초에 등록되지 않았거나, 이미 지나간 역) 신규 예약을 만들지
 * 않고 cancel-only(no-op)로 끝낸다. 매 역의 hop time을 다시 파생할 필요 없이, backend가 이미
 * 계산해 보낸 단일 역의 정정 시각을 그대로 반영한다 — 신규 ETA 추정기 없음.
 */
export async function reschedulePrescheduledAlarm(
  params: ReschedulePrescheduledParams,
): Promise<ReschedulePrescheduledResult> {
  const { tripToken, stationName, newArrivalMs } = params;
  const occurrenceIdx = params.occurrenceIdx ?? 0;
  const nowMs = params.now ?? Date.now();

  const all = await Notifications.getAllScheduledNotificationsAsync();
  let matchedKind: PrescheduledKind | null = null;
  let matchedIdentifier: string | null = null;
  for (const req of all) {
    const data = readPrescheduledData(req);
    if (
      data !== null &&
      data.tripToken === tripToken &&
      data.occurrenceIdx === occurrenceIdx &&
      data.station === stationName
    ) {
      matchedKind = data.kind;
      matchedIdentifier = req.identifier;
      break;
    }
  }
  if (matchedKind === null || matchedIdentifier === null) {
    logger.info(`reschedule cancel-only: no existing schedule for station=${stationName} occurrence=${occurrenceIdx}`);
    return { cancelled: 0, scheduled: 0 };
  }
  const kind = matchedKind;
  const cancelled = await cancelIdentifiersWithRetry([matchedIdentifier]);

  if (newArrivalMs <= nowMs) {
    logger.info(`reschedule cancel-only: newArrivalMs=${newArrivalMs} <= now=${nowMs}`);
    return { cancelled, scheduled: 0 };
  }

  const collapseId = await resolveCollapseId();
  const identifier = buildIdentifier(tripToken, stationName, kind, occurrenceIdx);
  await scheduleOne({
    identifier,
    tripToken,
    stationName,
    kind,
    occurrenceIdx,
    fireMs: newArrivalMs,
    collapseId,
  });
  logger.info(
    `reschedule done: station=${stationName} occurrence=${occurrenceIdx} cancelled=${cancelled} scheduled=1 newArrivalMs=${newArrivalMs}`,
  );
  return { cancelled, scheduled: 1 };
}
