import {
  type EventSubscription,
  requireOptionalNativeModule,
} from 'expo-modules-core';
import { Platform } from 'react-native';

export interface LiveActivityData {
  stationName: string;
  lineName: string;
  lineColorHex: string;
  destinationName?: string;
  stopsRemaining?: number;
  stopsToTransfer?: number;
  transferStationName?: string;
  stopsFromTransfer?: number;
  stopsToSecondTransfer?: number;
  secondTransferStationName?: string;
  stopsAfterLastTransfer?: number;
  distanceM: number;
  etaMinutes?: number;
  isMock?: boolean;
  alarmType?: 'destination' | 'transfer' | 'approaching';
  alarmStationName?: string;
  // JS에서 i18n으로 빌드해 native로 전달하는 사용자 노출 텍스트.
  // Widget은 이 값들을 우선 사용하고 누락 시 raw 필드로 폴백.
  alarmBody?: string;
  // 좌/우 하차 안내. Swift 위젯이 별도 행으로 표시할 수 있도록 alarmBody와 분리해 노출.
  // 본 PR 시점에는 JS만 채워두고 Swift UI 반영은 후속 PR에서 진행한다.
  alarmExitSide?: 'left' | 'right' | 'both';
  alarmShortLabel?: string;
  routeSubtext?: string;
  routeSummary?: string;
  etaText?: string;
  etaSubtext?: string;
  distanceText?: string;
  // 데이터 출처 자백 라벨 (#327). JS에서 i18n으로 빌드해 전달.
  // 누락 시 위젯/LA는 라벨 표시 생략 — 기존 인스턴스 호환 안전.
  sourceLabel?: string;
  // #2434 — LA interactive prompt piece ①. 순수 데이터 필드만 (버튼/AppIntent는 후속 piece).
  // 전부 optional — 미전달 시 native ContentState가 nil로 decode돼 기존 렌더와 100% 동일.
  boardingPhase?: 'pre-boarding' | 'boarded' | 'hop-end' | 'arrival';
  boardingPromptTripToken?: string;
  boardingPromptOriginStation?: string;
  boardingPromptLine?: string;
}

const LiveActivityModule =
  Platform.OS === 'ios' ? requireOptionalNativeModule('LiveActivity') : null;

export function startLiveActivity(data: LiveActivityData): Promise<void> {
  return LiveActivityModule?.startLiveActivity(data) ?? Promise.resolve();
}

export function updateLiveActivity(data: LiveActivityData): Promise<void> {
  return LiveActivityModule?.updateLiveActivity(data) ?? Promise.resolve();
}

export function endLiveActivity(): Promise<void> {
  return LiveActivityModule?.endLiveActivity() ?? Promise.resolve();
}

export function isLiveActivityEnabled(): boolean {
  return LiveActivityModule?.isLiveActivityEnabled() ?? false;
}

export function saveWidgetStation(
  stationName: string,
  lineColor: string,
  distanceM: number,
  savedAt: number = Date.now(),
): Promise<void> {
  return (
    LiveActivityModule?.saveWidgetStation(
      stationName,
      lineColor,
      distanceM,
      savedAt,
    ) ?? Promise.resolve()
  );
}

/**
 * #1781 — trip 활성 시 위젯에 추가 맥락(현재역/환승역/도착역)을 전달.
 * `saveWidgetStation`과 분리해 backward compat를 유지한다.
 * - tripActive=false 또는 호출 생략 시 Swift 위젯이 기존 nearest station UI로 폴백.
 */
export function saveWidgetTripContext(
  currentStationName: string | null,
  destinationName: string | null,
  nextTransferName: string | null,
  tripActive: boolean,
): Promise<void> {
  return (
    LiveActivityModule?.saveWidgetTripContext(
      currentStationName,
      destinationName,
      nextTransferName,
      tripActive,
    ) ?? Promise.resolve()
  );
}

export function clearWidgetStation(): Promise<void> {
  return LiveActivityModule?.clearWidgetStation() ?? Promise.resolve();
}

const NOOP_SUBSCRIPTION: EventSubscription = { remove: () => undefined };

export interface PushTokenEvent {
  token: string;
}

/**
 * iOS 16.2+ Live Activity push token (hex string) 갱신 구독.
 * 비 iOS / 모듈 미설치 환경에서는 no-op subscription 반환.
 */
export function addPushTokenListener(
  listener: (event: PushTokenEvent) => void,
): EventSubscription {
  return LiveActivityModule?.addListener('onPushToken', listener) ?? NOOP_SUBSCRIPTION;
}

/**
 * Activity가 `.ended` / `.dismissed`로 전이된 시점 구독.
 * backend에서 token deregister 트리거로 사용 (이슈 #609 후속 PR B).
 */
export function addActivityEndedListener(
  listener: () => void,
): EventSubscription {
  return LiveActivityModule?.addListener('onActivityEnded', listener) ?? NOOP_SUBSCRIPTION;
}

/**
 * 사용자가 Live Activity를 직접 swipe-to-dismiss 한 시점 구독 (#967).
 * 앱이 `endLiveActivity()` 호출로 종료된 경우는 emit되지 않는다 — dismiss sentinel은
 * 사용자 의도만 반영해야 silent push의 LA refresh 차단 정책(#926)이 올바르게 동작한다.
 *
 * payload:
 *  - dismissedAt: unix ms (native 시각)
 *  - reason: 현재는 항상 `'user'` — native가 사용자 swipe 경로에서만 emit
 */
export interface ActivityDismissedEvent {
  dismissedAt: number;
  reason: 'user';
}

export function addActivityDismissedListener(
  listener: (event: ActivityDismissedEvent) => void,
): EventSubscription {
  return (
    LiveActivityModule?.addListener('onActivityDismissed', listener) ?? NOOP_SUBSCRIPTION
  );
}
