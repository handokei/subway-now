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
//     (#3055 A — #2962의 optional trainCode 필드는 제거: JS consumer가 읽지 않았고 stale 값
//      전파 경로만 남겼다)
//     #3055 PR-2 — Boarding·Disembark 엔트리는 추가로:
//       nativePost: "in-flight" → backend 응답 후 { status, resolvedTrainCode?, lockState?, atMs }
//                   (status 0 = 네트워크 실패/10s 마감. 엔트리 id가 일치할 때만 기록)
//       laCandidate: { trainCode, issuedAtMs } (Boarding, LA content에 둘 다 있을 때만)
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
// #3007 S4-c — LA "안내를 종료할까요?" 버튼. JS가 앱 복귀 시 로컬 trip 상태를 정리하도록
// pending marker에 쓰는 action (device `useAlarmEndTripResponder` 계열이 소비).
private let ACTION_END_TRIP = "END_TRIP"

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
/// #3007 S4-c — LA "종료" 버튼이 backend에 **직접** trip 종료를 요청한다.
///
/// `openAppWhenRun: false`이므로 앱이 완전히 정지해도 동작해야 한다 → JS를 경유하지 않고
/// `DELETE /trips/:token?reason=` 를 직접 호출한다. `reason`은 #3002가 배선한 쿼리로,
/// backend가 `trip_metrics.end_reason` / `trip_events.meta.reason`에 그대로 적재한다 —
/// 즉 "사용자가 LA에서 끝냈다"가 D1에 남는다(그 전까지 모든 종료가 `user-delete` 한 라벨이었다).
///
/// 빈 tripToken(좀비 LA) 처리는 `postBoardingConfirm`과 동일 — 무효 요청을 보내지 않고
/// 배너만 즉시 닫아 최소 피드백을 준다(#2857 패턴 재사용).
///
/// `@available`은 `markCurrentActivity`(iOS 17+ ActivityKit)를 호출하기 때문에 필요하다.
/// PR #3013에서 이 함수를 `postBoardingConfirm` **앞에** 삽입하면서 그 함수의
/// `@available(iOS 17.0, *)`와 선언 사이를 갈라놓아 빌드가 깨졌다(`xcodebuild` 65) —
/// 속성은 바로 다음 선언에만 붙으므로 **두 함수가 각자 명시**해야 한다.
@available(iOS 17.0, *)
private func postTripEnd(tripToken: String) async {
    guard !tripToken.isEmpty else {
        intentLog.error("trip-end skipped — tripToken empty (stale/zombie LA button)")
        await markCurrentActivity(boardingPhase: nil)
        return
    }
    guard let encodedToken = tripToken.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
          let url = URL(string: "\(ALARM_BACKEND_URL_BASE)/trips/\(encodedToken)?reason=user-end-trip-button")
    else {
        intentLog.error("trip-end invalid URL")
        return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "DELETE"
    request.timeoutInterval = 10

    do {
        let (_, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        intentLog.info("trip-end response status=\(status, privacy: .public)")
    } catch {
        intentLog.error("trip-end request failed: \(error.localizedDescription, privacy: .public)")
    }
}

// #3055 PR-2 — 응답 왕복. 총 소요 마감(초). `URLRequest.timeoutInterval`은 무응답(idle) 기준이라 총 소요를
// 보장하지 않는다 → `performWithDeadline`이 `URLSession.data`와 `Task.sleep`을 경쟁시킨다.
// 브릿지 대기 예산(`NATIVE_CONFIRM_WAIT_MS` 15s)보다 짧아야 한다.
private let NATIVE_POST_DEADLINE_SECONDS: UInt64 = 10
// App Group 엔트리의 `nativePost` 값: 진행 중 표식(문자열) → 완료 시 {status, resolvedTrainCode?, lockState?, atMs}.
private let NATIVE_POST_IN_FLIGHT = "in-flight"
private let SOURCE_LA_NATIVE = "la-native"

/// #3055 PR-2 — LA content가 싣은 발사 열차를 backend `laCandidate`로 만든다. **둘 다** 있을 때만 — 하나라도
/// 없으면(구 payload·열차 미지정 발사·device writer가 교체한 content) nil → body에 키 자체가 없어 현행과 동일.
private func makeLaCandidate(trainCode: String?, trainCodeIssuedAtMs: Int?) -> [String: Any]? {
    if let trainCode = trainCode, !trainCode.isEmpty, let trainCodeIssuedAtMs = trainCodeIssuedAtMs {
        return ["trainCode": trainCode, "issuedAtMs": trainCodeIssuedAtMs]
    }
    return nil
}

/// 총 마감이 있는 POST. 먼저 끝난 쪽이 이긴다 — 마감(또는 네트워크 실패)은 status 0.
@available(iOS 17.0, *)
private func performWithDeadline(_ request: URLRequest) async -> (status: Int, data: Data?) {
    await withTaskGroup(of: (Int, Data?).self) { group in
        group.addTask {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
            } catch {
                intentLog.error("boarding-confirm POST failed: \(error.localizedDescription, privacy: .public)")
                return (0, nil)
            }
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: NATIVE_POST_DEADLINE_SECONDS * 1_000_000_000)
            return (0, nil)
        }
        let first = await group.next() ?? (0, nil)
        group.cancelAll()
        return (first.0, first.1)
    }
}

