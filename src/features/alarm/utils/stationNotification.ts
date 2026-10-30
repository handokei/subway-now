/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import i18next from 'i18next';
import { Station } from '../../../shared/types/station';
import { LINE_COLORS, LINE_NAMES } from '../../../shared/constants/lineColors';
import { DirectRoute, TransferRoute, MultiTransferRoute, isSameStationName } from '../../../shared/utils/stationRoute';
import type { AlarmEvent } from './stationAlarm';
import * as LiveActivity from 'live-activity';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY, APNS_TOKEN_KEY } from '../../../shared/constants/storageKeys';
import {
  ensureLiveActivityRegistered,
  endLiveActivityWithDeregister,
  resolveDeviceFallbackSource,
  shouldSkipDeviceLiveActivityWrite,
  startAmbientLiveActivityTokenRegistration,
} from './liveActivityPushChannel';
import { stopVibration } from './alarmSound';
import { createLogger } from '../../../shared/utils/logger';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';
import { getStationDisplayName, getStationDisplayNameByName } from '../../../shared/utils/stationDisplay';
import { hasFiredPushId } from './firedPushIds';
import stationsData from '../../../data/stations.json';
import type { PlatformExitSide, TerminusRelation } from '../../../shared/types/platformExitSide';
import { hasQuickExitData } from '../../route/utils/quickExit';
import type { JourneyLaFields } from '../../route/utils/journeyLaFields';
import { resolveExitSideForStation } from '../../../shared/utils/resolveExitSideForStation';
import {
  notificationSourceI18nKey,
  shouldDiscloseNotificationSource,
  type NotificationSource,
} from './notificationSource';
import { buildStationNotifCollapseId } from './stationNotifCollapseId';
import { markLocalStationFired, hasRecentLocalStationFire } from './recentLocalStationFires';
import { markDeviceGpsLiveActivityWrite } from './liveActivityGpsWriteArbitration';
import { isStationWaypointKind, type StationWaypointKind } from '../../../shared/types/pushContract';
import { logExitSideUnknownStationId, logLaWrite, logLiveActivityUpdated } from './alarmLog';
import {
  BOARDING_PROMPT_CATEGORY,
  DISEMBARK_PROMPT_CATEGORY,
  STATION_TRACKING_CATEGORY,
} from './notificationCategory';
import { resolveStationNotifSoundFields } from '../../../shared/constants/stationNotifSound';
import { logFiredLaFallbackNotification, logSuppressedLaFallbackContentDedup } from './alarmLog';
import {
  logPushReceipt,
  mapWaypointKindToReceiptKind,
} from '../../observability/utils/pushReceiptLog';
import { TtlCache } from '../../../shared/utils/ttlCache';
import { LA_FALLBACK_DEDUP_TTL_MS } from '../../../shared/constants/laFallbackDedup';
import { endBoardingActivity } from './boardingActivityChannel';

/** 알람/통과 본문 끝에 데이터 출처를 자백하는 라벨을 부착한다.
 *  - source 미지정 → 라벨 생략 (기존 caller 회귀 안전)
 *  - positionTrain/routeProgress → 라벨 생략 (정상 신뢰 케이스는 노이즈, #327 UX 정책) */
function appendNotificationSource(body: string, source?: NotificationSource): string {
  if (!source || !shouldDiscloseNotificationSource(source)) return body;
  return `${body} · ${i18next.t(notificationSourceI18nKey(source))}`;
}

const allStations = stationsData as Station[];

const notifLogger = createLogger('Notification');
const liveActivityLogger = createLogger('LiveActivity');

/**
 * #2591 (code review 8번, SonarCloud dup 회피) — iOS `interruptionLevel: 'timeSensitive'`
 * 옵션 spread 단일 진입점. `fireLocalAlarmNotification`(+ `fireLocalBoardingPromptNotification`, #3063 철거)
 * (본 파일)과 `lastTrainAlarm.ts`/`silentPushTask.ts`(skew-fallback)까지 동일한
 * `...(Platform.OS === 'ios' && { interruptionLevel: 'timeSensitive' as const })` 4개 사본이
 * 있었다 — 이 함수로 통합해 4곳 모두 재사용한다.
 */
export function iosTimeSensitiveOption(): { interruptionLevel: 'timeSensitive' } | Record<string, never> {
  return Platform.OS === 'ios' ? { interruptionLevel: 'timeSensitive' } : {};
}

export const NOTIFICATION_ID = 'current-station';
export const ALARM_NOTIFICATION_ID = 'station-alarm';
const ALARM_CHANNEL_ID = 'station-alarm';
/** #2158 — 일반모드 stationPrescheduler가 재사용하는 무음 채널(sound:null, bypassDnd 없음). */
export const ALARM_SILENT_CHANNEL_ID = 'station-alarm-silent';
export const STATION_PASSED_NOTIFICATION_ID = 'station-passed';
const STATION_PASSED_CHANNEL_ID = 'station-passed';


async function scheduleNotification(
  id: string,
  content: {
    title: string;
    body: string;
    sound?: boolean | string;
    channelId?: string;
    interruptionLevel?: 'timeSensitive' | 'critical';
    priority?: Notifications.AndroidNotificationPriority;
    /** #2422 — boarding-prompt 등 액션 버튼(UNNotificationCategory)이 필요한 로컬 발사용. */
    categoryIdentifier?: string;
    /** #2422 — 응답 listener(`useBoardingPromptResponder`)가 파싱하는 payload 동봉용. */
    data?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(id);
  } catch {
    // 기존 알림 없어도 무시
  }
  await Notifications.scheduleNotificationAsync({
    identifier: id,
    content,
    trigger: null,
  });
}

/**
 * #2817 (구 #2687 content 기준에서 교체) — LA fallback 알림(iOS LA 비활성/예외, Android)
 * 역 정체성 + TTL dedup.
 *
 * LA가 죽어 있으면 GPS/BG 파이프라인(stationPipeline.ts)과 FG effect(HomeScreen.tsx)가
 * 고빈도(매 GPS poll)로 `updateStationNotification`을 호출한다. 과거엔 (title, body)
 * content 완전 동일성으로 dedup했으나, `buildContent`가 매 cycle 거리(`distanceM`)·ETA를
 * 새로 채워 넣어 내용이 조금씩 달라지면서 dedup이 무력화돼 같은 역이 초당 여러 번
 * 재발사되는 버스트가 재발했다(#2817). 기준을 **역 정체성(stationName) + 시간창(TTL)**
 * 으로 바꾼다 — 같은 역이면 내용이 달라져도 TTL 안에서는 억제, TTL이 지나거나 다른
 * 역이면 즉시 통과시킨다.
 */
const fallbackNotificationDedupCache = new TtlCache<string, true>(LA_FALLBACK_DEDUP_TTL_MS);

/** trip 종료/알림 해제 시 리셋 — 다음 trip 첫 발사가 이전 trip과 같은 역이어도 막히지 않게. */
function resetFallbackNotificationDedup(): void {
  fallbackNotificationDedupCache.clear();
}

