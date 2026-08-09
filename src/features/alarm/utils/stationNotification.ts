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
import { DirectRoute, TransferRoute, MultiTransferRoute, normalizeStationName } from '../../../shared/utils/stationRoute';
import type { AlarmEvent } from './stationAlarm';
import * as LiveActivity from 'live-activity';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY, APNS_TOKEN_KEY } from '../../../shared/constants/storageKeys';
import {
  ensureLiveActivityRegistered,
  endLiveActivityWithDeregister,
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
import type { StationWaypointKind } from '../../../shared/types/pushContract';

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

export const NOTIFICATION_ID = 'current-station';
export const ALARM_NOTIFICATION_ID = 'station-alarm';
const ALARM_CHANNEL_ID = 'station-alarm';
/** #2158 — 일반모드 stationPrescheduler가 재사용하는 무음 채널(sound:null, bypassDnd 없음). */
export const ALARM_SILENT_CHANNEL_ID = 'station-alarm-silent';
export const STATION_PASSED_NOTIFICATION_ID = 'station-passed';
const STATION_PASSED_CHANNEL_ID = 'station-passed';


async function scheduleNotification(
  id: string,
  content: { title: string; body: string; sound?: boolean | string; channelId?: string; interruptionLevel?: 'timeSensitive' | 'critical'; priority?: Notifications.AndroidNotificationPriority },
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

export function setupNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const isAlarm = notification.request.identifier === ALARM_NOTIFICATION_ID;
      const hasSound = notification.request.content.sound != null;
      // #574 P2e — silent push가 이미 fired한 pushId의 alert fallback이 race로 도달했을 때
      // FG에서 중복 표시 차단. BG에선 iOS가 직접 표시해 JS 개입 불가(P2e 한계 명시).
      if (await isFallbackDuplicate(notification)) {
        return SUPPRESSED_NOTIFICATION_BEHAVIOR;
      }
      // #2122 — FG 보조 발사(로컬 station-passed 알림) 직후 뒤늦게 도착한 backend alert push가
      // 같은 (station, kind)면 2차 방어선으로 표시 억제(1차는 apns-collapse-id 문자열 일치).
      if (await isRecentLocalAuxFireDuplicate(notification)) {
        return SUPPRESSED_NOTIFICATION_BEHAVIOR;
      }
      return {
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: isAlarm && hasSound,
        shouldSetBadge: false,
      };
    },
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
  const title = destination
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
      await scheduleNotification(NOTIFICATION_ID, { title, body });
      notifLogger.info('알림 예약 완료:', title, body);
      return;
    }
    const data = buildLiveActivityData(currentStation, distanceM, destination, route, etaMinutes, isMock, alarmEvent, source);
    try {
      liveActivityLogger.info('업데이트 요청');
      // #1288 — 활성 trip이 있으면 LA push 토큰 등록 채널을 거친다. 활성 trip이 없으면
      // 기존처럼 update만 호출(LA push 미등록은 silent, LA 자체는 정상 동작).
      const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
      if (tripToken) {
        await ensureLiveActivityRegistered(tripToken, data);
      } else {
        await LiveActivity.updateLiveActivity(data);
      }
      liveActivityLogger.info('업데이트 성공');
    } catch (e) {
      liveActivityLogger.error('업데이트 실패:', e);
      notifLogger.info('Live Activity 실패 → 알림 fallback');
      const { title, body } = buildContent(currentStation, distanceM, destination, route, etaMinutes, isMock);
      await scheduleNotification(NOTIFICATION_ID, { title, body });
    }
    return;
  }

  // Android: 기존 expo-notifications 유지
  const { title, body } = buildContent(currentStation, distanceM, destination, route, etaMinutes, isMock);
  notifLogger.info('Android 알림:', title, body);
  await scheduleNotification(NOTIFICATION_ID, { title, body });
  notifLogger.info('알림 예약 완료');
}

async function dismissStationPassedNotification(): Promise<void> {
  await Notifications.dismissNotificationAsync(STATION_PASSED_NOTIFICATION_ID).catch(() => {});
}

export async function clearStationNotification(): Promise<void> {
  // #1094: 위젯은 nearest station 결과를 따로 mirror 하므로 여기서 비우지 않는다.
  // destination이 없거나 경로가 끝나도 사용자가 500m 내 역 근처에 있는 동안엔
  // 위젯이 계속 현재 역을 보여줘야 한다. 위젯 lifecycle은 HomeScreen mirror effect가 담당.
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

export async function clearAlarmNotification(): Promise<void> {
  stopVibration();
  try {
    await Notifications.dismissNotificationAsync(ALARM_NOTIFICATION_ID);
  } catch { /* 무시 */ }
}

/**
 * #918 — "역 통과" 알림 title/body 빌더. #2122 FG 보조 발사(`fireFgAuxStationPassedNotification`)와
 * `stationPrescheduler`(#918 OS 사전예약, station-passed kind)가 동일 카피를 공유한다 —
 * 발사 채널(FG 즉시 발사 vs OS 사전 예약)이 달라도 사용자가 보는 문구는 항상 같아야 한다.
 */
export function buildStationPassedContent(stationName: string): { title: string; body: string } {
  return {
    title: i18next.t('route.intermediatePassedTitle'),
    body: i18next.t('route.intermediatePassedBody', {
      name: getStationDisplayNameByName(stationName, allStations),
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
 */
export async function fireFgAuxStationPassedNotification(stationName: string): Promise<void> {
  const deviceToken = await AsyncStorage.getItem(APNS_TOKEN_KEY);
  if (!deviceToken) return;
  const identifier = buildStationNotifCollapseId(deviceToken);
  const { title, body } = buildStationPassedContent(stationName);
  await scheduleNotification(identifier, { title, body, sound: false });
  await markLocalStationFired(stationName, 'station-passed');
}