/// #3055 PR-2 — 응답을 App Group 엔트리에 되돌려 쓴다. **저장된 엔트리 id가 자기 id일 때만** —
/// JS가 이미 clear했거나 새 intent로 덮어쓴 엔트리는 부활시키지 않는다(R7).
@available(iOS 17.0, *)
private func recordNativePost(entryId: String, status: Int, resolvedTrainCode: String?, lockState: String?) {
    guard let defaults = UserDefaults(suiteName: APP_GROUP),
          let raw = defaults.string(forKey: PENDING_BOARDING_INTENT_KEY),
          let rawData = raw.data(using: .utf8),
          var json = try? JSONSerialization.jsonObject(with: rawData) as? [String: Any],
          let storedId = json["id"] as? String,
          storedId == entryId else { return }
    var nativePost: [String: Any] = [
        "status": status,
        "atMs": Date().timeIntervalSince1970 * 1000,
    ]
    if let resolvedTrainCode = resolvedTrainCode { nativePost["resolvedTrainCode"] = resolvedTrainCode }
    if let lockState = lockState { nativePost["lockState"] = lockState }
    json["nativePost"] = nativePost
    guard let jsonData = try? JSONSerialization.data(withJSONObject: json),
          let jsonString = String(data: jsonData, encoding: .utf8) else { return }
    defaults.set(jsonString, forKey: PENDING_BOARDING_INTENT_KEY)
}

