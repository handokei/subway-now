#if canImport(ActivityKit)
import ActivityKit
import Foundation

// 앱 타겟에서의 SubwayActivityAttributes 정의
// 위젯 타겟의 동일한 구조체와 이름이 일치해야 ActivityKit이 연동됨
@available(iOS 16.2, *)
struct SubwayActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var stationName: String
        var lineName: String
        var lineColorHex: String
        var destinationName: String?
        var stopsRemaining: Int?
        var stopsToTransfer: Int?
        var transferStationName: String?
        var stopsFromTransfer: Int?
        var distanceM: Int
    }
}

@available(iOS 16.2, *)
class LiveActivityManager {
    static let shared = LiveActivityManager()
    private var currentActivity: Activity<SubwayActivityAttributes>?

    private init() {}

    func start(data: [String: Any]) async throws {
        if let existing = currentActivity {
            await existing.end(dismissalPolicy: .immediate)
            currentActivity = nil
        }

        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw NSError(
                domain: "LiveActivity",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Live Activities가 iOS 설정에서 비활성화됨"]
            )
        }

        let state = buildState(from: data)
        let attributes = SubwayActivityAttributes()
        let content = ActivityContent(state: state, staleDate: nil)
        currentActivity = try Activity.request(
            attributes: attributes,
            content: content,
            pushType: nil
        )
    }

    func update(data: [String: Any]) async throws {
        guard let activity = currentActivity else {
            try await start(data: data)
            return
        }
        let state = buildState(from: data)
        let content = ActivityContent(state: state, staleDate: nil)
        await activity.update(content)
    }

    func end() async {
        if let activity = currentActivity {
            await activity.end(dismissalPolicy: .immediate)
            currentActivity = nil
        }
    }

    private func buildState(from data: [String: Any]) -> SubwayActivityAttributes.ContentState {
        SubwayActivityAttributes.ContentState(
            stationName: data["stationName"] as? String ?? "",
            lineName: data["lineName"] as? String ?? "",
            lineColorHex: data["lineColorHex"] as? String ?? "#888888",
            destinationName: data["destinationName"] as? String,
            stopsRemaining: data["stopsRemaining"] as? Int,
            stopsToTransfer: data["stopsToTransfer"] as? Int,
            transferStationName: data["transferStationName"] as? String,
            stopsFromTransfer: data["stopsFromTransfer"] as? Int,
            distanceM: data["distanceM"] as? Int ?? 0
        )
    }
}
#endif
