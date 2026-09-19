import { requireOptionalNativeModule } from 'expo-modules-core';

const CellularTechListenerModule =
  // jest/web/Android/미지원 디바이스: null → JS wrapper(src/features/nearest-station/utils/cellularTech.ts)가 graceful fallback.
  requireOptionalNativeModule('CellularTechListener');

export default CellularTechListenerModule;
