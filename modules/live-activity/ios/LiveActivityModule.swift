import ExpoModulesCore
#if canImport(ActivityKit)
import ActivityKit
#endif

public class LiveActivityModule: Module {
    public func definition() -> ModuleDefinition {
        Name("LiveActivity")

        AsyncFunction("startLiveActivity") { (data: [String: Any]) in
            if #available(iOS 16.2, *) {
                try await LiveActivityManager.shared.start(data: data)
            }
        }

        AsyncFunction("updateLiveActivity") { (data: [String: Any]) in
            if #available(iOS 16.2, *) {
                try await LiveActivityManager.shared.update(data: data)
            }
        }

        AsyncFunction("endLiveActivity") { () -> Void in
            if #available(iOS 16.2, *) {
                await LiveActivityManager.shared.end()
            }
        }

        Function("isLiveActivityEnabled") { () -> Bool in
            if #available(iOS 16.1, *) {
                return ActivityAuthorizationInfo().areActivitiesEnabled
            }
            return false
        }
    }
}
