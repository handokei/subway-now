package com.subwaynow.wifissid

import android.content.Context
import android.net.wifi.WifiManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * #913 (Epic #912 — F2) — Android current wifi SSID bridge.
 *
 * iOS 우선 정책 + 지하철 wifi 매핑 데이터가 한국 통신사(SK/KT/LG) 기준이라
 * Android는 동일 인터페이스(`getCurrentSsid`)만 노출, 권한 추가는 보수적.
 *
 * 동작:
 *   - WifiManager.connectionInfo.ssid → 따옴표("...") 제거 후 반환
 *   - API 31+ 에서는 권한 / OS 제한으로 "<unknown ssid>" 반환 가능 → null로 정규화
 *   - 미지원/예외/null → graceful null
 *
 * 권한 정책:
 *   - 본 모듈은 별도 권한 추가 없이 ACCESS_FINE_LOCATION(이미 부여)을 재사용
 *   - NEARBY_WIFI_DEVICES(API 33+)는 BSSID/scanResults 용. SSID는 ACCESS_FINE_LOCATION + foreground로 충분
 *   - "<unknown ssid>" 케이스는 graceful null로 처리 → JS lookup이 다른 신호로 fallback
 */
class WifiSsidModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("WifiSsid")

        AsyncFunction("getCurrentSsid") { ->
            try {
                val ctx = appContext.reactContext ?: return@AsyncFunction null
                val wifiManager = ctx.applicationContext
                    .getSystemService(Context.WIFI_SERVICE) as? WifiManager
                    ?: return@AsyncFunction null
                val rawSsid = wifiManager.connectionInfo?.ssid ?: return@AsyncFunction null
                val unquoted = rawSsid.trim('"')
                // OS 권한 부족 / wifi off 케이스의 sentinel 값
                if (unquoted.isEmpty() || unquoted == "<unknown ssid>") {
                    return@AsyncFunction null
                }
                unquoted
            } catch (_: Throwable) {
                // graceful — 예외 시 null
                null
            }
        }
    }
}
