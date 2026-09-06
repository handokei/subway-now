import ExpoModulesCore
import UIKit
import WidgetKit

private let APP_GROUP = "group.com.subwaynow.app"
private let WIDGET_KEY_STATION_NAME = "stationName"
private let WIDGET_KEY_LINE_COLOR = "lineColor"
private let WIDGET_KEY_DISTANCE_M = "distanceM"
// 위젯 freshness 표시용. JS에서 epoch ms로 전달, UserDefaults에는 Double(초)로 저장.
private let WIDGET_KEY_SAVED_AT = "savedAt"
// #1781 — trip 활성 시 추가 필드. backward-compat: 키 없으면 위젯이 기존 UI 유지.
private let WIDGET_KEY_CURRENT_STATION_NAME = "currentStationName"
private let WIDGET_KEY_DESTINATION_NAME = "destinationName"
private let WIDGET_KEY_NEXT_TRANSFER_NAME = "nextTransferName"
private let WIDGET_KEY_TRIP_ACTIVE = "tripActive"

// #2439 — LA 인터랙티브 프롬프트 piece ⑤-native. App Group 계약(⑤-JS 브릿지와 공유,
// 정확히 일치해야 함). targets/subway-widget/BoardingIntents.swift의
// PENDING_BOARDING_INTENT_KEY와 동일 리터럴 — 별도 컴파일 단위(pod)라 미러링한다.
private let PENDING_BOARDING_INTENT_KEY = "pendingBoardingIntent"

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

        // #1781 — trip 활성 시 추가 맥락(현재역/환승역/도착역)을 별도 함수로 write.
        // saveWidgetStation 4-param 시그니처를 유지해 backward compat를 보존한다.
        AsyncFunction("saveWidgetTripContext") { (currentStationName: String?, destinationName: String?, nextTransferName: String?, tripActive: Bool) in
            guard let defaults = UserDefaults(suiteName: APP_GROUP) else { return }
            defaults.set(tripActive, forKey: WIDGET_KEY_TRIP_ACTIVE)
            if let name = currentStationName {
                defaults.set(name, forKey: WIDGET_KEY_CURRENT_STATION_NAME)
            } else {
                defaults.removeObject(forKey: WIDGET_KEY_CURRENT_STATION_NAME)
            }
            if let name = destinationName {
                defaults.set(name, forKey: WIDGET_KEY_DESTINATION_NAME)
            } else {
                defaults.removeObject(forKey: WIDGET_KEY_DESTINATION_NAME)
            }
            if let name = nextTransferName {
                defaults.set(name, forKey: WIDGET_KEY_NEXT_TRANSFER_NAME)
            } else {
                defaults.removeObject(forKey: WIDGET_KEY_NEXT_TRANSFER_NAME)
            }
            // trip 맥락 변경 시에도 위젯 타임라인을 갱신한다.
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
            defaults.removeObject(forKey: WIDGET_KEY_TRIP_ACTIVE)
            defaults.removeObject(forKey: WIDGET_KEY_CURRENT_STATION_NAME)
            defaults.removeObject(forKey: WIDGET_KEY_DESTINATION_NAME)
            defaults.removeObject(forKey: WIDGET_KEY_NEXT_TRANSFER_NAME)
            if #available(iOS 14.0, *) {
                WidgetCenter.shared.reloadAllTimelines()
            }
        }

        // #2439 — LA 잠금화면 버튼(BoardingConfirmIntent/DisembarkConfirmIntent, 위젯
        // 익스텐션 프로세스)이 App Group에 write한 pending intent를 JS가 읽는다. 계약은
        // BoardingIntents.swift 헤더 주석 참조. raw JSON 문자열을 그대로 반환 — 파싱은 JS 측 책임.
        Function("readPendingBoardingIntent") { () -> String? in
            guard let defaults = UserDefaults(suiteName: APP_GROUP) else { return nil }
            return defaults.string(forKey: PENDING_BOARDING_INTENT_KEY)
        }

        // id가 저장된 값과 일치할 때만 제거 — 멱등(이미 지워졌거나 그새 새 intent로 덮어써졌으면
        // no-op). 새 intent를 실수로 지우는 race를 방지한다.
        Function("clearPendingBoardingIntent") { (id: String) -> Void in
            guard let defaults = UserDefaults(suiteName: APP_GROUP) else { return }
            guard let raw = defaults.string(forKey: PENDING_BOARDING_INTENT_KEY) else { return }
            guard let jsonData = raw.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let storedId = json["id"] as? String,
                  storedId == id else { return }
            defaults.removeObject(forKey: PENDING_BOARDING_INTENT_KEY)
        }
    }
}
