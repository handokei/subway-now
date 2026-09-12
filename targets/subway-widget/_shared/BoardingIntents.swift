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

// #2528 — backend 직결(BG, #2527 계약: POST /trips/:token/boarding-confirm,
// body {action,station,line}). body의 `action`은 App Group의 ACTION_* 코드와 다른 어휘라
// 별도 상수로 둔다(계약 고정값, backend index.ts 라우터와 문자열 일치 필수).
// #2527의 계약은 3-way(boarded/disembarked/not-boarded)만 정의한다 — "아직이요"
// (DISEMBARK_NOT_YET, 하차 보류)는 "이 프롬프트를 보류하고 상태 변경 없음"이라는 의미에서
// not-boarded와 동일하게 매핑한다.
private let CONFIRM_ACTION_BOARDED = "boarded"
private let CONFIRM_ACTION_DISEMBARKED = "disembarked"
private let CONFIRM_ACTION_NOT_BOARDED = "not-boarded"

// eas.json production 프로파일의 EXPO_PUBLIC_ALARM_BACKEND_URL과 동일 값(JS SSoT).
// 위젯 익스텐션 프로세스는 Expo env 인라이닝(JS 번들 전용) 범위 밖이라 값을 미러링한다 —
// 이 파일 상단 App Group 계약과 동일한 "별도 컴파일 단위라 리터럴 미러링" 관례.
// 값이 바뀌면 eas.json의 build.production.env.EXPO_PUBLIC_ALARM_BACKEND_URL도 함께 갱신해야 한다.
private let ALARM_BACKEND_URL_BASE = "https://subway-now-alarm-worker.handokei.workers.dev"

/// #2528 — App Intent perform()이 앱을 열지 않고(BG) backend에 직접 탑승/하차 확정을 전달한다.
/// `writePendingBoardingIntent`(App Group)는 FG sync용으로 계속 유지 — 이 호출은 그와 별개로,
/// 앱이 완전히 정지된 상태에서도 leg 락 체인이 완결되도록 하는 주 경로다(#2527 FG-gap 제거).
///
/// perform() 안에서 await로 완료를 기다린다 — 위젯 익스텐션 프로세스가 짧게 생존하므로
/// fire-and-forget dataTask는 perform() 반환 후 프로세스가 정지되며 유실될 수 있다.
/// 네트워크 실패는 graceful — App Group write(FG sync)가 이미 완료됐으므로 다음 FG 진입 시
/// `useLiveActivityIntentBridge`가 동일 처리를 재시도한다.
@available(iOS 17.0, *)
private func postBoardingConfirm(
    tripToken: String,
    action: String,
    station: String,
    line: String
) async {
    guard let encodedToken = tripToken.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
          let url = URL(string: "\(ALARM_BACKEND_URL_BASE)/trips/\(encodedToken)/boarding-confirm")
    else {
        intentLog.error("boarding-confirm invalid URL, tripToken empty or unencodable")
        return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.timeoutInterval = 10

    let body: [String: Any] = ["action": action, "station": station, "line": line]
    guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
        intentLog.error("boarding-confirm body encode failed")
        return
    }
    request.httpBody = bodyData

    do {
        let (_, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            intentLog.error("boarding-confirm non-2xx status=\(http.statusCode, privacy: .public)")
        } else {
            intentLog.info("boarding-confirm POST ok action=\(action, privacy: .public)")
        }
    } catch {
        intentLog.error("boarding-confirm POST failed: \(error.localizedDescription, privacy: .public)")
    }
}

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
        await postBoardingConfirm(
            tripToken: tripToken,
            action: CONFIRM_ACTION_BOARDED,
            station: originStation,
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
        await postBoardingConfirm(
            tripToken: tripToken,
            action: CONFIRM_ACTION_DISEMBARKED,
            station: originStation,
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
        await postBoardingConfirm(
            tripToken: tripToken,
            action: CONFIRM_ACTION_NOT_BOARDED,
            station: originStation,
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
        await postBoardingConfirm(
            tripToken: tripToken,
            action: CONFIRM_ACTION_NOT_BOARDED,
            station: originStation,
            line: line
        )
        return .result()
    }
}
#endif
