import { requireOptionalNativeModule } from 'expo-modules-core';

const AccelerometerFingerprintModule =
  // jest/web/Android/미지원 디바이스: null → JS wrapper(src/features/nearest-station/utils/accelerometerFingerprint.ts)가 graceful fallback.
  requireOptionalNativeModule('AccelerometerFingerprint');

export default AccelerometerFingerprintModule;