/** 테스트용 — 모듈 in-memory dedup 상태를 test case 사이에 격리. */
export function _resetFallbackNotificationDedupForTests(): void {
  resetFallbackNotificationDedup();
}

/**
 * #2822 — root RCA: 이 alarm-worker fallback 발사점이 data(kind)/categoryIdentifier 없이
 * `{title, body}`만 실어 device가 "유령"(무음+kind=unknown)으로 인식하던 결함. 이 알림은
 * LA 비활성/실패 시의 "현재 위치 추적" ambient 알림이라 kind는 항상 'intermediate' 고정 —
 * 매역 tracking과 동일 정책(무음 유지, 회귀 안전)으로 `resolveStationNotifSoundFields`를
 * 공유한다.
 */
async function scheduleFallbackStationNotification(
  stationName: string,
  line: string,
  content: { title: string; body: string },
): Promise<void> {
  if (fallbackNotificationDedupCache.get(stationName) !== undefined) {
    logSuppressedLaFallbackContentDedup(stationName);
    return;
  }
  fallbackNotificationDedupCache.set(stationName, true);
  const soundFields = resolveStationNotifSoundFields('intermediate');
  await scheduleNotification(NOTIFICATION_ID, {
    ...content,
    sound: soundFields.sound,
    categoryIdentifier: STATION_TRACKING_CATEGORY,
    data: { kind: 'intermediate', stationName, line },
  });
  logFiredLaFallbackNotification(stationName);
}

export function setupNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const isAlarm = notification.request.identifier === ALARM_NOTIFICATION_ID;
      // #2591 (code review 1번, 치명) — 이 FG 핸들러가 shouldPlaySound를 ALARM_NOTIFICATION_ID
      // identifier로만 게이트해, boarding/disembark-prompt(로컬 발사 채널, FG 전용)는 content에
      // sound를 실어도 FG에서 항상 무음 처리됐다(root — 헤드라인 presentation 동급화만으로는
      // 무효). 두 prompt 카테고리(BOARDING_PROMPT_CATEGORY/DISEMBARK_PROMPT_CATEGORY)도
      // hasSound와 함께 shouldPlaySound=true로 취급한다.
      const isPromptCategory =
        notification.request.content.categoryIdentifier === BOARDING_PROMPT_CATEGORY ||
        notification.request.content.categoryIdentifier === DISEMBARK_PROMPT_CATEGORY;
      const hasSound = notification.request.content.sound != null;
      // #574 P2e — silent push가 이미 fired한 pushId의 alert fallback이 race로 도달했을 때
      // FG에서 중복 표시 차단. BG에선 iOS가 직접 표시해 JS 개입 불가(P2e 한계 명시).
      if (await isFallbackDuplicate(notification)) {
        logAlertPushReceipt(notification, false, 'fallback-duplicate-of-silent-fired');
        return SUPPRESSED_NOTIFICATION_BEHAVIOR;
      }
      // #2122 — FG 보조 발사(로컬 station-passed 알림) 직후 뒤늦게 도착한 backend alert push가
      // 같은 (station, kind)면 2차 방어선으로 표시 억제(1차는 apns-collapse-id 문자열 일치).
      if (await isRecentLocalAuxFireDuplicate(notification)) {
        logAlertPushReceipt(notification, false, 'recent-local-aux-fire-duplicate');
        return SUPPRESSED_NOTIFICATION_BEHAVIOR;
      }
      // #2422 — 로컬 boarding-prompt 발사 직후 뒤늦게 도착하는 backend remote alert push가
      // 같은 origin station이면 억제 (station-passed의 isRecentLocalAuxFireDuplicate와 동형 2차 방어선).
      if (await isRecentLocalBoardingPromptDuplicate(notification)) {
        logAlertPushReceipt(notification, false, 'recent-local-boarding-prompt-duplicate');
        return SUPPRESSED_NOTIFICATION_BEHAVIOR;
      }
      // #2902 — 양방향 대칭 가드. backend push가 이 지점까지 도달했다는 건(위 3개 억제 분기를
      // 모두 통과) 실제로 사용자에게 표시된다는 뜻이다. 기존엔 로컬 FG 보조 발사만
      // recentLocalStationFires에 기록해(#2122) "로컬 먼저 → 원격 억제" 방향만 보호했는데, 반대
      // 방향(원격 먼저 표시 → 뒤이은 로컬 독자 발사)도 같은 store/TTL/키 정책으로 기록해 커버한다
      // (새 게이트 신설 없음, fireFgAuxStationPassedNotification이 발사 전 동일 store를 재확인).
      // 억제되어 여기 도달하지 않은 push는 markLocalStationFired를 호출하지 않는다(#2488 — 발사
      // 안 한 경로가 마킹하면 다음 정상 발사까지 억제하는 회귀 재발 금지).
      await markRemoteShownForBidirectionalDedup(notification);
      logAlertPushReceipt(notification, true);
      return {
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        // #3146 — prompt 카테고리는 payload sound가 아니라 카테고리가 FG 소리를 결정한다. backend가
        // LA alert 성공 시 일반 프롬프트 알림을 무음(sound 키 없음)으로 보내는데, 앱이 FG면 LA가
        // 안 보여 소리가 사라지기 때문(3단 우선순위: 프롬프트=소리 필수). 알람은 기존대로 hasSound.
        shouldPlaySound: isAlarm ? hasSound : isPromptCategory,
        shouldSetBadge: false,
      };
    },
  });
}

/**
 * #2902 — backend push data(nextWaypoint/kind)를 로컬 fire kind로 매핑해 recentLocalStationFires
 * store에 기록한다. `isRecentLocalAuxFireDuplicate`(:321-334)가 로컬 발사를 기록하는 것과 동일한
 * 매핑(`mapBackendKindToLocalFireKind`)·store를 반대 방향에 재사용 — 매핑이 없는 kind(비-station
 * waypoint)는 조용히 no-op.
 */
async function markRemoteShownForBidirectionalDedup(
  notification: Notifications.Notification,
): Promise<void> {
  const data = notification.request.content.data as
    | { nextWaypoint?: unknown; kind?: unknown }
    | undefined;
  const stationName = data?.nextWaypoint;
  const backendKind = data?.kind;
  if (typeof stationName !== 'string' || stationName.length === 0) return;
  if (typeof backendKind !== 'string') return;
  const localKind = mapBackendKindToLocalFireKind(backendKind);
  if (!localKind) return;
  await markLocalStationFired(stationName, localKind);
}

/**
 * #2541 (obs: whole-chain 관측) — FG alert push receipt. `setupNotificationHandler`가
 * shouldShowAlert 결정을 내리는 이 지점이 device가 backend visible push(alert)를 실제로
 * "표시할지" 결정하는 유일한 JS 개입 지점이다.
 *
 * 한계: BG(앱 kill/suspend)에서는 iOS가 alert push를 시스템 배너로 직접 렌더하며 이 핸들러가
 * 아예 호출되지 않는다 — 그 경우 receipt 자체가 device dump에 남지 않는다("BG alert 도달 여부
 * 불명"의 direct evidence, backend D1 cron-fire-attempt와 대조 시 이 gap을 감안해야 한다).
 *
 * data.kind가 station waypoint kind(transfer/destination/intermediate)나 'boarding-prompt'가
 * 아니면(trip-ended 등 비-station alert) 관측 대상 밖 — 조용히 no-op.
 */