@available(iOS 17.0, *)
private func postBoardingConfirm(
    tripToken: String,
    action: String,
    station: String,
    // #3055 A — body에 `trainCode` 키를 싣지 않는다(늦은 탭 stale 전파 방지, #3044 ⓑ). 열차 후보는
    // #3055 PR-2부터 별도 키 `laCandidate`(발사 시각 동반)로만 전달하고, 권위 판정은 backend가 한다.
    line: String,
    // 응답을 기록할 App Group 엔트리 id(`writePendingBoardingIntent` 반환). nil이면 기록하지 않는다.
    entryId: String? = nil,
    laCandidate: [String: Any]? = nil
) async {
    // 실패 종료 시에도 in-flight가 영구히 남지 않도록 status 0을 기록한다.
    func recordFailure() {
        if let entryId = entryId {
            recordNativePost(entryId: entryId, status: 0, resolvedTrainCode: nil, lockState: nil)
        }
    }
    // #2857 — tripToken이 빈 문자열이면(좀비 LA: state.boardingPromptTripToken ?? ""에서
    // trip이 이미 삭제돼 nil 대신 fallback "" 전달) addingPercentEncoding이 nil을 반환하지
    // 않고 그대로 ""를 통과시켜 아래 guard를 무사통과한다 — 그 결과 `/trips//boarding-confirm`
    // 무효 POST가 os.log만 남기고 조용히 실패해 사용자에게 아무 피드백도 없었다. 좀비 LA
    // 자체는 디바이스 측 runTripBoundCleanups wiring(useApnsTripRegistration.ts) fix로
    // 막히지만, 이미 떠 있는 좀비 버튼에 대한 최소 가시 피드백으로 배너를 즉시 닫는다
    // (기존 NotBoardedIntent :264 dismiss 패턴 재사용).
    guard !tripToken.isEmpty else {
        intentLog.error("boarding-confirm skipped — tripToken empty (stale/zombie LA button)")
        recordFailure()
        await markCurrentActivity(boardingPhase: nil)
        return
    }
    guard let encodedToken = tripToken.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
          let url = URL(string: "\(ALARM_BACKEND_URL_BASE)/trips/\(encodedToken)/boarding-confirm")
    else {
        intentLog.error("boarding-confirm invalid URL, tripToken empty or unencodable")
        recordFailure()
        return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.timeoutInterval = 10

    var body: [String: Any] = ["action": action, "station": station, "line": line, "source": SOURCE_LA_NATIVE]
    if let laCandidate = laCandidate { body["laCandidate"] = laCandidate }
    guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
        intentLog.error("boarding-confirm body encode failed")
        recordFailure()
        return
    }
    request.httpBody = bodyData

    let result = await performWithDeadline(request)
    let parsed = (result.data.flatMap { try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any]
    let resolvedTrainCode = parsed?["resolvedTrainCode"] as? String
    let lockState = parsed?["lockState"] as? String
    if (200...299).contains(result.status) {
        intentLog.info("boarding-confirm POST ok action=\(action, privacy: .public)")
    } else {
        intentLog.error("boarding-confirm non-2xx or deadline status=\(result.status, privacy: .public)")
    }
    if let entryId = entryId {
        recordNativePost(
            entryId: entryId, status: result.status, resolvedTrainCode: resolvedTrainCode, lockState: lockState)
    }
}

/// boardingPhase enum 값(모듈 index.ts LiveActivityData.boardingPhase 타입과 동일 어휘 사용).
/// 'pre-boarding' → 탑승 확인 버튼 탭 → 'boarded'. 'hop-end' → 하차 확인 버튼 탭 → 'arrival'.
private let PHASE_BOARDED = "boarded"
private let PHASE_ARRIVAL = "arrival"

/// (b) App Group에 pending intent를 write — JS가 다음 foreground/폴링 시점에 읽어 lock 생성 등
/// 실제 도메인 로직을 실행한다(이 파일은 상태 write만, 도메인 처리는 ⑤-JS 담당).
///
/// #3055 PR-2 — `trackNativePost`가 true(Boarding·Disembark)면 `nativePost: "in-flight"`를 함께 써서 브릿지가
/// native POST 완료까지 보류하게 하고, `laCandidate`(Boarding, 있을 때만)를 엔트리에 싣는다(브릿지 fallback POST용).
/// 반환값 = 엔트리 id — `postBoardingConfirm`이 응답을 이 id의 엔트리에만 기록한다.
@available(iOS 17.0, *)
@discardableResult
private func writePendingBoardingIntent(
    action: String,
    tripToken: String,
    originStation: String,
    line: String,
    trackNativePost: Bool = false,
    laCandidate: [String: Any]? = nil
) -> String? {
    guard let defaults = UserDefaults(suiteName: APP_GROUP) else { return nil }
    let atMs = Date().timeIntervalSince1970 * 1000
    let id = "\(tripToken)-\(Int(atMs))"
    // #3055 A — trainCode 필드 제거: JS 소비부(`PendingBoardingIntent`)는 이 필드를 읽지 않았다
    // (소비자 0건 forward-compat이었고, stale 값이 FG 브릿지로 흘러들 여지만 남겼다).
    var payload: [String: Any] = [
        "id": id,
        "tripToken": tripToken,
        "action": action,
        "originStation": originStation,
        "line": line,
        "atMs": atMs,
    ]
    if trackNativePost { payload["nativePost"] = NATIVE_POST_IN_FLIGHT }
    if let laCandidate = laCandidate { payload["laCandidate"] = laCandidate }
    guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
          let jsonString = String(data: jsonData, encoding: .utf8) else { return nil }
    defaults.set(jsonString, forKey: PENDING_BOARDING_INTENT_KEY)
    return id
}

/// (a) 버튼 탭 즉시 시각 피드백. #3221 — 응답한 질문은 **탑승 LA(`Activity<BoardingActivityAttributes>`)를
/// end(.immediate)** 해서 사라지게 한다(서버 POST/pending marker는 각 intent가 그대로 수행).
/// 탑승 LA는 질문당 1개 최대 — 타입이 여정과 달라 여정 LA는 영향받지 않는다.
///
/// 구 backend(split 미지원)가 만든 여정 LA의 질문 행(`boardingPhase`)은 같은 함수에서 이전처럼
/// 닫는다 — split 도입 전 trip의 낙관 갱신 회귀를 막는 호환 경로다(여정 LA가 질문을 더 이상
/// 싣지 않는 시점에 제거). `nil`이면 프롬프트 배너를 즉시 숨긴다(boarded/arrival 어느 쪽으로도
/// 전환하지 않고 LockScreenView.isBoardingPrompt를 false로 되돌린다).
@available(iOS 17.0, *)
private func markCurrentActivity(boardingPhase: String?) async {
    for activity in Activity<BoardingActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
    }
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

    // #3055 PR-2 — 이 질문을 발사한 열차(LA content의 `trainCode`/`trainCodeIssuedAtMs`)를 캡처해
    // backend `laCandidate`로 전달한다(body `trainCode` 키로는 전송하지 않음, #3044 ⓑ 유지). 둘 다 있을 때만.
    @Parameter(title: "trainCode")
    var trainCode: String?

    @Parameter(title: "trainCodeIssuedAtMs")
    var trainCodeIssuedAtMs: Int?

    init() {
        self.tripToken = ""
        self.originStation = ""
        self.line = ""
        self.trainCode = nil
        self.trainCodeIssuedAtMs = nil
    }

    init(tripToken: String, originStation: String, line: String, trainCode: String?, trainCodeIssuedAtMs: Int?) {
        self.tripToken = tripToken
        self.originStation = originStation
        self.line = line
        self.trainCode = trainCode
        self.trainCodeIssuedAtMs = trainCodeIssuedAtMs
    }

    func perform() async throws -> some IntentResult {
        intentLog.info("perform BOARDING tapped tripToken=\(tripToken, privacy: .public)")
        await markCurrentActivity(boardingPhase: PHASE_BOARDED)
        let laCandidate = makeLaCandidate(trainCode: trainCode, trainCodeIssuedAtMs: trainCodeIssuedAtMs)
        let entryId = writePendingBoardingIntent(
            action: ACTION_BOARDING_BOARDED,
            tripToken: tripToken,
            originStation: originStation,
            line: line,
            trackNativePost: true,
            laCandidate: laCandidate
        )
        await postBoardingConfirm(
            tripToken: tripToken,
            action: CONFIRM_ACTION_BOARDED,
            station: originStation,
            line: line,
            entryId: entryId,
            laCandidate: laCandidate
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

    // #3055 A — 캡처만 하고 전송하지 않음(늦은 탭의 stale 값 전파 방지, #3044 ⓑ). 렌더부 init 호환용 잔존.
    @Parameter(title: "trainCode")
    var trainCode: String?

    init() {
        self.tripToken = ""
        self.originStation = ""
        self.line = ""
        self.trainCode = nil
    }

    init(tripToken: String, originStation: String, line: String, trainCode: String?) {
        self.tripToken = tripToken
        self.originStation = originStation
        self.line = line
        self.trainCode = trainCode
    }

    func perform() async throws -> some IntentResult {
        intentLog.info("perform DISEMBARK tapped tripToken=\(tripToken, privacy: .public)")
        await markCurrentActivity(boardingPhase: PHASE_ARRIVAL)
        let entryId = writePendingBoardingIntent(
            action: ACTION_DISEMBARK_DISEMBARKED,
            tripToken: tripToken,
            originStation: originStation,
            line: line,
            trackNativePost: true
        )
        await postBoardingConfirm(
            tripToken: tripToken,
            action: CONFIRM_ACTION_DISEMBARKED,
            station: originStation,
            line: line,
            entryId: entryId
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

    // #3055 A — 캡처만 하고 전송하지 않음(늦은 탭의 stale 값 전파 방지, #3044 ⓑ). 렌더부 init 호환용 잔존.
    @Parameter(title: "trainCode")
    var trainCode: String?

    init() {
        self.tripToken = ""
        self.originStation = ""
        self.line = ""
        self.trainCode = nil
    }

    init(tripToken: String, originStation: String, line: String, trainCode: String?) {
        self.tripToken = tripToken
        self.originStation = originStation
        self.line = line
        self.trainCode = trainCode
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

    // #3055 A — 캡처만 하고 전송하지 않음(늦은 탭의 stale 값 전파 방지, #3044 ⓑ). 렌더부 init 호환용 잔존.
    @Parameter(title: "trainCode")
    var trainCode: String?

    init() {
        self.tripToken = ""
        self.originStation = ""
        self.line = ""
        self.trainCode = nil
    }

    init(tripToken: String, originStation: String, line: String, trainCode: String?) {
        self.tripToken = tripToken
        self.originStation = originStation
        self.line = line
        self.trainCode = trainCode
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

/// #3007 S4-c — LA "안내를 종료할까요?" 배너의 [종료] 버튼.
///
/// **자동 종료를 사용자 결정으로 바꾸는 축**이다. #2293은 정지 15분에 `runNavigationPauseBackstop`이
/// 묻지 않고 종료했는데, 2026-10-15 사용자 결정으로 *"그 멘트는 내가 결정해야 하는 거고,
/// 결정할 수 있도록 LA 알림 있어야 함"*이 됐다. 이 버튼이 그 결정을 받는다.
///
/// 기존 4개 Intent와 같은 패턴 — `openAppWhenRun: false` + backend 직접 호출이라 앱이 꺼져
/// 있어도 동작한다. pending marker도 함께 써서 앱이 다음에 열릴 때 JS가 로컬 trip 상태를
/// 정리할 수 있게 한다(backend만 지우면 device의 destination이 남아 재등록될 수 있다).
@available(iOS 17.0, *)
struct EndTripIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "안내 종료"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = false

    @Parameter(title: "tripToken")
    var tripToken: String

    init() {
        self.tripToken = ""
    }

    init(tripToken: String) {
        self.tripToken = tripToken
    }

    func perform() async throws -> some IntentResult {
        intentLog.info("perform END_TRIP tapped tripToken=\(tripToken, privacy: .public)")
        // 배너를 즉시 닫는다 — 사용자가 누른 즉시 반응이 보여야 한다.
        await markCurrentActivity(boardingPhase: nil)
        writePendingBoardingIntent(
            action: ACTION_END_TRIP,
            tripToken: tripToken,
            originStation: "",
            line: ""
        )
        await postTripEnd(tripToken: tripToken)
        return .result()
    }
}

/// #3221 — 15분 정지 종료 제안(`end-prompt`)의 [계속 안내] 버튼.
///
/// 서버 호출이 **없다**(네트워크 0): trip을 그대로 유지하고 탑승 LA만 닫는다. "계속"은 이전까지
/// 무응답이었지만(#3007 S4-c) 이제 명시 버튼이다. 여정 LA·pending marker·backend 모두 건드리지 않는다.
@available(iOS 17.0, *)
struct ContinueGuidanceIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "계속 안내"
    static var isDiscoverable: Bool = false
    static var openAppWhenRun: Bool = false

    @Parameter(title: "tripToken")
    var tripToken: String

    init() {
        self.tripToken = ""
    }

    init(tripToken: String) {
        self.tripToken = tripToken
    }

    func perform() async throws -> some IntentResult {
        intentLog.info("perform CONTINUE_GUIDANCE tapped tripToken=\(tripToken, privacy: .public)")
        for activity in Activity<BoardingActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        return .result()
    }
}
