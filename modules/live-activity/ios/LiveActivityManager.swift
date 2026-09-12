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
    /// 사용자가 LA를 직접 swipe-to-dismiss 한 경우만 emit (#967).
    /// 앱이 `end()`를 호출해 종료된 경우는 emit 되지 않는다 — dismiss sentinel은 사용자 의도만 반영.
    var onActivityDismissed: ((_ dismissedAtMs: Double) -> Void)?

    /// `end()` 호출 직전 set 되는 플래그. observer가 `.ended`/`.dismissed`로 전이된 시점에
    /// 이 값이 true면 system end로 분류 → dismiss emit skip. false면 사용자 swipe로 분류.
    private var expectingSystemEnd: Bool = false

    /// #2528 — 직전 update에서 alert(AlertConfiguration)를 부착한 boardingPhase.
    /// 같은 phase가 반복 update(예: origin 텍스트 refine)돼도 매번 재알림하지 않도록 dedup한다.
    /// phase가 nil로 비거나 다른 phase로 전환되면 초기화 — 다음 프롬프트는 다시 alert.
    private var lastAlertedBoardingPhase: String?

    private init() {}

    static func isActivityEnabled() -> Bool {
        return ActivityAuthorizationInfo().areActivitiesEnabled
    }

    func setEventHandlers(
        onPushTokenHex: @escaping (String) -> Void,
        onActivityEnded: @escaping () -> Void,
        onActivityDismissed: @escaping (_ dismissedAtMs: Double) -> Void
    ) {
        self.onPushTokenHex = onPushTokenHex
        self.onActivityEnded = onActivityEnded
        self.onActivityDismissed = onActivityDismissed
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
                    await self?.handleObservedEnd()
                    return
                }
            }
        }
    }

    /// observer에서 `.ended`/`.dismissed`를 받은 시점에 호출.
    /// `expectingSystemEnd` 플래그가 false면 사용자 swipe로 분류 → dismiss emit.
    /// 어느 경우든 기존 `onActivityEnded`는 호출 (backend deregister 호환).
    private func handleObservedEnd() {
        let wasUserDismiss = !expectingSystemEnd
        expectingSystemEnd = false
        if wasUserDismiss {
            emitActivityDismissed()
        }
        emitActivityEnded()
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

    private func emitActivityDismissed() {
        let dismissedAtMs = Date().timeIntervalSince1970 * 1000
        onActivityDismissed?(dismissedAtMs)
        #if DEBUG
        print("[LiveActivity] dismissed by user at \(dismissedAtMs)")
        #endif
    }

    /// #2528 — 행동 필요 프롬프트(승차/하차, boardingPhase "pre-boarding"/"hop-end")에만
    /// AlertConfiguration(소리+배너)을 반환. 매역 "N정거장" 업데이트나 leg-1 자동락 "추적중"
    /// 안내(boardingAutoLocked=true — 이미 확정돼 재확인이 불필요)는 nil을 반환해 조용히 update된다.
    /// 같은 phase가 연속 update돼도(예: origin 텍스트 refine) 한 번만 알림 — `lastAlertedBoardingPhase`.
    private func resolveAlertConfiguration(
        for state: SubwayActivityAttributes.ContentState
    ) -> AlertConfiguration? {
        guard let phase = state.boardingPhase, phase == "pre-boarding" || phase == "hop-end" else {
            lastAlertedBoardingPhase = nil
            return nil
        }
        if phase == "pre-boarding" && state.boardingAutoLocked == true {
            lastAlertedBoardingPhase = nil
            return nil
        }
        guard let title = state.boardingAlertTitle, let body = state.boardingAlertBody else {
            // JS가 아직 alert 텍스트를 채우지 못한 과도기 업데이트(예: origin 미확정) — 조용히.
            return nil
        }
        guard lastAlertedBoardingPhase != phase else {
            return nil
        }
        lastAlertedBoardingPhase = phase
        return AlertConfiguration(
            title: LocalizedStringResource(stringLiteral: title),
            body: LocalizedStringResource(stringLiteral: body),
            sound: .default
        )
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
        // 새 Activity 세션 — 이전 세션의 alert dedup 상태는 무의미하니 초기화.
        lastAlertedBoardingPhase = nil

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
                let alertConfiguration = resolveAlertConfiguration(for: state)
                await activity.update(content, alertConfiguration: alertConfiguration)
                #if DEBUG
                print("[LiveActivity] updated, destination=\(state.destinationName ?? "nil"), alert=\(alertConfiguration != nil)")
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
        // #967: observer가 뒤따라 발사될 때 system end로 분류하도록 플래그 set.
        expectingSystemEnd = true
        lastAlertedBoardingPhase = nil
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
