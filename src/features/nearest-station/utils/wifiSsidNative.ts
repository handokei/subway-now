/**
 * #913 (Epic #912 — F2) — Wifi SSID 네이티브 브릿지 JS wrapper.
 *
 * 네이티브(iOS NEHotspotNetwork / Android WifiManager)에서 현재 wifi SSID 1건을 비동기로 조회한다.
 * `lookupStationBySsid`의 입력으로 사용되며, 매칭 실패 시 다른 신호(GPS, 기압계)로 fallback.
 *
 * Graceful 정책 (CLAUDE.md WhileInUse 1차 시나리오):
 *   - native module 부재 (jest/web/미지원) → null
 *   - 권한 거절 / 미연결 / 예외 → null
 *   - "모르는 상태"는 알람 suppress하지 않음 — false positive 차단 우선이 아니라
 *     본 신호는 enhancement용. 매칭 안 되면 fusion이 GPS로 동작.
 *
 * iOS 권한: NSLocationWhenInUseUsageDescription (앱 본체가 이미 보유). 별도 prompt 없음.
 * Android 권한: ACCESS_FINE_LOCATION (이미 부여). 별도 prompt 없음.
 *
 * 본 wrapper는 stateless — 호출자(`useWifiSsid` hook)가 lifecycle/polling 관리.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

interface WifiSsidNative {
  getCurrentSsid(): Promise<string | null>;
}

function getNativeModule(): WifiSsidNative | null {
  return requireOptionalNativeModule<WifiSsidNative>('WifiSsid') ?? null;
}

/**
 * 현재 연결된 wifi의 SSID 문자열을 비동기로 반환한다.
 * 미지원/권한 없음/미연결/예외 → null (graceful).
 */
export async function getCurrentWifiSsid(): Promise<string | null> {
  const module = getNativeModule();
  if (!module) return null;
  try {
    const ssid = await module.getCurrentSsid();
    return typeof ssid === 'string' && ssid.length > 0 ? ssid : null;
  } catch {
    return null;
  }
}
