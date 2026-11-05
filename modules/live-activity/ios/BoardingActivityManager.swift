#if canImport(ActivityKit)
import ActivityKit
import Foundation
import UIKit

// #3221 — 탑승여부 Live Activity 전용 manager. 여정 LA(`LiveActivityManager`)와 **타입이 다른**
// `Activity<BoardingActivityAttributes>`만 다룬다 — 여정의 end-all/adopt/dismiss sentinel 경로와
// 섞이지 않는다(ADR-051 초안 S1). `LiveActivityManager`는 이 파일 도입으로 변경되지 않는다.
//
// 시작 경로: 앱 foreground(`startFromForeground`, iOS 16.2+) 또는 backend push-to-start
// (iOS 17.2+, OS가 직접 시작 → `observeActivityUpdates`가 감지). 탑승 LA는 update token을 쓰지
// 않는다(U7 R-a) — `pushType: nil`. 종료는 기기 소유(응답 intent / lock / cleanup / 재질문 시 이전 end).

@available(iOS 16.2, *)
actor BoardingActivityManager {
    static let shared = BoardingActivityManager()

    /// push-to-start token(hex) 발급/갱신 시 emit. 기기 단위 token 1개.
    var onPushToStartTokenHex: ((String) -> Void)?
    /// 탑승 LA가 `.ended`/`.dismissed`로 전이된 시점. 여정 dismiss sentinel과는 **무관**하다 —
    /// 탑승 LA 종료는 사용자 swipe든 앱/intent end든 mirror/BG 갱신을 막지 않는다.
    var onActivityEnded: ((_ promptId: String, _ state: String) -> Void)?

    private var pushToStartTask: Task<Void, Never>?
    private var activityUpdatesTask: Task<Void, Never>?
    /// Activity.id → 상태 관측 Task.
    private var stateTasks: [String: Task<Void, Never>] = [:]

    private init() {}

    func setEventHandlers(
        onPushToStartTokenHex: @escaping (String) -> Void,
        onActivityEnded: @escaping (_ promptId: String, _ state: String) -> Void
    ) {
        self.onPushToStartTokenHex = onPushToStartTokenHex
        self.onActivityEnded = onActivityEnded
    }

    private static func isLive(_ activity: Activity<BoardingActivityAttributes>) -> Bool {
        return activity.activityState == .active || activity.activityState == .stale
    }

    // MARK: - 시작

    /// 앱 foreground에서 탑승 LA를 시작한다. 같은 promptId가 이미 살아있으면 no-op(중복 시작 방지).
    /// 새 LA 시작 뒤 다른 promptId의 이전 탑승 LA는 end — 최대 1개 유지.
    func startFromForeground(data: [String: Any]) async throws {
        guard UIDevice.current.userInterfaceIdiom != .pad else {
            throw NSError(
                domain: "BoardingActivity",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "iPad에서는 Live Activity를 지원하지 않습니다"]
            )
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            throw NSError(
                domain: "BoardingActivity",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Live Activities가 iOS 설정에서 비활성화됨"]
            )
        }
        guard let promptId = data["promptId"] as? String, !promptId.isEmpty,
              let tripToken = data["tripToken"] as? String
        else {
            throw NSError(
                domain: "BoardingActivity",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "promptId/tripToken 누락"]
            )
        }

        if Activity<BoardingActivityAttributes>.activities.contains(where: {
            $0.attributes.promptId == promptId && Self.isLive($0)
        }) {
            return
        }

        let state = try decodeState(from: data)
        let activity = try Activity.request(
            attributes: BoardingActivityAttributes(promptId: promptId, tripToken: tripToken),
            content: ActivityContent(state: state, staleDate: nil),
            pushType: nil
        )
        track(activity)
        await endExcept(promptId: promptId)
    }

    // MARK: - 종료

    /// 모든 탑승 LA 종료. 여정 LA(`Activity<SubwayActivityAttributes>`)는 건드리지 않는다.
    func endAll() async {
        for activity in Activity<BoardingActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    /// `promptId`와 다른 탑승 LA를 모두 종료(재질문 시 이전 질문 정리).
    func endExcept(promptId: String) async {
        for activity in Activity<BoardingActivityAttributes>.activities
        where activity.attributes.promptId != promptId {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    // MARK: - 관측

    /// iOS 17.2+ — 기기 단위 push-to-start token 구독. backend가 이 token으로 탑승 LA를 시작한다.
    @available(iOS 17.2, *)
    func observePushToStartToken() {
        guard pushToStartTask == nil else { return }
        pushToStartTask = Task { [weak self] in
            for await tokenData in Activity<BoardingActivityAttributes>.pushToStartTokenUpdates {
                if Task.isCancelled { return }
                let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                await self?.emitPushToStartToken(hex)
            }
        }
    }

    /// 현재 push-to-start token(hex). 아직 발급 전이거나 17.2 미만이면 nil.
    func currentPushToStartTokenHex() -> String? {
        if #available(iOS 17.2, *) {
            return Activity<BoardingActivityAttributes>.pushToStartToken?
                .map { String(format: "%02x", $0) }.joined()
        }
        return nil
    }

    /// push-to-start로 OS가 시작한 탑승 LA(앱이 request한 적 없는 Activity)를 감지한다.
    /// 새 Activity가 보이면 상태 관측을 붙이고 **이전 promptId의 탑승 LA를 end**한다.
    func observeActivityUpdates() {
        guard activityUpdatesTask == nil else { return }
        for activity in Activity<BoardingActivityAttributes>.activities {
            track(activity)
        }
        activityUpdatesTask = Task { [weak self] in
            for await activity in Activity<BoardingActivityAttributes>.activityUpdates {
                if Task.isCancelled { return }
                await self?.handleDiscovered(activity)
            }
        }
    }

    private func handleDiscovered(_ activity: Activity<BoardingActivityAttributes>) async {
        track(activity)
        guard Self.isLive(activity) else { return }
        await endExcept(promptId: activity.attributes.promptId)
    }

    private func track(_ activity: Activity<BoardingActivityAttributes>) {
        let id = activity.id
        guard stateTasks[id] == nil else { return }
        let promptId = activity.attributes.promptId
        stateTasks[id] = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                if state == .ended || state == .dismissed {
                    await self?.handleEnded(
                        id: id,
                        promptId: promptId,
                        state: state == .ended ? "ended" : "dismissed"
                    )
                    return
                }
            }
        }
    }

    private func handleEnded(id: String, promptId: String, state: String) {
        stateTasks[id] = nil
        onActivityEnded?(promptId, state)
        #if DEBUG
        print("[BoardingActivity] \(state) promptId=\(promptId)")
        #endif
    }

    private func emitPushToStartToken(_ hex: String) {
        onPushToStartTokenHex?(hex)
        #if DEBUG
        print("[BoardingActivity] push-to-start token: \(hex)")
        #endif
    }

    // JSON → Codable 디코딩 (여정 manager와 동일 방식). promptId/tripToken 등 extra key는 무시된다.
    private func decodeState(from data: [String: Any]) throws -> BoardingActivityAttributes.ContentState {
        let jsonData = try JSONSerialization.data(withJSONObject: data)
        return try JSONDecoder().decode(BoardingActivityAttributes.ContentState.self, from: jsonData)
    }
}
#endif
