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
  distanceM: number;
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
