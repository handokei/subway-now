import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

const AudioRouteModule =
  Platform.OS === 'web' ? null : requireOptionalNativeModule('AudioRoute');

export function isHeadphonesConnected(): boolean {
  return AudioRouteModule?.isHeadphonesConnected() ?? false;
}
