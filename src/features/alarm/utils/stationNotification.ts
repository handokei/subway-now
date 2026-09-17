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
import { DirectRoute, TransferRoute, MultiTransferRoute, normalizeStationName, isSameStationName } from '../../../shared/utils/stationRoute';
import type { AlarmEvent } from './stationAlarm';
import * as LiveActivity from 'live-activity';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY, APNS_TOKEN_KEY } from '../../../shared/constants/storageKeys';
import {
  ensureLiveActivityRegistered,
  endLiveActivityWithDeregister,
  shouldSkipDeviceLiveActivityWrite,
  startAmbientLiveActivityTokenRegistration,
} from './liveActivityPushChannel';
import { stopVibration } from './alarmSound';
import { createLogger } from '../../../shared/utils/logger';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';
import { getStationDisplayName, getStationDisplayNameByName } from '../../../shared/utils/stationDisplay';
import { hasFiredPushId } from './firedPushIds';
import stationsData from '../../../data/stations.json';
import type { ExitSide } from '../../../shared/types/exitSide';
import { lookupExitSide } from '../../route/utils/exitSide';
import { hasQuickExitData } from '../../route/utils/quickExit';
import { lookupPlatformExitSide } from '../../../shared/utils/platformExitSideLookup';
import { findStationByName } from '../../../shared/utils/stationLookup';
import {
  notificationSourceI18nKey,
  shouldDiscloseNotificationSource,
  type NotificationSource,
} from './notificationSource';
import { buildStationNotifCollapseId } from './stationNotifCollapseId';
import { markLocalStationFired, hasRecentLocalStationFire } from './recentLocalStationFires';
import {
  readBackendSsotMirror,
  isBackendSsotMirrorFresh,
  resolveBackendSsotMirrorStation,
  type BackendSsotMirrorEntry,
} from './backendSsotMirror';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { markDeviceGpsLiveActivityWrite } from './liveActivityGpsWriteArbitration';
import { getLegAdvance } from './legAdvanceStorage';
import { isStationWaypointKind, type StationWaypointKind } from '../../../shared/types/pushContract';
import { BOARDING_PROMPT_CATEGORY, DISEMBARK_PROMPT_CATEGORY } from './notificationCategory';
import type { LineNumber } from '../../../shared/types/station';
import { logFiredLaFallbackNotification, logSuppressedLaFallbackContentDedup } from './alarmLog';
import {
  logPushReceipt,
  mapWaypointKindToReceiptKind,
} from '../../observability/utils/pushReceiptLog';

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
 * 옵션 spread 단일 진입점. `fireLocalAlarmNotification`/`fireLocalBoardingPromptNotification`
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
 * #2687 — LA fallback 알림(iOS LA 비활성/예외, Android) content dedup.
 *
 * LA가 죽어 있으면 GPS/BG 파이프라인(stationPipeline.ts)과 FG effect(HomeScreen.tsx)가
 * 고빈도로 `updateStationNotification`을 호출하는데, 직전 발사와 (title, body)가 완전히
 * 같아도 무조건 재예약해 iOS가 매번 새 배너를 띄우던 회귀(동일 내용 30회+ 폭주)를 막는다.
 *
 * 기준은 **내용 동일성**이지 시간이 아니다 — 내용이 바뀌면 dedup 없이 즉시 갱신돼야 한다.
 * (title, body)가 조금이라도 다르면 통과시킨다.
 */
let lastFallbackNotificationContent: { title: string; body: string } | null = null;

/** trip 종료/알림 해제 시 리셋 — 다음 trip 첫 발사가 이전 trip 내용과 우연히 같아도 막히지 않게. */
function resetFallbackNotificationDedup(): void {
  lastFallbackNotificationContent = null;
}

/** 테스트용 — 모듈 in-memory dedup 상태를 test case 사이에 격리. */
export function _resetFallbackNotificationDedupForTests(): void {
  resetFallbackNotificationDedup();
}

async function scheduleFallbackStationNotification(
  stationName: string,
  content: { title: string; body: string },
): Promise<void> {
  const { title, body } = content;
  if (
    lastFallbackNotificationContent != null &&
    lastFallbackNotificationContent.title === title &&
    lastFallbackNotificationContent.body === body
  ) {
    logSuppressedLaFallbackContentDedup(stationName);
    return;
  }
  lastFallbackNotificationContent = { title, body };
  await scheduleNotification(NOTIFICATION_ID, content);
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
      logAlertPushReceipt(notification, true);
      return {
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: (isAlarm || isPromptCategory) && hasSound,
        shouldSetBadge: false,
      };
    },
  });
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

