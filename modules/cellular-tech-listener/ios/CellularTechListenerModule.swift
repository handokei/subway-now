import ExpoModulesCore
import CoreTelephony

/**
 * #1543 (ADR-016 S10) — CTRadioAccessTechnology BG-safe listener.
 *
 * 환경(지하/지상) 4분면 SSOT 합의 게이트에 1표 추가.
 *
 * 원리:
 *   - `CTTelephonyNetworkInfo.serviceCurrentRadioAccessTechnology`로 현재 radio access tech 조회
 *   - `CTServiceRadioAccessTechnologyDidChangeNotification`(iOS 12+) 옵저빙으로 변화 즉시 sync.
 *     OS-level NotificationCenter post → BG에서도 수신 (Apple docs: "delivered to any observer
 *     regardless of app state").
 *
 * 환경 추론(JS layer 책임):
 *   - 4G(LTE/LTEAdvanced) / 5G(NR/NRNSA) → 지상 신호 (안정적 macro cell coverage)
 *   - 2G/3G(GPRS/Edge/UMTS/HSDPA 등) / null → 지하 의심 (지하 캐리어 또는 무신호 상태)
 *
 * 미지원 / 권한 / 결과 빈 dict:
 *   - 사용자 SIM 미장착 / 비활성 → empty dict (`""` 또는 `null` 반환)
 *   - 본 모듈은 캐리어 정보 / IMSI 미참조 — 별도 권한 prompt 없음 (Apple App Privacy 무영향)
 *
 * Graceful 정책: 모든 실패 → null로 회귀. "모르는 상태"는 환경 판정 vote 미투표.
 */
public class CellularTechListenerModule: Module {
    private let networkInfo = CTTelephonyNetworkInfo()
    private var latestTech: String? = nil
    private var isObserving: Bool = false
    private var observer: NSObjectProtocol? = nil

    public func definition() -> ModuleDefinition {
        Name("CellularTechListener")

        Function("isAvailable") { () -> Bool in
            // CTTelephonyNetworkInfo는 iOS 표준 — SIM 부재 디바이스에서도 instance 생성은 가능.
            return true
        }

        Function("startUpdates") {
            if self.isObserving { return }
            // 초기 1회 sync — 옵저빙 시작 시점의 radio tech를 캐시.
            self.refreshLatest()
            self.observer = NotificationCenter.default.addObserver(
                forName: .CTServiceRadioAccessTechnologyDidChange,
                object: nil,
                queue: nil
            ) { [weak self] _ in
                // 변화 알림 수신 시 networkInfo에서 최신 값을 다시 pull.
                self?.refreshLatest()
            }
            self.isObserving = true
        }

        Function("stopUpdates") {
            if let obs = self.observer {
                NotificationCenter.default.removeObserver(obs)
                self.observer = nil
            }
            self.isObserving = false
            self.latestTech = nil
        }

        Function("getCurrentTech") { () -> String? in
            return self.latestTech
        }
    }

    /// `CTTelephonyNetworkInfo`에서 현재 service의 radio access technology 코드를 캐시.
    ///
    /// `serviceCurrentRadioAccessTechnology`는 service key → tech 코드 dict.
    /// 첫 non-empty 값을 채택 (dual-SIM의 경우 활성 service 우선이지만 API 자체가 안정 보장).
    /// dict가 비어 있거나 모든 value가 nil/빈 문자열이면 latestTech=nil로 둔다 (graceful).
    private func refreshLatest() {
        let dict = self.networkInfo.serviceCurrentRadioAccessTechnology
        if let dict = dict {
            for (_, tech) in dict {
                if !tech.isEmpty {
                    self.latestTech = tech
                    return
                }
            }
        }
        self.latestTech = nil
    }
}
