#if canImport(ActivityKit)
import ActivityKit
import Foundation
import UIKit

// SubwayActivityAttributes 정의는 targets/subway-widget/_shared/SubwayActivityAttributes.swift에
// 단일 진실 소스로 존재하며, @bacons/apple-targets의 _shared 패턴으로 main 타겟과 widget 타겟에
// 자동 링크된다.

@available(iOS 16.2, *)
actor LiveActivityManager {
    static let shared = LiveActivityManager()
    private var currentActivity: Activity<SubwayActivityAttributes>?

    private init() {}

    static func isActivityEnabled() -> Bool {
        return ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// 현재 추적 중인 Activity + 이전 세션에서 남은 고아 Activity 일괄 종료.
    /// ActivityKit의 `.activities` 목록 반영 지연으로 1회 enumerate 후에도 잔여가 남는 경우가
    /// 있어 잔여가 없거나 안전 상한에 도달할 때까지 반복한다.
    private func endAllActivities() async {
        currentActivity = nil
        var attempts = 0
        while !Activity<SubwayActivityAttributes>.activities.isEmpty && attempts < 3 {
            for activity in Activity<SubwayActivityAttributes>.activities {
                await activity.end(dismissalPolicy: .immediate)
            }
            attempts += 1
        }
    }

    /// 앱 재기동 등으로 currentActivity가 nil이지만 시스템에 살아있는 Activity가 남아 있다면 채택.
    /// 채택하지 않으면 update()가 start() 경로로 빠져 새 Activity가 추가 생성된다.
    /// `.stale`도 표시 중일 수 있으므로 채택 후 update로 freshen 한다.
    private func adoptExistingActivityIfNeeded() {
        guard currentActivity == nil else { return }
        currentActivity = Activity<SubwayActivityAttributes>.activities
            .first(where: { $0.activityState == .active || $0.activityState == .stale })
    }

    func start(data: [String: Any]) async throws {
        guard UIDevice.current.userInterfaceIdiom != .pad else {
            throw NSError(
                domain: "LiveActivity",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "iPad에서는 Live Activity를 지원하지 않습니다"]
            )
        }

        await endAllActivities()

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
        guard UIDevice.current.userInterfaceIdiom != .pad else {
            throw NSError(
                domain: "LiveActivity",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "iPad에서는 Live Activity를 지원하지 않습니다"]
            )
        }

        // 앱 재기동 시 시스템에 남아 있는 Activity를 채택해 새 request로 중복 생성하지 않음
        adoptExistingActivityIfNeeded()

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
        guard UIDevice.current.userInterfaceIdiom != .pad else { return }
        await endAllActivities()
    }

    // JSON → Codable 디코딩: 타입 안전성 보장, 필드 추가 시 struct만 수정하면 됨
    private func decodeState(from data: [String: Any]) throws -> SubwayActivityAttributes.ContentState {
        let jsonData = try JSONSerialization.data(withJSONObject: data)
        return try JSONDecoder().decode(SubwayActivityAttributes.ContentState.self, from: jsonData)
    }
}
#endif
