import { requireOptionalNativeModule } from 'expo-modules-core';

const MotionActivityModule =
  // jest/web/미지원 디바이스: null → JS wrapper(src/utils/motionActivity.ts)가 graceful fallback.
  requireOptionalNativeModule('MotionActivity');

export default MotionActivityModule;
