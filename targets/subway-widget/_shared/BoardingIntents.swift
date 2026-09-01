#if os(iOS)
import ActivityKit
import AppIntents
import Foundation
import os.log

// LA 인터랙티브 프롬프트 piece ③ (#2439). 잠금화면 Live Activity 버튼에서 직접 실행되는
// AppIntent 2종. `LiveActivityIntent` 채택(iOS 17+)이 핵심 — 이 프로토콜을 채택한 intent는
// 앱을 열지 않고 위젯 익스텐션 프로세스 안에서 곧바로 `perform()`이 실행된다. 그래서
// 백그라운드/취침 중 앱이 완전히 정지된 상태에서도 버튼 탭이 cold-start race 없이 즉시 반영된다.
//
// App Group 계약(⑤-JS 브릿지와 공유, 정확히 일치해야 함):
//   suite = "group.com.subwaynow.app" (modules/live-activity/ios/LiveActivityModule.swift의
//           APP_GROUP과 동일 — 별도 pod 컴파일 단위라 리터럴을 미러링한다)
//   key   = "pendingBoardingIntent" (LiveActivityModule.swift의 PENDING_BOARDING_INTENT_KEY와 동일)
//   value(JSON) = { id, tripToken, action, originStation, line, atMs }
//     - id: "<tripToken>-<atMs>" — clear 시 대조용
//     - action: "BOARDING_BOARDED" | "DISEMBARK_DISEMBARKED"
//
// 파일 위치 = `_shared/` (fix/#2444): @bacons/apple-targets는 이 디렉토리 파일을 main app
// target과 widget extension target 양쪽에 자동 링크한다(SubwayActivityAttributes.swift와 동일
// 패턴). widget 전용 폴더에만 있었을 때 버튼 탭이 perform()까지 도달하지 않는 증상이 있었다 —
// Apple 개발자 포럼 다수 보고: LiveActivityIntent가 위젯 프로세스에서 직접 실행되긴 하지만 App
// Intents 등록이 안정적으로 동작하려면 intent 정의가 main app target에도 포함돼야 한다.

private let APP_GROUP = "group.com.subwaynow.app"
private let PENDING_BOARDING_INTENT_KEY = "pendingBoardingIntent"
private let intentLog = Logger(subsystem: "com.subwaynow.app.widget", category: "BoardingIntent")
private let ACTION_BOARDING_BOARDED = "BOARDING_BOARDED"
private let ACTION_DISEMBARK_DISEMBARKED = "DISEMBARK_DISEMBARKED"
private let ACTION_BOARDING_NOT_BOARDED = "BOARDING_NOT_BOARDED"
private let ACTION_DISEMBARK_NOT_YET = "DISEMBARK_NOT_YET"

/// boardingPhase enum 값(모듈 index.ts LiveActivityData.boardingPhase 타입과 동일 어휘 사용).
/// 'pre-boarding' → 탑승 확인 버튼 탭 → 'boarded'. 'hop-end' → 하차 확인 버튼 탭 → 'arrival'.
private let PHASE_BOARDED = "boarded"
private let PHASE_ARRIVAL = "arrival"

/// (b) App Group에 pending intent를 write — JS가 다음 foreground/폴링 시점에 읽어 lock 생성 등
/// 실제 도메인 로직을 실행한다(이 파일은 상태 write만, 도메인 처리는 ⑤-JS 담당).
@available(iOS 17.0, *)
private func writePendingBoardingIntent(
    action: String,
    tripToken: String,
    originStation: String,
    line: String
) {
    guard let defaults = UserDefaults(suiteName: APP_GROUP) else { return }
    let atMs = Date().timeIntervalSince1970 * 1000
    let payload: [String: Any] = [
        "id": "\(tripToken)-\(Int(atMs))",
        "tripToken": tripToken,
        "action": action,
        "originStation": originStation,
        "line": line,
        "atMs": atMs,
    ]
    guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
          let jsonString = String(data: jsonData, encoding: .utf8) else { return }
    defaults.set(jsonString, forKey: PENDING_BOARDING_INTENT_KEY)
}

/// (a) 현재 추적 중인 Activity(들)의 boardingPhase를 즉시 전환 — 버튼 탭 즉시 시각 피드백.
/// 아키텍처상 활성 Activity는 최대 1개(LiveActivityManager.endAllActivities)이므로 전수 update해도
/// 안전하다. `nil`이면 프롬프트 배너를 즉시 숨긴다(미탑승/아직이요 — 아직 판단 유보라 boarded/arrival
/// 어느 쪽으로도 전환하지 않고 LockScreenView.isBoardingPrompt를 false로 되돌린다).
@available(iOS 17.0, *)
private func markCurrentActivity(boardingPhase: String?) async {
    for activity in Activity<SubwayActivityAttributes>.activities {
        var state = activity.content.state
        state.boardingPhase = boardingPhase
        await activity.update(ActivityContent(state: state, staleDate: nil))
    }
}