/** #2591 (code review 6번) — 로컬 boarding-prompt 억제 판정 자체의 TTL dedup 키. 발사
 *  dedup(`LOCAL_BOARDING_PROMPT_FIRE_KIND`)와 별개 kind — 억제된 origin은 이 TTL 동안
 *  mirror/legAdvance 재조회·재로깅 없이 조용히 skip한다(호출부가 매 polling cycle마다
 *  재평가하는 `useLocalBoardingPromptGate` 특성상 무한 재실행 IO/로그 스팸을 방지). */
export const LOCAL_BOARDING_PROMPT_SUPPRESS_KIND = 'boarding-prompt-suppressed';

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
function exitSideText(side: ExitSide): string {
  if (side === 'left') return i18next.t('alarms.exitSideLeft');
  if (side === 'right') return i18next.t('alarms.exitSideRight');
  return i18next.t('alarms.exitSideBoth');
}

function appendExitSide(body: string, side?: ExitSide | null): string {
  if (!side) return body;
  return `${body}\n${exitSideText(side)}`;
}

// 좌/우 하차 방향 해석 (#1504):
//   1) Primary — `lookupExitSide(name, direction)` (사용자 검수형 direction-aware SSOT).
//   2) Fallback — primary가 null이면 stations.json id로 `lookupPlatformExitSide(id)` 조회
//      (승강장 구조 기반 static SSOT, direction 무관). #1482에서 추가된 265역 커버.
//   3) 둘 다 null이면 기존처럼 좌/우 라인을 생략한다.
//
// fallback은 direction 부재(motion gate 미확정 등)나 사용자 검수 데이터 누락 케이스에서
// 좌/우 안내를 살려준다. direction이 있는 경우에도 primary가 우선이라 정확도 회귀 없음.
function resolveExitSide(event: AlarmEvent): ExitSide | null {
  const direct = event.direction
    ? lookupExitSide(event.stationName, event.direction)
    : null;
  if (direct) return direct;
  const station = findStationByName(event.stationName);
  if (!station) return null;
  return lookupPlatformExitSide(station.id);
}

