import { requireOptionalNativeModule } from 'expo-modules-core';
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
  alarmShortLabel?: string;
  routeSubtext?: string;
  routeSummary?: string;
  etaText?: string;
  etaSubtext?: string;
  distanceText?: string;
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
