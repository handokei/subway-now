import ExpoModulesCore
import UIKit
import WidgetKit

private let APP_GROUP = "group.com.subwaynow.app"
private let WIDGET_KEY_STATION_NAME = "stationName"
private let WIDGET_KEY_LINE_COLOR = "lineColor"
private let WIDGET_KEY_DISTANCE_M = "distanceM"
// 위젯 freshness 표시용. JS에서 epoch ms로 전달, UserDefaults에는 Double(초)로 저장.
private let WIDGET_KEY_SAVED_AT = "savedAt"

public class LiveActivityModule: Module {
    public func definition() -> ModuleDefinition {
        Name("LiveActivity")

        Events("onPushToken", "onActivityEnded", "onActivityDismissed")

        OnCreate {
            if #available(iOS 16.2, *) {
                Task { [weak self] in
                    await LiveActivityManager.shared.setEventHandlers(
                        onPushTokenHex: { [weak self] hex in
                            self?.sendEvent("onPushToken", ["token": hex])
                        },
                        onActivityEnded: { [weak self] in
                            self?.sendEvent("onActivityEnded", [:])
                        },
                        onActivityDismissed: { [weak self] dismissedAtMs in
                            self?.sendEvent("onActivityDismissed", [
                                "dismissedAt": dismissedAtMs,
                                "reason": "user",
                            ])
                        }
                    )
                }
            }
        }

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
            if #available(iOS 16.2, *) {
                guard UIDevice.current.userInterfaceIdiom != .pad else {
                    return false
                }
                return LiveActivityManager.isActivityEnabled()
            }
            return false
        }

        AsyncFunction("saveWidgetStation") { (stationName: String, lineColor: String, distanceM: Int, savedAtMs: Double) in
            guard let defaults = UserDefaults(suiteName: APP_GROUP) else { return }
            defaults.set(stationName, forKey: WIDGET_KEY_STATION_NAME)
            defaults.set(lineColor, forKey: WIDGET_KEY_LINE_COLOR)
            defaults.set(String(distanceM), forKey: WIDGET_KEY_DISTANCE_M)
            // epoch ms → 초 단위 Double로 저장. 위젯이 Date(timeIntervalSince1970:)로 복원.
            defaults.set(savedAtMs / 1000.0, forKey: WIDGET_KEY_SAVED_AT)
            if #available(iOS 14.0, *) {
                WidgetCenter.shared.reloadAllTimelines()
            }
        }

        AsyncFunction("clearWidgetStation") { () -> Void in
            guard let defaults = UserDefaults(suiteName: APP_GROUP) else { return }
            defaults.removeObject(forKey: WIDGET_KEY_STATION_NAME)
            defaults.removeObject(forKey: WIDGET_KEY_LINE_COLOR)
            defaults.removeObject(forKey: WIDGET_KEY_DISTANCE_M)
            defaults.removeObject(forKey: WIDGET_KEY_SAVED_AT)
            if #available(iOS 14.0, *) {
                WidgetCenter.shared.reloadAllTimelines()
            }
        }
    }
}
