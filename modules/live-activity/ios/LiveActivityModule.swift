import ExpoModulesCore
import UIKit
import WidgetKit

private let APP_GROUP = "group.com.subwaynow.app"
private let WIDGET_KEY_STATION_NAME = "stationName"
private let WIDGET_KEY_LINE_COLOR = "lineColor"
private let WIDGET_KEY_DISTANCE_M = "distanceM"

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
            if #available(iOS 16.2, *) {
                guard UIDevice.current.userInterfaceIdiom != .pad else {
                    return false
                }
                return LiveActivityManager.isActivityEnabled()
            }
            return false
        }

        AsyncFunction("saveWidgetStation") { (stationName: String, lineColor: String, distanceM: Int) in
            guard let defaults = UserDefaults(suiteName: APP_GROUP) else { return }
            defaults.set(stationName, forKey: WIDGET_KEY_STATION_NAME)
            defaults.set(lineColor, forKey: WIDGET_KEY_LINE_COLOR)
            defaults.set(String(distanceM), forKey: WIDGET_KEY_DISTANCE_M)
            if #available(iOS 14.0, *) {
                WidgetCenter.shared.reloadAllTimelines()
            }
        }

        AsyncFunction("clearWidgetStation") { () -> Void in
            guard let defaults = UserDefaults(suiteName: APP_GROUP) else { return }
            defaults.removeObject(forKey: WIDGET_KEY_STATION_NAME)
            defaults.removeObject(forKey: WIDGET_KEY_LINE_COLOR)
            defaults.removeObject(forKey: WIDGET_KEY_DISTANCE_M)
            if #available(iOS 14.0, *) {
                WidgetCenter.shared.reloadAllTimelines()
            }
        }
    }
}