/// pre-boarding 단계 "탑승하셨나요?" 버튼의 AppIntent.
@available(iOS 17.0, *)
struct BoardingConfirmIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "탑승 확인"
    // Siri/Shortcuts 등 외부 진입점에 노출하지 않는다 — LA 버튼 전용 intent.
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = false

    @Parameter(title: "tripToken")
    var tripToken: String

    @Parameter(title: "originStation")
    var originStation: String

    @Parameter(title: "line")
    var line: String

    init() {
        self.tripToken = ""
        self.originStation = ""
        self.line = ""
    }

    init(tripToken: String, originStation: String, line: String) {
        self.tripToken = tripToken
        self.originStation = originStation
        self.line = line
    }

    func perform() async throws -> some IntentResult {
        intentLog.info("perform BOARDING tapped tripToken=\(tripToken, privacy: .public)")
        await markCurrentActivity(boardingPhase: PHASE_BOARDED)
        writePendingBoardingIntent(
            action: ACTION_BOARDING_BOARDED,
            tripToken: tripToken,
            originStation: originStation,
            line: line
        )
        return .result()
    }
}

/// hop-end 단계 "하차하셨나요?" 버튼의 AppIntent.
@available(iOS 17.0, *)
struct DisembarkConfirmIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "하차 확인"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = false

    @Parameter(title: "tripToken")
    var tripToken: String

    @Parameter(title: "originStation")
    var originStation: String

    @Parameter(title: "line")
    var line: String

    init() {
        self.tripToken = ""
        self.originStation = ""
        self.line = ""
    }

    init(tripToken: String, originStation: String, line: String) {
        self.tripToken = tripToken
        self.originStation = originStation
        self.line = line
    }

    func perform() async throws -> some IntentResult {
        intentLog.info("perform DISEMBARK tapped tripToken=\(tripToken, privacy: .public)")
        await markCurrentActivity(boardingPhase: PHASE_ARRIVAL)
        writePendingBoardingIntent(
            action: ACTION_DISEMBARK_DISEMBARKED,
            tripToken: tripToken,
            originStation: originStation,
            line: line
        )
        return .result()
    }
}

/// pre-boarding 단계 "미탑승" 버튼의 AppIntent — 알림 `BOARDING_PROMPT_ACTION_NOT_BOARDED`와 대칭
/// (#2470). 프롬프트 배너만 즉시 닫고(boardingPhase=nil) 도메인 처리는 JS `handleResponse`에 위임.
@available(iOS 17.0, *)
struct NotBoardedIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "미탑승 확인"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = false

    @Parameter(title: "tripToken")
    var tripToken: String

    @Parameter(title: "originStation")
    var originStation: String

    @Parameter(title: "line")
    var line: String

    init() {
        self.tripToken = ""
        self.originStation = ""
        self.line = ""
    }

    init(tripToken: String, originStation: String, line: String) {
        self.tripToken = tripToken
        self.originStation = originStation
        self.line = line
    }

    func perform() async throws -> some IntentResult {
        intentLog.info("perform NOT_BOARDED tapped tripToken=\(tripToken, privacy: .public)")
        await markCurrentActivity(boardingPhase: nil)
        writePendingBoardingIntent(
            action: ACTION_BOARDING_NOT_BOARDED,
            tripToken: tripToken,
            originStation: originStation,
            line: line
        )
        return .result()
    }
}

/// hop-end 단계 "아직이요" 버튼의 AppIntent — 알림 `DISEMBARK_ACTION_NOT_YET`와 대칭 (#2470).
@available(iOS 17.0, *)
struct DisembarkNotYetIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "아직 하차 안 함"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = false

    @Parameter(title: "tripToken")
    var tripToken: String

    @Parameter(title: "originStation")
    var originStation: String

    @Parameter(title: "line")
    var line: String

    init() {
        self.tripToken = ""
        self.originStation = ""
        self.line = ""
    }

    init(tripToken: String, originStation: String, line: String) {
        self.tripToken = tripToken
        self.originStation = originStation
        self.line = line
    }

    func perform() async throws -> some IntentResult {
        intentLog.info("perform DISEMBARK_NOT_YET tapped tripToken=\(tripToken, privacy: .public)")
        await markCurrentActivity(boardingPhase: nil)
        writePendingBoardingIntent(
            action: ACTION_DISEMBARK_NOT_YET,
            tripToken: tripToken,
            originStation: originStation,
            line: line
        )
        return .result()
    }
}
#endif
