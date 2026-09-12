import ExpoModulesCore
import CoreMotion

/**
 * #728 — CMMotionActivity wrapper.
 *
 * 정적 misfire 가드(`evaluateMovement`, `shouldDowngradeFusion`)의 `motionStationary` 신호 제공.
 * speed=0.69 m/s 같은 임계 우회 phantom과 destination/transfer 카테고리 보호.
 *
 * 권한: NSMotionUsageDescription (Info.plist). startActivityUpdates 첫 호출 시 OS prompt.
 * 미지원/거절: JS wrapper(motionActivity.ts)가 graceful fallback (suppress 안 함).
 *
 * Confidence 정책: low는 stationary로 인정하지 않음 — 보수적 (false positive 차단 우선).
 *   - high/medium + stationary=true → true
 *   - low confidence → false (모르는 상태)
 *   - 그 외(walking/automotive/cycling/running) → false
 */
public class MotionActivityModule: Module {
    private let manager = CMMotionActivityManager()
    private var latestStationary: Bool = false
    private var isUpdating: Bool = false

    public func definition() -> ModuleDefinition {
        Name("MotionActivity")

        Function("isAvailable") { () -> Bool in
            return CMMotionActivityManager.isActivityAvailable()
        }

        // 권한 요청 — startActivityUpdates를 임시로 호출해 OS prompt를 발동시키고,
        // authorizationStatus 변화로 결과 판정. iOS는 별도 requestAuthorization API가 없어
        // 첫 데이터 요청이 곧 권한 요청.
        AsyncFunction("requestPermission") { (promise: Promise) in
            if !CMMotionActivityManager.isActivityAvailable() {
                promise.resolve(false)
                return
            }
            let status = CMMotionActivityManager.authorizationStatus()
            switch status {
            case .authorized:
                promise.resolve(true)
            case .denied, .restricted:
                promise.resolve(false)
            case .notDetermined:
                // 짧은 query로 prompt 발동. 응답이 오면 authorizationStatus를 다시 본다.
                let now = Date()
                let from = now.addingTimeInterval(-1)
                self.manager.queryActivityStarting(from: from, to: now, to: .main) { _, _ in
                    let next = CMMotionActivityManager.authorizationStatus()
                    promise.resolve(next == .authorized)
                }
            @unknown default:
                promise.resolve(false)
            }
        }

        Function("startUpdates") {
            if self.isUpdating { return }
            guard CMMotionActivityManager.isActivityAvailable() else { return }
            self.isUpdating = true
            self.manager.startActivityUpdates(to: .main) { [weak self] activity in
                guard let self = self, let activity = activity else { return }
                self.latestStationary = self.isStationaryWithConfidence(activity)
            }
        }

        Function("stopUpdates") {
            if !self.isUpdating { return }
            self.manager.stopActivityUpdates()
            self.isUpdating = false
            self.latestStationary = false
        }

        Function("getCurrentStationary") { () -> Bool in
            return self.latestStationary
        }
    }

    /// CMMotionActivity에서 신뢰 가능한 stationary 판정.
    /// low confidence는 false (보수적) — false positive 차단 우선.
    private func isStationaryWithConfidence(_ activity: CMMotionActivity) -> Bool {
        guard activity.stationary else { return false }
        switch activity.confidence {
        case .high, .medium:
            return true
        case .low:
            return false
        @unknown default:
            return false
        }
    }
}
