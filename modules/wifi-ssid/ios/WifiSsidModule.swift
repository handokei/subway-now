import ExpoModulesCore
import NetworkExtension
import CoreLocation

/**
 * #913 (Epic #912 — F2) — Current wifi SSID native bridge.
 *
 * 지하에서 GPS 실패 시 wifi SSID 패턴 매칭(`lookupStationBySsid`)으로 현재 역을 100% 확정.
 * 본 모듈은 OS-level 현재 SSID 조회만 담당, 매핑/룩업은 JS layer.
 *
 * iOS API 선택: `NEHotspotNetwork.fetchCurrent` (iOS 14+).
 *   - CaptiveNetwork(`CNCopyCurrentNetworkInfo`)는 iOS 13에서 deprecated, 14+에서 NEHotspotNetwork 권장.
 *   - 호출 조건: 앱이 foreground + (a) Location WhileInUse 권한 부여 OR (b) com.apple.developer.networking.HotspotConfiguration entitlement.
 *   - 본 앱은 WhileInUse 권한 1차 시나리오(CLAUDE.md / 메모리)라 (a) 경로로 동작.
 *   - 권한 누락 / 미연결 / 백그라운드 → fetchCurrent 콜백이 nil 반환 → JS에 null 전달 (graceful).
 *
 * 권한: 앱 본체가 이미 NSLocationWhenInUseUsageDescription을 가지고 있으므로 별도 추가 없음.
 *   NEHotspotNetwork.fetchCurrent는 이 권한을 재사용한다 (Apple docs).
 *
 * Graceful 정책:
 *   - SSID 조회 실패 (권한 없음, wifi 미연결, OS 미지원) → null 반환
 *   - 예외 / 콜백 timeout → null 반환
 *   - "모르는 상태"는 JS lookup에서 자동으로 매칭 실패 → 다른 신호(GPS, 기압계)로 fallback
 */
public class WifiSsidModule: Module {
    public func definition() -> ModuleDefinition {
        Name("WifiSsid")

        AsyncFunction("getCurrentSsid") { (promise: Promise) in
            if #available(iOS 14.0, *) {
                NEHotspotNetwork.fetchCurrent { network in
                    // network가 nil이면 미연결 / 권한 없음 — graceful null.
                    promise.resolve(network?.ssid)
                }
            } else {
                // 본 앱 deployment target은 iOS 15.1이라 이 경로는 사실상 도달 불가.
                // 컴파일러 만족용 fallback — null로 처리해 JS lookup이 graceful 동작.
                promise.resolve(nil)
            }
        }
    }
}
