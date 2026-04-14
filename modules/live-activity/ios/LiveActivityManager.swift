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
        var stopsToSecondTransfer: Int?
        var secondTransferStationName: String?
        var stopsAfterLastTransfer: Int?
        var distanceM: Int
        var etaMinutes: Int?
        var isMock: Bool?
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

        let state = try decodeState(from: data)
        let attributes = SubwayActivityAttributes()
        let content = ActivityContent(state: state, staleDate: nil)
        currentActivity = try Activity.request(
            attributes: attributes,
            content: content,
            pushType: nil
        )
        #if DEBUG
        print("[LiveActivity] started, destination=\(state.destinationName ?? "nil")")
        #endif
    }

    func update(data: [String: Any]) async throws {
        // Activity 상태 검증: ended/dismissed면 재시작
        if let activity = currentActivity {
            if activity.activityState == .active {
                let state = try decodeState(from: data)
                let content = ActivityContent(state: state, staleDate: nil)
                await activity.update(content)
                #if DEBUG
                print("[LiveActivity] updated, destination=\(state.destinationName ?? "nil")")
                #endif
                return
            } else {
                #if DEBUG
                print("[LiveActivity] activity state=\(activity.activityState), restarting")
                #endif
                currentActivity = nil
            }
        }
        try await start(data: data)
    }

    func end() async {
        if let activity = currentActivity {
            await activity.end(dismissalPolicy: .immediate)
            currentActivity = nil
        }
    }

    // JSON → Codable 디코딩: 타입 안전성 보장, 필드 추가 시 struct만 수정하면 됨
    private func decodeState(from data: [String: Any]) throws -> SubwayActivityAttributes.ContentState {
        let jsonData = try JSONSerialization.data(withJSONObject: data)
        return try JSONDecoder().decode(SubwayActivityAttributes.ContentState.self, from: jsonData)
    }
}
#endif