// 알람 본문에 추상적 빠른하차 힌트를 붙일지 결정. 해당 역의 빠른하차 데이터가 있을 때만 표시한다.
// 알람 타입에 따라 transfer/arrival 두 가지 카피로 분기.
function resolveQuickHint(event: AlarmEvent): string | null {
  const station =
    allStations.find((s) => s.name === event.stationName) ??
    allStations.find((s) => normalizeStationName(s.name) === normalizeStationName(event.stationName));
  if (!station) return null;
  if (!hasQuickExitData(station.id)) return null;
  return event.type === 'transfer'
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
  etaMinutes?: number | null,
  isMock?: boolean,
  alarmEvent?: AlarmEvent | null,
  source?: NotificationSource,
  boardingPrompt?: BoardingPromptLiveActivityFields | null,
): LiveActivity.LiveActivityData {
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
    } else {
      const [first, second] = route.transfers;
      data.stopsToTransfer = first.stopsToTransfer;
      data.transferStationName = getStationDisplayNameByName(first.transferName, allStations);
      data.stopsToSecondTransfer = second.stopsToTransfer;
      data.secondTransferStationName = getStationDisplayNameByName(second.transferName, allStations);
      data.stopsAfterLastTransfer = route.stopsAfterLastTransfer;
    }
  }

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
    const rawBody = i18next.t(isTransferAlarm ? 'alarms.earlyTransferBody' : 'alarms.earlyArrivalBody', {
      station: data.alarmStationName,
    });
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
): Promise<void> {
  notifLogger.info('updateStation:', currentStation.name, `${distanceM}m`, destination ? `→ ${destination.name}` : '');

  if (Platform.OS === 'ios') {
    const liveActivityEnabled = LiveActivity.isLiveActivityEnabled();
    liveActivityLogger.info('isLiveActivityEnabled:', liveActivityEnabled);

    if (!liveActivityEnabled) {
      notifLogger.info('Live Activity 비활성 → 알림 fallback');
      const { title, body } = buildContent(currentStation, distanceM, destination, route, etaMinutes, isMock);
      await scheduleFallbackStationNotification(currentStation.name, { title, body });
      notifLogger.info('알림 예약 완료:', title, body);
      return;
    }
    const data = buildLiveActivityData(currentStation, distanceM, destination, route, etaMinutes, isMock, alarmEvent, source);
    try {
      liveActivityLogger.info('업데이트 요청');
      // #1288 — 활성 trip이 있으면 LA push 토큰 등록 채널을 거친다. 활성 trip이 없으면
      // 기존처럼 update만 호출(LA push 미등록은 silent, LA 자체는 정상 동작).
      const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
      // #2481 — backend-authority 모드 + 이미 backend가 이 trip의 LA push 채널을 쥐고 있으면
      // device GPS 추정치로 backend의 정확한 "N정거장"을 덮어쓰지 않는다(Wave 2).
      if (shouldSkipDeviceLiveActivityWrite(tripToken)) {
        liveActivityLogger.info('backend-authority 활성 trip — device LA 쓰기 스킵(backend push 단독 저자)');
        return;
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
        await ensureLiveActivityRegistered(tripToken, data);
      } else {
        await LiveActivity.updateLiveActivity(data);
      }
      // #2610 (code review 2번) — mirror-sourced writer(useForegroundLaMirrorSync)가 이 GPS
      // writer가 방금 쓴 ETA/알람 배지를 blank로 덮어쓰지 않도록 recency arbitration에 stamp.
      markDeviceGpsLiveActivityWrite();
      liveActivityLogger.info('업데이트 성공');
    } catch (e) {
      liveActivityLogger.error('업데이트 실패:', e);
      notifLogger.info('Live Activity 실패 → 알림 fallback');
      const { title, body } = buildContent(currentStation, distanceM, destination, route, etaMinutes, isMock);
      await scheduleFallbackStationNotification(currentStation.name, { title, body });
    }
    return;
  }

  // Android: 기존 expo-notifications 유지
  const { title, body } = buildContent(currentStation, distanceM, destination, route, etaMinutes, isMock);
  notifLogger.info('Android 알림:', title, body);
  await scheduleFallbackStationNotification(currentStation.name, { title, body });
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

const ALARM_MESSAGE_BUILDERS: Record<AlarmPhaseId, (stationName: string, isTransfer: boolean) => { title: string; body: string }> = {
  early: (stationName, isTransfer) => ({
    title: i18next.t(isTransfer ? 'notifications.transferEarlyTitle' : 'notifications.arrivalEarlyTitle'),
    body: i18next.t(isTransfer ? 'alarms.earlyTransferBody' : 'alarms.earlyArrivalBody', {
      station: getStationDisplayNameByName(stationName, allStations),
    }),
  }),
  imminent: (stationName, isTransfer) => ({
    title: i18next.t(isTransfer ? 'notifications.transferImminentTitle' : 'notifications.arrivalImminentTitle'),
    body: i18next.t(isTransfer ? 'alarms.imminentTransferBody' : 'alarms.imminentArrivalBody', {
      station: getStationDisplayNameByName(stationName, allStations),
    }),
  }),
};

export function buildAlarmContent(
  event: AlarmEvent,
  source?: NotificationSource,
): { title: string; body: string } {
  const { title, body } = ALARM_MESSAGE_BUILDERS[event.phaseId](event.stationName, event.type === 'transfer');
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
    body: i18next.t('route.stopsRemainingToDestination', {
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
 */
export async function fireFgAuxStationPassedNotification(
  stationName: string,
  count: number,
  targetKind: StationPassedTargetKind,
  targetName: string,
): Promise<void> {
  const deviceToken = await AsyncStorage.getItem(APNS_TOKEN_KEY);
  if (!deviceToken) return;
  const identifier = buildStationNotifCollapseId(deviceToken);
  const { title, body } = buildStationPassedContent(stationName, count, targetKind, targetName);
  await scheduleNotification(identifier, { title, body, sound: false });
  await markLocalStationFired(stationName, 'station-passed');
}

/**
 * #2422 — "탔어요?" boarding-prompt title/body 빌더. backend `buildBoardingPromptMessage`
 * (backend/alarm-worker/src/scheduled.ts)의 device 쪽 대응 — ETA 절대시각까지는 복제하지 않는다
 * (단순성. 이 로컬 발사는 backend remote push의 fallback 안전망이라 표시 정보가 backend와
 * 100% 동일할 필요는 없다. 사용자는 앱 홈 화면에서 이미 ETA를 보고 있다).
 */
/**
 * #2528 — LA AlertConfiguration도 이 문구를 재사용한다(`useLiveActivityPreBoardingLifecycle`) —
 * 백업 알림과 LA 잠금화면 alert가 동일한 문구로 사용자에게 일관되게 보이도록.
 */
export function buildBoardingPromptContent(
  originStation: string,
  line: string,
): { title: string; body: string } {
  return {
    title: i18next.t('route.boardingPromptTitle'),
    body: i18next.t('route.boardingPromptBody', {
      line: LINE_NAMES[line as LineNumber] ?? line,
      originStation: getStationDisplayNameByName(originStation, allStations),
    }),
  };
}

/** #2422 — 로컬 boarding-prompt 알림 identifier prefix. 매 발사마다 station+시각을 붙여 유일화
 *  (동일 identifier 재사용은 `useBoardingPromptDisplayLogger`의 dedup Set이 두 번째 발사부터
 *  displayed 카운트를 영구 억제하는 부작용이 있다 — #2422 PR 리뷰 참고). */
const LOCAL_BOARDING_PROMPT_ID_PREFIX = 'boarding-prompt-local';

/**
 * #2591 (code review 3번) — backend SSoT mirror가 가리키는 역이 origin과 실제로 "다른 역"인지
 * 판정하는 단일 진입점. 문자열 raw 비교(`mirror.currentStationId !== originStation`)는
 * #1410/#2566 클래스의 표기 drift(같은 역의 다른 표기)를 진행으로 오판할 위험이 있어,
 * `resolveBackendSsotMirrorStation`(canonical Station 해석, #2589 SSoT 진입점)로 먼저 resolve하고
 * `isSameStationName`(별칭/정규화 동일성, `normalizeStationName` 경유)으로 비교한다.
 *
 * - resolve 실패('unresolved') — mirror의 역/노선 조합이 stations.json에서 해석되지 않음(데이터
 *   drift 의심). 판정 불확실 = 발사(억제 안 함, item 3 명시 요구사항).
 * - 'confirmed-same' — 정규화 후 origin과 동일 — 여전히 출발역(#2422 SPOF 커버 유지, 발사).
 * - 'confirmed-different' — 정규화 후에도 다른 역 — 여정 진행 확정(억제 대상).
 */
function classifyMirrorAgainstOrigin(
  mirror: Pick<BackendSsotMirrorEntry, 'currentStationId' | 'currentStationLine'>,
  originStation: string,
): 'confirmed-different' | 'confirmed-same' | 'unresolved' {
  const resolved = resolveBackendSsotMirrorStation(mirror);
  if (resolved === null) return 'unresolved';
  return isSameStationName(resolved.name, originStation) ? 'confirmed-same' : 'confirmed-different';
}

type LocalBoardingPromptMirrorGate =
  | { action: 'suppress'; reason: 'journey-progressed' }
  | {
      action: 'fire';
      /** 발사는 하되 mirror가 이 판정에 쓰이지 못한 이유(잔여 창 field 진단용, item 4). */
      mirrorDiagnostic?: 'mirror-missing' | 'mirror-stale' | 'mirror-cross-trip' | 'mirror-unresolved';
    };

/**
 * #2591 (code review 2/3/4번) — backend SSoT mirror 기반 여정 진행 판정. 원칙(코디네이터 지시,
 * #2606 transfer 리스트 게이트와 반대 방향): 이 게이트는 "사용자 명시 의향" 게이트의 SPOF
 * 보조망이라 **판정 불확실 시 보수 = 발사(억제 아님)** — #2606은 반대로 보수=거부다. 그래서
 * mirror가 조금이라도 신뢰 불가능/불확실하면 무조건 'fire'를 반환한다.
 *
 * - mirror 부재 → fire(mirror-missing).
 * - #2591 (code review 2번) — corrId 교차 가드. mirror.corrId와 현재 trip corrId
 *   (`getCurrentTripCorrIdSync`)가 둘 다 있고 불일치하면, 옛 trip의 mirror가 race로 revive되어
 *   새 trip 첫 프롬프트를 잘못 억제하는 것(race A)을 막기 위해 이 mirror를 판정에 쓰지 않는다
 *   → fire(mirror-cross-trip). 어느 한쪽이 없으면(레거시 저장분 등) 기존처럼 same-trip 취급.
 * - stale(>180s, `isBackendSsotMirrorFresh`) → fire(mirror-stale) — backend 생존이 확인되지
 *   않아 SPOF 커버가 여전히 필요하다.
 * - fresh + `classifyMirrorAgainstOrigin`이 'unresolved' → fire(mirror-unresolved).
 * - fresh + 'confirmed-same' → fire(진단 태그 없음 — 정상 SPOF 발사).
 * - fresh + 'confirmed-different' → suppress('journey-progressed') — backend 생존 + 여정
 *   진행이 모두 확정된 유일한 케이스.
 */
function evaluateLocalBoardingPromptMirrorGate(
  mirror: BackendSsotMirrorEntry | null,
  originStation: string,
): LocalBoardingPromptMirrorGate {
  if (mirror === null) return { action: 'fire', mirrorDiagnostic: 'mirror-missing' };

  const currentCorrId = getCurrentTripCorrIdSync();
  if (mirror.corrId !== undefined && currentCorrId !== null && mirror.corrId !== currentCorrId) {
    return { action: 'fire', mirrorDiagnostic: 'mirror-cross-trip' };
  }

  if (!isBackendSsotMirrorFresh(mirror)) {
    return { action: 'fire', mirrorDiagnostic: 'mirror-stale' };
  }

  const classification = classifyMirrorAgainstOrigin(mirror, originStation);
  if (classification === 'unresolved') {
    return { action: 'fire', mirrorDiagnostic: 'mirror-unresolved' };
  }
  if (classification === 'confirmed-same') {
    return { action: 'fire' };
  }
  return { action: 'suppress', reason: 'journey-progressed' };
}

/**
 * #2422 (방향 A) — device FG 로컬 boarding-prompt 단일권위 발사.
 *
 * backend remote alert push(주 채널)가 미발송/전달실패해도 device가 FG에서 동일 게이트
 * (`localBoardingPromptGate.ts`)를 통과하면 로컬로 직접 발사한다 — ADR-033(station-passed FG
 * 보조 발사)과 동일 패턴.
 *
 * `useBoardingPromptResponder`가 파싱하는 payload schema(`BoardingPromptPayload`)와 동일한
 * shape으로 `content.data`를 채운다 — [탑승]/[미탑승] 액션 버튼(BOARDING_PROMPT_CATEGORY)이
 * 로컬 발사든 원격 발사든 동일하게 동작한다.
 *
 * tripToken은 `ACTIVE_TRIP_KEY`(backend register 성공 시에만 set)를 요구한다 — 아직 register가
 * 안 된 trip은 이 로컬 발사도 스킵(register 자체의 실패는 이 안전망의 범위 밖. 이 안전망은
 * "register는 됐지만 backend cron/APNs 전달이 실패"하는 SPOF만 커버한다).
 *
 * dedup: `recentLocalStationFires`(#2122 선례)로 같은 originStation 재발사를 TTL(2분) 동안 억제.
 * 반환값은 실제 발사 여부(테스트/로깅 용) — 게이트 자체는 caller(`useLocalBoardingPromptGate`)가
 * 이미 통과한 상태로 호출한다.
 *
 * #2591 — 데스크 trip 실증(무음·무진동 전달 + "용마산 탑승?" 오표기 의심)에서 확정된 fix:
 * 1) presentation 동급화 — backend 채널(`sendBoardingPromptPush`, apns.ts)은 이미
 *    `sound: default` + `interruption-level: time-sensitive`인데 이 로컬 채널만 미전달이었다
 *    (Android도 `fireLocalAlarmNotification`과 동형으로 ALARM_CHANNEL_ID + MAX priority 지정).
 *    사용자 게이트(놓치면 leg가 lockless로 남음)이므로 도착 알림과 동급 이상의 주의 획득이 필요.
 * 2) 여정 진행 중 억제 게이트(`evaluateLocalBoardingPromptMirrorGate`) — backend SSoT mirror가
 *    fresh하고 origin과 다른 역을 확정적으로 가리킬 때만 억제한다. **판정 불확실 시 보수 =
 *    발사**(코디네이터 지시 — #2606 transfer 리스트의 "보수=거부"와 정반대 방향. 이 게이트는
 *    놓치면 leg가 lockless로 방치되는 사용자 명시 의향 게이트라 false negative가 false positive
 *    보다 비싸다).
 * 3) legAdvance stamp(#2278, 사용자 명시 하차 응답 — GPS 무관) 기반 추가 억제 — mirror가
 *    stale/부재라도 다른 채널(hop-end 응답 등)로 이미 이 leg가 확인됐으면 억제한다.
 * 4) 잔여 창(root RCA 항목 4) — legAdvance도 미확인이고 mirror도 이 판정에 못 쓰이는 상태
 *    (stale/부재/cross-trip/unresolved)에서 발사하는 경우는 코드로 완전히 봉합하지 못한다.
 *    침묵하지 않고 `local_boarding_prompt_fired_mirror_unconfirmed` breadcrumb으로 field 진단
 *    가능하게 남긴다 (PR 본문 "잔여 창" 항목 참고).
 * 5) 억제 자체도 `LOCAL_BOARDING_PROMPT_SUPPRESS_KIND` TTL dedup — 같은 origin을 매 polling
 *    cycle마다 재평가/재로깅하는 무한 재실행(IO/로그 스팸)을 차단한다.
 */
export async function fireLocalBoardingPromptNotification(
  originStation: string,
  line: string,
  destinationDirection: 'up' | 'down' | null,
): Promise<boolean> {
  if (await hasRecentLocalStationFire(originStation, LOCAL_BOARDING_PROMPT_FIRE_KIND)) {
    return false;
  }
  if (await hasRecentLocalStationFire(originStation, LOCAL_BOARDING_PROMPT_SUPPRESS_KIND)) {
    return false;
  }
  const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
  if (!tripToken) return false;

  const legAdvance = await getLegAdvance();
  if (legAdvance !== null && legAdvance.nextLine === line) {
    await markLocalStationFired(originStation, LOCAL_BOARDING_PROMPT_SUPPRESS_KIND);
    notifLogger.info(
      `local-boarding-prompt-suppressed reason=leg-advance-confirmed origin=${originStation} line=${line}`,
    );
    addDomainBreadcrumb('boarding', 'local_boarding_prompt_suppressed', {
      originStation,
      line,
      reason: 'leg-advance-confirmed',
    });
    return false;
  }

  const mirror = await readBackendSsotMirror();
  const mirrorGate = evaluateLocalBoardingPromptMirrorGate(mirror, originStation);
  if (mirrorGate.action === 'suppress') {
    await markLocalStationFired(originStation, LOCAL_BOARDING_PROMPT_SUPPRESS_KIND);
    notifLogger.info(
      `local-boarding-prompt-suppressed reason=${mirrorGate.reason} origin=${originStation} mirrorStation=${mirror?.currentStationId}`,
    );
    addDomainBreadcrumb('boarding', 'local_boarding_prompt_suppressed', {
      originStation,
      line,
      reason: mirrorGate.reason,
    });
    return false;
  }
  if (mirrorGate.mirrorDiagnostic) {
    addDomainBreadcrumb('boarding', 'local_boarding_prompt_fired_mirror_unconfirmed', {
      originStation,
      line,
      mirrorDiagnostic: mirrorGate.mirrorDiagnostic,
    });
  }

  const identifier = `${LOCAL_BOARDING_PROMPT_ID_PREFIX}:${originStation}:${Date.now()}`;
  const { title, body } = buildBoardingPromptContent(originStation, line);
  await scheduleNotification(identifier, {
    title,
    body,
    sound: true,
    ...(Platform.OS === 'android' && {
      channelId: ALARM_CHANNEL_ID,
      priority: Notifications.AndroidNotificationPriority.MAX,
    }),
    ...iosTimeSensitiveOption(),
    categoryIdentifier: BOARDING_PROMPT_CATEGORY,
    data: {
      kind: 'boarding-prompt',
      originStation,
      line,
      tripToken,
      ...(destinationDirection ? { destinationDirection } : {}),
    },
  });
  await markLocalStationFired(originStation, LOCAL_BOARDING_PROMPT_FIRE_KIND);
  return true;
}
