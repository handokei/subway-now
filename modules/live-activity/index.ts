import {
  type EventSubscription,
  requireOptionalNativeModule,
} from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * #1389 PR-4 — Live Activity 정합성 fallback 표시 모드 enum.
 *
 * Swift mirror: `targets/subway-widget/_shared/SubwayActivityAttributes.swift` 의 `displayMode`
 * 필드와 동일 값 스트링. JS는 wire format 침범 없이 enum-typed 키만 사용.
 *  - 'confirmed' (기본): 위젯이 stationName/etaText를 그대로 표시
 *  - 'unconfirmed': 위젯이 station 자리에 `unconfirmedText` (또는 universal "—") 표시,
 *    alarm 긴급 강조 비활성화
 */
export const LA_DISPLAY_MODE = {
  CONFIRMED: 'confirmed',
  UNCONFIRMED: 'unconfirmed',
} as const;
export type LaDisplayMode = (typeof LA_DISPLAY_MODE)[keyof typeof LA_DISPLAY_MODE];

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
  /**
   * #1389 PR-4 — 정합성 fallback 플래그. 기본 누락 = 'confirmed' 동작.
   * 'unconfirmed'면 위젯이 station/eta 자리를 placeholder로 렌더링한다.
   */
  displayMode?: LaDisplayMode;
  /**
   * #1389 PR-4 — fallback 모드에서 station 자리에 표시할 i18n 문구.
   * JS init/update가 채워 보내며, 누락 시 위젯은 universal "—" 로 폴백.
   */
  unconfirmedText?: string;
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
