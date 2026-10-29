#if canImport(ActivityKit)
import ActivityKit
import Foundation

// #3221 — 탑승여부 Live Activity(여정 LA와 분리된 별도 ActivityKit 타입).
// 여정 LA(`SubwayActivityAttributes`)와 타입이 달라 `Activity<T>.activities`/end-all/adopt/intent
// 순회가 타입별로 자동 격리된다(ADR-051 초안 S1). 탑승 LA는 push-to-start(iOS 17.2+) 또는
// 앱 foreground에서 시작하고, 종료는 기기가 소유한다(응답 intent / lock / cleanup).
//
// ⚠️ MIRROR: modules/live-activity/ios/BoardingActivityAttributes.swift
// LiveActivity CocoaPod 모듈은 _shared 자동 링크 범위 밖이라 별도 사본을 유지한다.
// 이 파일을 수정하면 반드시 위 경로의 사본도 함께 갱신해야 widget/app/pod 세 곳의
// ActivityKit wire format(+ backend push-to-start payload)이 일치한다.
@available(iOS 16.2, *)
struct BoardingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// "pre-boarding" | "hop-end" | "end-prompt"
        var phase: String
        var originStation: String
        var line: String
        var lineName: String
        var lineColorHex: String
        /// 열차 정보 한 줄(예: "건대입구 방면 7035 열차"). 서버 i18n 완료값.
        var trainInfo: String?
        /// 질문 본문(예: "탑승하셨나요?"). 서버 i18n 완료값.
        var title: String
        /// 보조 설명(예: "15분 동안 움직임이 없어요"). trainInfo가 없을 때 부제로 쓴다.
        var body: String?
        /// hop-end에서 갈아탈 노선(배지/부제 틴트용).
        var nextLine: String?
    }

    /// 같은 promptId의 중복 시작을 막는 식별자(재질문은 새 promptId).
    var promptId: String
    var tripToken: String
}
#endif
