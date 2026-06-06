import { requireOptionalNativeModule } from 'expo-modules-core';

const WifiSsidModule =
  // jest/web/미지원 디바이스: null → JS wrapper(src/features/nearest-station/utils/wifiSsidNative.ts)가 graceful fallback.
  requireOptionalNativeModule('WifiSsid');

export default WifiSsidModule;
