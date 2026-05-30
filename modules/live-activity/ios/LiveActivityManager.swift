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
    private var pushTokenTask: Task<Void, Never>?
    private var stateTask: Task<Void, Never>?

    /// LiveActivityModule이 주입하는 이벤트 emitter. 메인 액터/스레드 안전성은 호출자가 보장한다.
    var onPushTokenHex: ((String) -> Void)?
    var onActivityEnded: (() -> Void)?

    private init() {}

    static func isActivityEnabled() -> Bool {
        return ActivityAuthorizationInfo().areActivitiesEnabled
    }

    func setEventHandlers(
        onPushTokenHex: @escaping (String) -> Void,
        onActivityEnded: @escaping () -> Void
    ) {
        self.onPushTokenHex = onPushTokenHex
        self.onActivityEnded = onActivityEnded
    }

    /// 현재 추적 중인 Activity + 이전 세션에서 남은 고아 Activity 일괄 종료.
    /// ActivityKit의 `.activities` 목록 반영 지연으로 1회 enumerate 후에도 잔여가 남는 경우가
    /// 있어 잔여가 없거나 안전 상한에 도달할 때까지 반복한다.
    private func endAllActivities() async {
        cancelObservers()
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
        guard let adopted = Activity<SubwayActivityAttributes>.activities
            .first(where: { $0.activityState == .active || $0.activityState == .stale })
        else { return }
        currentActivity = adopted
        startObservers(for: adopted)
    }

    private func cancelObservers() {
        pushTokenTask?.cancel()
        pushTokenTask = nil
        stateTask?.cancel()
        stateTask = nil
    }

    /// `pushType: .token`으로 시작된 Activity의 token / state 변화를 구독해 JS로 emit.
    /// 기존 `pushType: nil` 인스턴스를 adopt한 경우 tokenUpdates가 즉시 끝나므로 noop.
    private func startObservers(for activity: Activity<SubwayActivityAttributes>) {
        cancelObservers()
        pushTokenTask = Task { [weak self] in
            for await tokenData in activity.pushTokenUpdates {
                if Task.isCancelled { return }
                let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                await self?.emitPushToken(hex)
            }
        }
        stateTask = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                if Task.isCancelled { return }
                if state == .ended || state == .dismissed {
                    await self?.emitActivityEnded()
                    return
                }
            }
        }
    }

    private func emitPushToken(_ hex: String) {
        onPushTokenHex?(hex)
        #if DEBUG
        print("[LiveActivity] push token: \(hex)")
        #endif
    }

    private func emitActivityEnded() {
        onActivityEnded?()
        #if DEBUG
        print("[LiveActivity] ended")
        #endif
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
        let activity = try Activity.request(
            attributes: attributes,
            content: content,
            pushType: .token
        )
        currentActivity = activity
        startObservers(for: activity)
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
        // 명시적 종료 경로: backend가 token deregister 트리거를 받을 수 있도록
        // observer cancel 이전에 직접 emit. JS / backend는 idempotent 처리 전제.
        // (start() 내부 cleanup 경로는 다음 토큰이 backend를 upsert하므로 emit 불필요)
        let hadActivity = currentActivity != nil
            || !Activity<SubwayActivityAttributes>.activities.isEmpty
        if hadActivity {
            emitActivityEnded()
        }
        await endAllActivities()
    }

    // JSON → Codable 디코딩: 타입 안전성 보장, 필드 추가 시 struct만 수정하면 됨
    private func decodeState(from data: [String: Any]) throws -> SubwayActivityAttributes.ContentState {
        let jsonData = try JSONSerialization.data(withJSONObject: data)
        return try JSONDecoder().decode(SubwayActivityAttributes.ContentState.self, from: jsonData)
    }
}
#endif