function logAlertPushReceipt(
  notification: Notifications.Notification,
  displayed: boolean,
  suppressedReason?: string,
): void {
  const data = notification.request.content.data as
    | { nextWaypoint?: unknown; kind?: unknown; originStation?: unknown; pushId?: unknown }
    | undefined;
  const pushId = typeof data?.pushId === 'string' ? data.pushId : null;
  const rawKind = data?.kind;
  if (rawKind === 'boarding-prompt') {
    const station = data?.originStation;
    if (typeof station !== 'string' || station.length === 0) return;
    logPushReceipt({
      pushId,
      station,
      kind: 'prompt',
      pushType: 'alert',
      displayed,
      ...(suppressedReason !== undefined ? { suppressedReason } : {}),
    });
    return;
  }
  if (typeof rawKind !== 'string' || !isStationWaypointKind(rawKind)) return;
  const station = data?.nextWaypoint;
  if (typeof station !== 'string' || station.length === 0) return;
  logPushReceipt({
    pushId,
    station,
    kind: mapWaypointKindToReceiptKind(rawKind),
    pushType: 'alert',
    displayed,
    ...(suppressedReason !== undefined ? { suppressedReason } : {}),
  });
}

const SUPPRESSED_NOTIFICATION_BEHAVIOR: Notifications.NotificationBehavior = {
  shouldShowAlert: false,
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/**
 * notification.request.content.data.pushId가 silent에서 이미 처리한 pushId면 true.
 * APNs alert payload data 형식: `{ pushId: string }` (#572 sendAlertPush).
 */
async function isFallbackDuplicate(
  notification: Notifications.Notification,
): Promise<boolean> {
  const data = notification.request.content.data as { pushId?: unknown } | undefined;
  const pushId = data?.pushId;
  if (typeof pushId !== 'string' || pushId.length === 0) return false;
  return hasFiredPushId(pushId);
}

// #2122 — backend push data.kind('intermediate' 등, backend `Waypoint.kind`)를
// 로컬 dispatchStationPassed의 AlarmLogKind('station-passed')로 매핑.
// #918 — OS 사전예약(stationPrescheduler)이 transfer/destination kind도 커버하게 되면서
// 매핑도 identity 항목 2개를 추가(로컬 kind 이름이 backend kind 이름과 동일).
// #2235 (ADR-029 Phase 0) — 키를 pushContract SSoT `StationWaypointKind`로 타입해 exhaustive
// 하게 강제한다. STATION_WAYPOINT_KINDS에 새 값이 추가되면 이 Record 리터럴이 컴파일 에러를 낸다
// (키 누락 = 드리프트 = 빌드 실패).
const BACKEND_PUSH_KIND_TO_LOCAL_FIRE_KIND: Record<StationWaypointKind, string> = {
  intermediate: 'station-passed',
  transfer: 'transfer',
  destination: 'destination',
};

/**
 * backend push의 `data.kind`를 device local fire kind로 매핑. `scheduledAlarmReceiver`(#918)가
 * "remote 선표시 시 해당 역 pending 사전예약 cancel" 판정에 재사용 — 매핑 테이블의 단일 owner.
 * 매핑이 없는 kind(예: 'reschedule'/'trip-ended' 등 비-station 계열, 또는 런타임 미검증 문자열)는
 * null. 입력은 검증되지 않은 원본 문자열일 수 있어(#2122 `isRecentLocalAuxFireDuplicate` 호출부)
 * 파라미터 타입은 `string`으로 유지 — 룩업 테이블 자체(키 집합)만 SSoT로 타입한다.
 */
export function mapBackendKindToLocalFireKind(backendKind: string): string | null {
  return BACKEND_PUSH_KIND_TO_LOCAL_FIRE_KIND[backendKind as StationWaypointKind] ?? null;
}

/**
 * backend alert push의 data.nextWaypoint(station name) + data.kind가, 이 device가 방금 로컬로
 * 발사한 (station, kind)와 일치하면 true. apns-collapse-id 문자열 일치(1차 방어선)가
 * 성립하지 않는 케이스를 위한 2차 방어선(#2122 스펙 2b).
 */
async function isRecentLocalAuxFireDuplicate(
  notification: Notifications.Notification,
): Promise<boolean> {
  const data = notification.request.content.data as
    | { nextWaypoint?: unknown; kind?: unknown }
    | undefined;
  const stationName = data?.nextWaypoint;
  const backendKind = data?.kind;
  if (typeof stationName !== 'string' || stationName.length === 0) return false;
  if (typeof backendKind !== 'string') return false;
  const localKind = mapBackendKindToLocalFireKind(backendKind);
  if (!localKind) return false;
  return hasRecentLocalStationFire(stationName, localKind);
}

/** boarding-prompt local fire dedup 키 kind — `recentLocalStationFires`(#2122 station-passed
 *  선례) 재사용. station name과 조합해 `${kind}:${stationName}` 키를 만든다. */
export const LOCAL_BOARDING_PROMPT_FIRE_KIND = 'boarding-prompt';

/**
 * #2422 — backend remote boarding-prompt alert push(`data.kind === 'boarding-prompt'`)가,
 * 이 device가 방금 로컬로 발사한 것과 같은 originStation이면 true. 로컬 발사가 backend push보다
 * 먼저 도달했을 때 뒤늦은 remote alert의 중복 표시를 억제한다.
 */
async function isRecentLocalBoardingPromptDuplicate(
  notification: Notifications.Notification,
): Promise<boolean> {
  const data = notification.request.content.data as
    | { kind?: unknown; originStation?: unknown }
    | undefined;
  if (data?.kind !== 'boarding-prompt') return false;
  const originStation = data?.originStation;
  if (typeof originStation !== 'string' || originStation.length === 0) return false;
  return hasRecentLocalStationFire(originStation, LOCAL_BOARDING_PROMPT_FIRE_KIND);
}

const STATION_CHANNEL_ID = 'station';

// Android 알림 채널을 현재 언어 기준으로 재생성. 권한 다이얼로그를 트리거하지 않으므로
// 언어 전환마다 호출해도 안전.
export async function refreshNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.deleteNotificationChannelAsync(STATION_CHANNEL_ID).catch(() => {});
  await Notifications.setNotificationChannelAsync(STATION_CHANNEL_ID, {
    name: i18next.t('notifications.channelStation'),
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  await Notifications.deleteNotificationChannelAsync(ALARM_CHANNEL_ID).catch(() => {});
  await Notifications.setNotificationChannelAsync(ALARM_CHANNEL_ID, {
    name: i18next.t('notifications.channelTransferAlarm'),
    importance: Notifications.AndroidImportance.MAX,
    sound: 'alarm.wav',
    enableVibrate: true,
    vibrationPattern: [0, 1000, 500, 1000],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true,
  });
  await Notifications.deleteNotificationChannelAsync(ALARM_SILENT_CHANNEL_ID).catch(() => {});
  // #2158 P1 — stationPrescheduler(일반모드, sleepMode OFF)가 이 채널을 재사용한다. Android 8+는
  // 채널의 sound/importance/bypassDnd가 고정 속성이라 per-notification content.sound=false만으로
  // loud를 막을 수 없다 — MAX+bypassDnd(취침용 강제 알림 속성)를 제거하고 HIGH 이하로 낮춘다.
  await Notifications.setNotificationChannelAsync(ALARM_SILENT_CHANNEL_ID, {
    name: i18next.t('notifications.channelTransferAlarmSilent'),
    importance: Notifications.AndroidImportance.HIGH,
    sound: null,
    enableVibrate: true,
    vibrationPattern: [0, 1000, 500, 1000],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  await Notifications.deleteNotificationChannelAsync(STATION_PASSED_CHANNEL_ID).catch(() => {});
  // #1224 — 매역 알림은 잠을 깨우지 말 것: 진동 0 / 사운드 0 / 배너만
  await Notifications.setNotificationChannelAsync(STATION_PASSED_CHANNEL_ID, {
    name: i18next.t('notifications.channelStationPass'),
    importance: Notifications.AndroidImportance.DEFAULT,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    sound: null,
    enableVibrate: false,
  });
}

export async function initStationNotification(): Promise<void> {
  await refreshNotificationChannels();
  const { status } = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowSound: true,
      allowCriticalAlerts: true,
    },
  });
  notifLogger.info('권한 상태:', status);
  addDomainBreadcrumb('permission', 'notification', { status });
}

// 좌/우 데이터는 모든 역에 존재하지 않을 수 있다(나무위키 수집 누락 등).
// side가 주어지지 않으면 본문에 라인이 추가되지 않는다 — 잘못된 안내를 피한다.
function exitSideText(side: PlatformExitSide): string {
  return i18next.t(side === 'left' ? 'alarms.exitSideLeft' : 'alarms.exitSideRight');
}

function appendExitSide(body: string, side?: PlatformExitSide | null): string {
  if (!side) return body;
  return `${body}\n${exitSideText(side)}`;
}

// 좌/우 하차 방향 해석 (#3177): event.stationId(역 id)로만 판정한다 — 이름 첫 매칭은 환승역에서
// 다른 노선 값을 집었다. stationId가 없거나 stations.json에 없으면 이름으로 대체 조회하지 않고
// 안내를 생략한다(오안내 제거 우선, ADR-010) + alarmLog `exit-side-unknown-station-id`.
// 일반 notification(buildAlarmContent)·취침 알람·LA 본문(buildLiveActivityData)이 모두 이 함수를 탄다.
function resolveExitSide(event: AlarmEvent): PlatformExitSide | null {
  const { stationId, direction, stationName } = event;
  const resolution = stationId
    ? resolveExitSideForStation({ stationId, direction, terminus: resolveTerminusRelation(event) })
    : null;
  if (!resolution || resolution.reason === 'unknown-station-id') {
    logExitSideUnknownStationId(stationName);
    return null;
  }
  return resolution.side;
}

function resolveTerminusRelation({ trainTerminal, stationName }: AlarmEvent): TerminusRelation {
  if (!trainTerminal) return 'unknown';
  return isSameStationName(trainTerminal, stationName) ? 'here' : 'elsewhere';
}

// 알람 본문에 추상적 빠른하차 힌트를 붙일지 결정. 해당 역의 빠른하차 데이터가 있을 때만 표시한다.
// 알람 타입에 따라 transfer/arrival 두 가지 카피로 분기.
// #3177: event.stationId로만 조회한다 — 이름 첫 매칭은 환승역에서 다른 노선 데이터를 집었다.
// stationId가 없으면 이름으로 대체 조회하지 않고 힌트를 생략한다.
function resolveQuickHint({ stationId, type }: AlarmEvent): string | null {
  if (!stationId || !hasQuickExitData(stationId)) return null;
  return type === 'transfer'
    ? i18next.t('alarms.quickHintTransfer')
    : i18next.t('alarms.quickHintArrival');
}

function appendQuickHint(body: string, hint: string | null): string {
  if (!hint) return body;
  return `${body}\n${hint}`;
}

function buildContent(
  currentStation: Station,
  distanceM: number,
  destination?: Station | null,
  route?: DirectRoute | TransferRoute | MultiTransferRoute | null,
  etaMinutes?: number | null,
  isMock?: boolean,
): { title: string; body: string } {
  const etaSuffix =
    etaMinutes != null
      ? ` · ${i18next.t('time.approximateMinutes', { min: etaMinutes })}${isMock ? i18next.t('time.estimatedSuffix') : ''}`
      : '';

  // destination layer: 목적지 있으면 title에 반영
  const currentName = getStationDisplayName(currentStation);
  // #2687 — 현재역 == 목적지(도착)면 "용마산 → 용마산" 대신 도착 문구. 기존 station-passed
  // 알림이 쓰던 'route.stationPassed' 키 재사용 — 새 키 추가 없이 동일 "N역 도착" 의미 공유.
  const hasArrived = destination != null && isSameStationName(currentStation.name, destination.name);
  const title = hasArrived
    ? i18next.t('route.stationPassed', { name: currentName })
    : destination
      ? `${currentName} → ${getStationDisplayName(destination)}`
      : i18next.t('route.currentStation', { name: currentName });

  // route layer: 경로 정보가 있으면 body에 반영
  if (destination && route) {
    if (route.type === 'direct') {
      return {
        title,
        body: `${LINE_NAMES[currentStation.line]} · ${i18next.t('route.stopsLeft', { count: route.stops })}${etaSuffix}`,
      };
    }
    if (route.type === 'transfer') {
      return {
        title,
        body: `${i18next.t('route.transferAfterStops', { stops: route.stopsToTransfer, name: getStationDisplayNameByName(route.transferName, allStations) })}${etaSuffix}`,
      };
    }
    const [t1] = route.transfers;
    return {
      title,
      body: `${i18next.t('route.transferAfterStops', { stops: t1.stopsToTransfer, name: getStationDisplayNameByName(t1.transferName, allStations) })}${etaSuffix}`,
    };
  }

  // base: 경로 없이 목적지만 있거나 목적지도 없는 경우
  return {
    title,
    body: `${LINE_NAMES[currentStation.line]} · ${i18next.t('route.approximateDistance', { m: distanceM })}${etaSuffix}`,
  };
}

/**
 * #2434 — LA interactive prompt piece ①. boarding 프롬프트 상태를 LA content state에 실어
 * 보내기 위한 순수 데이터 필드. 버튼/AppIntent는 후속 piece에서 배선한다.
 * 전부 optional — 미전달 시 `buildLiveActivityData`가 대응 필드를 세팅하지 않아 기존 동작과 동일.
 */
export interface BoardingPromptLiveActivityFields {
  phase?: 'pre-boarding' | 'boarded' | 'hop-end' | 'arrival';
  tripToken?: string;
  originStation?: string;
  line?: string;
}

type BoardingPromptTarget =
  | 'boardingPhase'
  | 'boardingPromptTripToken'
  | 'boardingPromptOriginStation'
  | 'boardingPromptLine';

/**
 * #2434 — (source key → LiveActivityData target key) 매핑. 필드가 하나 더 추가돼도
 * 이 배열에 한 줄만 늘리면 되도록 데이터 주도로 구성 (개별 if 반복 하드코딩 금지, CLAUDE.md 룰3).
 */
const BOARDING_PROMPT_FIELD_MAP: ReadonlyArray<{
  source: keyof BoardingPromptLiveActivityFields;
  target: BoardingPromptTarget;
}> = [
  { source: 'phase', target: 'boardingPhase' },
  { source: 'tripToken', target: 'boardingPromptTripToken' },
  { source: 'originStation', target: 'boardingPromptOriginStation' },
  { source: 'line', target: 'boardingPromptLine' },
];

/**
 * Live Activity content-state payload 빌더 — 입력은 train/route/alarm 정보, 출력은 native
 * Live Activity 모듈에 전달할 직렬화된 `LiveActivityData`. `updateStationNotification`(FG)과
 * `refreshLiveActivityFromBackgroundContext`(#900 Seam D, silent push BG)에서 공유한다.
 */
export function buildLiveActivityData(
  currentStation: Station,
  distanceM: number,
  destination?: Station | null,
  route?: DirectRoute | TransferRoute | MultiTransferRoute | null,
  etaMinutesArg?: number | null,
  isMock?: boolean,
  alarmEvent?: AlarmEvent | null,
  source?: NotificationSource,
  boardingPrompt?: BoardingPromptLiveActivityFields | null,
  journeyFields?: JourneyLaFields | null,
): LiveActivity.LiveActivityData {
  // #3221 — 실시간 ETA 인자가 없으면(BG 등) 원본 route 기준 static ETA로 채운다. 있으면 그것이 이긴다.
  const { etaMinutes: journeyEtaMinutes, ...journeyRest } = journeyFields ?? {};
  const etaMinutes = etaMinutesArg ?? journeyEtaMinutes;
  // station layer: 항상 포함. Live Activity는 사용자 노출이므로 현재 언어로 표시.
  const data: LiveActivity.LiveActivityData = {
    stationName: getStationDisplayName(currentStation),
    lineName: LINE_NAMES[currentStation.line],
    lineColorHex: LINE_COLORS[currentStation.line],
    distanceM,
  };

  // destination layer: 목적지 있으면 독립적으로 포함
  if (destination) {
    data.destinationName = getStationDisplayName(destination);
  }

  // route layer: 경로 정보가 있을 때만
  if (destination && route) {
    if (route.type === 'direct') {
      data.stopsRemaining = route.stops;
    } else if (route.type === 'transfer') {
      data.stopsToTransfer = route.stopsToTransfer;
      data.transferStationName = getStationDisplayNameByName(route.transferName, allStations);
      data.stopsFromTransfer = route.stopsFromTransfer;
      data.nextLineName = LINE_NAMES[route.toLine];
      data.nextLineColorHex = LINE_COLORS[route.toLine];
    } else {
      const [first, second] = route.transfers;
      data.nextLineName = LINE_NAMES[first.toLine];
      data.nextLineColorHex = LINE_COLORS[first.toLine];
      data.stopsToTransfer = first.stopsToTransfer;
      data.transferStationName = getStationDisplayNameByName(first.transferName, allStations);
      data.stopsToSecondTransfer = second.stopsToTransfer;
      data.secondTransferStationName = getStationDisplayNameByName(second.transferName, allStations);
      data.stopsAfterLastTransfer = route.stopsAfterLastTransfer;
    }
  }

  // #3221 — 여정 진행 필드(진행 막대·다음 역·환승 후 노선/방면). route layer 뒤라 원본 route 기준 값이 이긴다.
  Object.assign(data, journeyRest);

  // eta layer: ETA가 있을 때만
  if (etaMinutes != null) {
    data.etaMinutes = etaMinutes;
  }
  if (isMock) {
    data.isMock = true;
  }

  // alarm layer: 알람 이벤트가 있을 때만. 위젯에 표시되므로 현재 언어로 변환.
  if (alarmEvent) {
    data.alarmType = alarmEvent.type;
    data.alarmStationName = getStationDisplayNameByName(alarmEvent.stationName, allStations);
    const isTransferAlarm = alarmEvent.type === 'transfer';
    const { body: rawBody } = earlyAlarmCopy(alarmEvent.stationName, isTransferAlarm, alarmEvent.band);
    const side = resolveExitSide(alarmEvent);
    const withSide = appendExitSide(rawBody, side);
    const hint = resolveQuickHint(alarmEvent);
    // alarmBody에도 source suffix 부착 — Dynamic Island expanded 등 sourceLabel을
    // 별도 표시하지 않는 표면에서도 출처를 자백한다 (sourceLabel은 비알람 상태용).
    data.alarmBody = appendNotificationSource(appendQuickHint(withSide, hint), source);
    if (side) {
      data.alarmExitSide = side;
    }
    data.alarmShortLabel = i18next.t(
      isTransferAlarm ? 'liveActivity.alarmShortTransfer' : 'liveActivity.alarmShortArrival',
    );
  }

  // source 라벨도 JS에서 i18n으로 빌드해 native로 전달 (#327).
  // alarmBody 등 다른 사용자 노출 텍스트와 동일 패턴.
  // positionTrain/routeProgress는 정상 신뢰 케이스라 자백 생략 — UX 노이즈 회피.
  if (source && shouldDiscloseNotificationSource(source)) {
    data.sourceLabel = i18next.t(notificationSourceI18nKey(source));
  }

  // 사용자 노출 텍스트 빌드 — Widget이 직접 조립하지 않도록 JS에서 미리 i18n.
  data.distanceText = i18next.t('route.approximateDistance', { m: distanceM });
  if (etaMinutes != null) {
    data.etaText = i18next.t('time.approximateMinutes', { min: etaMinutes });
    data.etaSubtext = i18next.t(
      isMock ? 'liveActivity.etaSubtextEstimated' : 'liveActivity.etaSubtextDuration',
    );
  }
  const etaSuffix = etaMinutes != null ? i18next.t('liveActivity.etaSuffix', { min: etaMinutes }) : '';
  if (destination) {
    const destName = data.destinationName as string;
    if (data.stopsRemaining != null) {
      data.routeSubtext = i18next.t('liveActivity.stopsToArrival', {
        count: data.stopsRemaining,
        destination: destName,
      });
      data.routeSummary = i18next.t('liveActivity.summaryWithStops', {
        count: data.stopsRemaining,
        destination: destName,
        etaSuffix,
      });
      // MultiTransferRoute의 경우 첫 번째 환승 정보만 표시. 두 번째 환승은 라우트 빌더에서
      // raw 필드에는 채워지지만 Live Activity 텍스트에는 반영되지 않음 (기존 Swift 동작 동일).
    } else if (data.stopsToTransfer != null && data.transferStationName) {
      data.routeSubtext = i18next.t('liveActivity.stopsToTransfer', {
        count: data.stopsToTransfer,
        name: data.transferStationName,
      });
      data.routeSummary = i18next.t('liveActivity.summaryWithTransfer', {
        count: data.stopsToTransfer,
        name: data.transferStationName,
        destination: destName,
        etaSuffix,
      });
    } else {
      data.routeSummary = i18next.t('liveActivity.summaryDestinationOnly', {
        destination: destName,
        etaSuffix,
      });
    }
  }

  // #2434 — LA interactive prompt piece ①. boardingPrompt 필드가 있을 때만, 존재하는 값만
  // 순회로 채운다. 미전달(undefined/null)이면 data에 필드가 세팅되지 않아 native ContentState가
  // nil로 decode돼 기존 렌더와 100% 동일.
  if (boardingPrompt) {
    for (const { source, target } of BOARDING_PROMPT_FIELD_MAP) {
      const value = boardingPrompt[source];
      if (value) {
        (data as Record<BoardingPromptTarget, string | undefined>)[target] = value;
      }
    }
  }

  return data;
}

export async function updateStationNotification(
  currentStation: Station,
  distanceM: number,
  destination?: Station | null,
  route?: DirectRoute | TransferRoute | MultiTransferRoute | null,
  etaMinutes?: number | null,
  isMock?: boolean,
  alarmEvent?: AlarmEvent | null,
  source?: NotificationSource,
  journeyFields?: JourneyLaFields | null,
): Promise<void> {
  notifLogger.info('updateStation:', currentStation.name, `${distanceM}m`, destination ? `→ ${destination.name}` : '');

  if (Platform.OS === 'ios') {
    const liveActivityEnabled = LiveActivity.isLiveActivityEnabled();
    liveActivityLogger.info('isLiveActivityEnabled:', liveActivityEnabled);

    if (!liveActivityEnabled) {
      notifLogger.info('Live Activity 비활성 → 알림 fallback');
      const { title, body } = buildContent(currentStation, distanceM, destination, route, etaMinutes, isMock);
      await scheduleFallbackStationNotification(currentStation.name, currentStation.line, { title, body });
      notifLogger.info('알림 예약 완료:', title, body);
      return;
    }
    const data = buildLiveActivityData(currentStation, distanceM, destination, route, etaMinutes, isMock, alarmEvent, source, null, journeyFields);
    try {
      liveActivityLogger.info('업데이트 요청');
      // #1288 — 활성 trip이 있으면 LA push 토큰 등록 채널을 거친다. 활성 trip이 없으면
      // 기존처럼 update만 호출(LA push 미등록은 silent, LA 자체는 정상 동작).
      const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
      // #2481 — backend-authority 모드 + 이미 backend가 이 trip의 LA push 채널을 쥐고 있으면
      // device GPS 추정치로 backend의 정확한 "N정거장"을 덮어쓰지 않는다(Wave 2).
      if (await shouldSkipDeviceLiveActivityWrite(tripToken)) {
        liveActivityLogger.info('backend-authority 활성 trip — device LA 쓰기 스킵(backend push 단독 저자)');
        return;
      }
      // #2735 PR-4 (ADR-041 결정 4) — backend 침묵 판정 뒤의 device 쓰기에는 출처를 붙인다. data는 위에서
      // 이미 만들어졌으므로 buildLiveActivityData와 같은 규칙(debug 게이트 포함)으로 sourceLabel만 덧붙인다.
      const fallbackSource = await resolveDeviceFallbackSource(tripToken);
      if (fallbackSource && shouldDiscloseNotificationSource(fallbackSource)) {
        data.sourceLabel = i18next.t(notificationSourceI18nKey(fallbackSource));
      }
      // #2667 (코드리뷰 P1-1) — LA를 만들 수 있는 호출 **직전**에 ambient token 구독을 보장한다.
      // 이 함수는 FG 컴포넌트 트리뿐 아니라 `backgroundLocationTask`(headless JS)에서도 실행되는데,
      // 그 인스턴스에는 HomeScreen이 mount된 적이 없어 훅으로 건 구독이 존재하지 않는다
      // (`liveActivityGpsWriteArbitration.ts` 헤더가 같은 클래스의 모듈-상태 비공유를 문서화).
      // native `update()`는 활성 Activity가 없으면 `start()`로 fall-through하며 `pushType: .token`
      // 으로 Activity를 만들고 token을 emit하므로, 구독이 없으면 그 token이 그대로 버려진다.
      // 구독 시작은 멱등이라 매 호출 비용은 사실상 0.
      startAmbientLiveActivityTokenRegistration();
      if (tripToken) {
        // #2806 잔여 절반 — 이 분기도 활성 LA가 전혀 없으면 update-only 가드를 적용한다.
        // `ensureLiveActivityRegistered`는 채널 세션이 없어도 native LA가 살아있으면 adopt
        // (native start 생략)하지만, native LA가 아예 없는 상태(예: BG 첫 tick, lock 직후
        // pre-boarding 훅이 아직 start하지 않은 순간)에서는 여전히 `startLiveActivityWithRegistration`
        // → native start()로 fall-through해 BG 컨텍스트에서 throw할 수 있다. FG의 정식 LA 생성은
        // 별도 경로(pre-boarding 훅 / useEnsureLiveActivity, AppState==='active'에서만 start)가
        // 담당하므로 이 GPS writer는 skip해도 FG 생성 능력에 영향이 없다.
        if (!LiveActivity.hasActiveLiveActivity()) {
          liveActivityLogger.info(
            '활성 LA 없음 — tripToken 분기 update-only 가드로 skip (BG start-fallthrough 방지, #2806 잔여)',
          );
          return;
        }
        await ensureLiveActivityRegistered(tripToken, data);
        // #2735 PR-1 — D1 writer(권위 게이트 통과 후 채널 경유 쓰기).
        logLaWrite({ writer: 'D1', source: 'gps-trip', data, authority: 'not-active' });
      } else {
        // #2806 — tripToken이 없는 이 분기(lock 전 GPS 파이프라인)는 update-only여야 한다.
        // native `update()`는 활성 Activity가 없으면 내부적으로 `start()`로 fall-through하며
        // `Activity.request(pushType: .token)`을 호출하는데, iOS는 BG 컨텍스트에서 신규 LA 생성을
        // 거부(throw)한다 — 그 throw가 아래 catch로 전파돼 일반 알림 폴백 버스트가 된다(실기기 dump
        // la-fallback-notification×14, 전부 트립 경계). mirror 경로(#2610,
        // updateLiveActivityFromMirrorStation)엔 이미 있던 동일 가드를 이 GPS writer에도 적용한다.
        // LA 신규 생성은 정식 트립 시작 경로(`useLiveActivityPreBoardingLifecycle`, destination
        // 설정 시점 FG에서만 발화)에서 담당 — 이 분기는 건드리지 않는다.
        if (!LiveActivity.hasActiveLiveActivity()) {
          liveActivityLogger.info(
            '활성 LA 없음 — GPS writer update-only 가드로 skip (start-fallthrough 방지, #2806)',
          );
          return;
        }
        await LiveActivity.updateLiveActivity(data);
        // #2686 — LA 갱신 횟수 계측(측정 목적, 정책 변경 없음).
        logLiveActivityUpdated();
        // #2735 PR-1 — D1 writer(lock 전 lockless 쓰기, 권위 판정 대상 아님).
        logLaWrite({ writer: 'D1', source: 'gps-lockless', data, authority: 'n/a' });
      }
      // #2610 (code review 2번) — mirror-sourced writer(useForegroundLaMirrorSync)가 이 GPS
      // writer가 방금 쓴 ETA/알람 배지를 blank로 덮어쓰지 않도록 recency arbitration에 stamp.
      markDeviceGpsLiveActivityWrite();
      liveActivityLogger.info('업데이트 성공');
    } catch (e) {
      liveActivityLogger.error('업데이트 실패:', e);
      notifLogger.info('Live Activity 실패 → 알림 fallback');
      const { title, body } = buildContent(currentStation, distanceM, destination, route, etaMinutes, isMock);
      await scheduleFallbackStationNotification(currentStation.name, currentStation.line, { title, body });
    }
    return;
  }

  // Android: 기존 expo-notifications 유지
  const { title, body } = buildContent(currentStation, distanceM, destination, route, etaMinutes, isMock);
  notifLogger.info('Android 알림:', title, body);
  await scheduleFallbackStationNotification(currentStation.name, currentStation.line, { title, body });
  notifLogger.info('알림 예약 완료');
}

async function dismissStationPassedNotification(): Promise<void> {
  await Notifications.dismissNotificationAsync(STATION_PASSED_NOTIFICATION_ID).catch(() => {});
}

export async function clearStationNotification(): Promise<void> {
  // #1094: 위젯은 nearest station 결과를 따로 mirror 하므로 여기서 비우지 않는다.
  // destination이 없거나 경로가 끝나도 사용자가 500m 내 역 근처에 있는 동안엔
  // 위젯이 계속 현재 역을 보여줘야 한다. 위젯 lifecycle은 HomeScreen mirror effect가 담당.
  // #2687 — 알림을 내리는 유일한 지점. 다음 trip의 첫 fallback 발사가 이전 trip과 우연히
  // 같은 (title, body)라 dedup에 막히지 않도록 여기서 무조건 리셋한다.
  resetFallbackNotificationDedup();
  if (Platform.OS === 'ios') {
    if (!LiveActivity.isLiveActivityEnabled()) {
      notifLogger.info('알림 해제 (Live Activity 비활성)');
      await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
      await dismissStationPassedNotification();
      return;
    }
    // #3221 PR-4 (B4) — 안내 종료는 탑승 LA(질문 카드)도 닫는다. 여정 LA 종료 실패와 무관하게 호출한다.
    void endBoardingActivity('clear-station-notification');
    try {
      liveActivityLogger.info('종료 요청');
      // #1288 — 활성 trip이 있으면 backend deregister까지 함께 수행. 활성 trip이 없으면
      // 기존처럼 native end만 호출.
      const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
      if (tripToken) {
        await endLiveActivityWithDeregister(tripToken);
      } else {
        await LiveActivity.endLiveActivity();
      }
      liveActivityLogger.info('종료 성공');
    } catch (e) {
      liveActivityLogger.error('종료 실패:', e);
    }
    await dismissStationPassedNotification();
    return;
  }
  notifLogger.info('Android 알림 해제');
  await Notifications.dismissNotificationAsync(NOTIFICATION_ID);
  await dismissStationPassedNotification();
}

import type { AlarmPhaseId } from './alarmPhases';

/**
 * early(N역 전) 알람 문구 — 안전망 알림·오버레이·Live Activity 알람 레이어가 공용한다.
 * `band`(타깃까지 실제 남은 정거장 수, 기본 칸 제외)가 있으면 백엔드 push와 같은 "N정거장 전" 문구,
 * 없으면 현행 "다음 역 X에서 환승/하차". 보간 변수는 `stops`(i18next `count`는 복수형 규칙과 충돌).
 */
function earlyAlarmCopy(
  stationName: string,
  isTransfer: boolean,
  band?: number,
): { title: string; body: string } {
  const station = getStationDisplayNameByName(stationName, allStations);
  if (band !== undefined) {
    return {
      title: i18next.t(isTransfer ? 'alarms.bandTransferTitle' : 'alarms.bandArrivalTitle', { station, stops: band }),
      body: i18next.t(isTransfer ? 'alarms.bandTransferBody' : 'alarms.bandArrivalBody'),
    };
  }
  return {
    title: i18next.t(isTransfer ? 'notifications.transferEarlyTitle' : 'notifications.arrivalEarlyTitle'),
    body: i18next.t(isTransfer ? 'alarms.earlyTransferBody' : 'alarms.earlyArrivalBody', { station }),
  };
}

const ALARM_MESSAGE_BUILDERS: Record<AlarmPhaseId, (stationName: string, isTransfer: boolean, band?: number) => { title: string; body: string }> = {
  early: (stationName, isTransfer, band) => earlyAlarmCopy(stationName, isTransfer, band),
  imminent: (stationName, isTransfer) => ({
    // #3223 후속 — 역명은 제목에 들어가고 본문은 노선 정보 없는 폴백 문장(AlarmEvent에 다음 노선/방면이 없다).
    title: i18next.t(isTransfer ? 'notifications.transferImminentTitle' : 'notifications.arrivalImminentTitle', {
      station: getStationDisplayNameByName(stationName, allStations),
    }),
    body: i18next.t(isTransfer ? 'alarms.imminentTransferBody' : 'alarms.imminentArrivalBody'),
  }),
};

export function buildAlarmContent(
  event: AlarmEvent,
  source?: NotificationSource,
): { title: string; body: string } {
  const { title, body } = ALARM_MESSAGE_BUILDERS[event.phaseId](event.stationName, event.type === 'transfer', event.band);
  const withSide = appendExitSide(body, resolveExitSide(event));
  const withHint = appendQuickHint(withSide, resolveQuickHint(event));
  const withSource = appendNotificationSource(withHint, source);
  return { title, body: withSource };
}

/**
 * #2379 (Phase 2-device 복원, #2067 되돌리기) — `EXPO_PUBLIC_MINIMAL_ALARM` 플래그 ON일 때
 * BG pipeline(`stationPipeline.ts`)이 잠금 화면에서도 스스로 발사하는 device 로컬 transfer/
 * destination 알람 배너. #2067이 제거한 `sendAlarmNotification`의 visible-알림 발사 로직을
 * `buildAlarmContent` + `scheduleNotification` 재사용으로 복원한다(TTS/진동은 companion
 * (`AlarmLocalAuthority`, #2067 D3)이 별도 채널로 이미 담당하므로 이 함수는 배너만 발사 — 중복
 * 방지).
 */
export async function fireLocalAlarmNotification(
  event: AlarmEvent,
  source?: NotificationSource,
): Promise<void> {
  const { title, body } = buildAlarmContent(event, source);

  await scheduleNotification(ALARM_NOTIFICATION_ID, {
    title,
    body,
    sound: 'alarm.wav',
    ...(Platform.OS === 'android' && {
      channelId: ALARM_CHANNEL_ID,
      priority: Notifications.AndroidNotificationPriority.MAX,
    }),
    // NOTE: critical Entitlement 승인 후 'critical'로 변경 → Sleep Focus 완전 관통
    ...iosTimeSensitiveOption(),
  });
  notifLogger.info('로컬 알람(minimal-alarm):', title, body);
  addDomainBreadcrumb('alarm', 'fire-local', {
    type: event.type,
    phase: event.phaseId,
    station: event.stationName,
    source,
  });
}

export async function clearAlarmNotification(): Promise<void> {
  stopVibration();
  try {
    await Notifications.dismissNotificationAsync(ALARM_NOTIFICATION_ID);
  } catch { /* 무시 */ }
}

/** 매역 알림 대상 종류 — 다음 환승역인지 최종 도착역인지. `StationWaypointKind`의 subset
 *  (backend push discriminator SSoT 재사용. 'intermediate'는 이 맥락에 해당 없음). */
export type StationPassedTargetKind = Extract<StationWaypointKind, 'transfer' | 'destination'>;

/**
 * #918 → #2362 — "역 통과" 알림 title/body 빌더. #2122 FG 보조 발사(`fireFgAuxStationPassedNotification`)와
 * `stationPrescheduler`(#918 OS 사전예약, station-passed kind)가 동일 카피를 공유한다 —
 * 발사 채널(FG 즉시 발사 vs OS 사전 예약)이 달라도 사용자가 보는 문구는 항상 같아야 한다.
 *
 * #2362 — "OO역 통과/지나고 있어요" → "OO역 도착 / {대상}까지 N정거장 남음"으로 교체.
 * `targetKind`는 title/body 문구 자체를 바꾸지 않는다(환승 전/후 모두 동일 "{{target}}까지
 * N정거장" 템플릿) — 호출자가 어느 대상(환승역/도착역)을 넘기는지 명시하는 타입 계약이다
 * (backend waypoint kind와 정합). 기존 locale 키 재사용: `route.stationPassed`(title) +
 * `route.stopsRemainingToDestination`(body, "destination" 파라미터에 환승역명도 그대로 대입 가능).
 */
export function buildStationPassedContent(
  stationName: string,
  count: number,
  targetKind: StationPassedTargetKind,
  targetName: string,
): { title: string; body: string } {
  return {
    title: i18next.t('route.stationPassed', {
      name: getStationDisplayNameByName(stationName, allStations),
    }),
    // #3223 후속 — 환승 target은 "{역} 환승까지 N정거장", 목적지 target은 기존 "{역}까지 N정거장 남음".
    body: i18next.t(targetKind === 'transfer' ? 'route.stopsRemainingToTransfer' : 'route.stopsRemainingToDestination', {
      count,
      destination: getStationDisplayNameByName(targetName, allStations),
    }),
  };
}

/**
 * #2122 (FG 보조 발사) — FG 상태에서 backend alert push의 APNs 전달 지연(실측 35~51s)을
 * 디바이스 자체 arvlcd 판정으로 우회하는 로컬 station-passed 배너.
 *
 * identifier는 backend `stationNotifCollapseId`(backend/alarm-worker/src/scheduled.ts)와
 * 동일한 문자열 규칙(#2063/#2086)으로 빌드한다 — 뒤늦게 도착하는 backend push가 이 로컬 알림을
 * 알림센터에서 최신으로 교체하도록 유도한다(1차 방어선. 실기기 검증 항목, PR 본문 "알려진
 * 잔여 윈도우" 참고. 2차 방어선은 setupNotificationHandler의 isRecentLocalAuxFireDuplicate).
 *
 * device token(APNS_TOKEN_KEY) 미보유 시(등록 전) backend와 동일한 collapse-id를 만들 수 없어
 * 발사를 스킵한다 — 이 경우 사용자는 기존처럼 backend push만 받는다(회귀 아님).
 *
 * #2362 — count/targetKind/targetName은 caller(`useStationAlarm.dispatchStationPassed`)가
 * route hopIndex/waypoint 기반 정수로 도출해 전달한다(GPS 좌표 추정 금지).
 *
 * #2822 — root RCA: data(kind)/categoryIdentifier 없이 `{title, body, sound:false}`만 실려
 * device가 "유령"(무음+kind=unknown)으로 인식하던 결함. 이 배너는 항상 매역 통과(intermediate)
 * 알림이다 — targetKind(transfer/destination)는 카운트다운 "대상"일 뿐 이 알림 자체의 kind가
 * 아니다(회귀 안전: 중간역 tracking은 여전히 무음 유지).
 */
/**
 * #2927 (ADR-040 2단계) — 반환값 `boolean`은 "실제로 로컬 알림을 발사했는지"를 알려준다.
 * useStationAlarm.ts의 유예 타이머 만료 콜백이 이 값으로 스킵(false)과 발사(true)를 구분해야만
 * `device-proxy-fired` 측정 로그를 실제 발사 건에만 정확히 남길 수 있다(#2905 측정 input —
 * 스킵을 발사로 오집계하면 대리 발사 비율이 부풀려진다). 기존 호출부(flag OFF, 즉시 발사
 * 경로)는 이 반환값을 그대로 무시하므로 동작 변화 없음(ⓓ).
 */
export async function fireFgAuxStationPassedNotification(
  stationName: string,
  count: number,
  targetKind: StationPassedTargetKind,
  targetName: string,
  line: string,
): Promise<boolean> {
  // #2902 — 양방향 대칭 가드의 반대쪽 절반. backend push가 먼저 도착해 이미 표시됐다면(위
  // markRemoteShownForBidirectionalDedup이 같은 store에 기록), 이 로컬 발사는 스킵한다 — 발사하지
  // 않으므로 markLocalStationFired도 호출하지 않는다(#2488 회귀 금지: 발사 안 한 경로가 마킹하면
  // 다음 정상 로컬 발사까지 억제된다).
  if (await hasRecentLocalStationFire(stationName, 'station-passed')) return false;
  const deviceToken = await AsyncStorage.getItem(APNS_TOKEN_KEY);
  if (!deviceToken) return false;
  const identifier = buildStationNotifCollapseId(deviceToken);
  const { title, body } = buildStationPassedContent(stationName, count, targetKind, targetName);
  const soundFields = resolveStationNotifSoundFields('intermediate');
  await scheduleNotification(identifier, {
    title,
    body,
    sound: soundFields.sound,
    categoryIdentifier: STATION_TRACKING_CATEGORY,
    data: { kind: 'intermediate', stationName, line },
  });
  await markLocalStationFired(stationName, 'station-passed');
  return true;
}
