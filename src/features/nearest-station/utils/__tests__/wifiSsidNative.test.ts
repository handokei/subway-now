/**
 * #913 (F2) — Wifi SSID 네이티브 브릿지 JS wrapper 테스트.
 *
 * 핵심 정책:
 *   - native module 부재 → null
 *   - 권한 없음 / 미연결 / 예외 → null (graceful)
 *   - 정상 SSID 문자열 → 그대로 반환
 *   - empty / non-string → null로 정규화
 */

const mockNativeModule = {
  getCurrentSsid: jest.fn(),
};

const mockedRequire = jest.fn();

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (...args: unknown[]) => mockedRequire(...args),
}));

import { getCurrentWifiSsid } from '../wifiSsidNative';

describe('wifiSsidNative (#913)', () => {
  beforeEach(() => {
    mockedRequire.mockReset();
    mockNativeModule.getCurrentSsid.mockReset();
  });

  describe('native module 없음 (jest 기본 / 미지원 디바이스)', () => {
    beforeEach(() => {
      mockedRequire.mockReturnValue(null);
    });

    it('getCurrentWifiSsid() → null (graceful)', async () => {
      await expect(getCurrentWifiSsid()).resolves.toBeNull();
    });
  });

  describe('native module 있음', () => {
    beforeEach(() => {
      mockedRequire.mockReturnValue(mockNativeModule);
    });

    it('정상 SSID 문자열 → 그대로 반환', async () => {
      mockNativeModule.getCurrentSsid.mockResolvedValue('T_wifi_zone_metro_5000');
      await expect(getCurrentWifiSsid()).resolves.toBe('T_wifi_zone_metro_5000');
    });

    it('native가 null 반환 (미연결/권한 없음) → null', async () => {
      mockNativeModule.getCurrentSsid.mockResolvedValue(null);
      await expect(getCurrentWifiSsid()).resolves.toBeNull();
    });

    it('native가 empty string 반환 → null로 정규화', async () => {
      mockNativeModule.getCurrentSsid.mockResolvedValue('');
      await expect(getCurrentWifiSsid()).resolves.toBeNull();
    });

    it('native가 non-string (undefined) 반환 → null', async () => {
      mockNativeModule.getCurrentSsid.mockResolvedValue(undefined);
      await expect(getCurrentWifiSsid()).resolves.toBeNull();
    });

    it('native 예외 → null (graceful)', async () => {
      mockNativeModule.getCurrentSsid.mockRejectedValue(new Error('fetch-failed'));
      await expect(getCurrentWifiSsid()).resolves.toBeNull();
    });
  });
});
