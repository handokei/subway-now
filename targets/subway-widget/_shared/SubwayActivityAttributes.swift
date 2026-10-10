#if canImport(ActivityKit)
import ActivityKit
import Foundation

// ActivityKit이 앱 타겟과 위젯 타겟에서 동일한 정의를 요구한다.
// @bacons/apple-targets의 _shared 디렉토리는 main target과 widget target에 자동 링크된다.
//
// ⚠️ MIRROR: modules/live-activity/ios/SubwayActivityAttributes.swift
// LiveActivity CocoaPod 모듈은 _shared 자동 링크 범위 밖이라 별도 사본을 유지한다.
// 이 파일을 수정하면 반드시 위 경로의 사본도 함께 갱신해야 widget/app/pod 세 곳의
// ActivityKit wire format이 일치한다.
@available(iOS 16.1, *)
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
        // #613: backend LA update push는 거리 정보를 채우지 않는다.
        // optional로 두어 partial update에서 누락되어도 decode 실패가 없도록 한다.
        var distanceM: Int?
        var etaMinutes: Int?
        var isMock: Bool?
        var alarmType: String?
        var alarmStationName: String?
        // JS에서 i18n으로 빌드된 사용자 노출 텍스트
        var alarmBody: String?
        var alarmShortLabel: String?
        var routeSubtext: String?
        var routeSummary: String?
        var etaText: String?
        var etaSubtext: String?
        var distanceText: String?
        // 데이터 출처 자백 라벨 (#327). JS에서 i18n으로 빌드된 사용자 노출 텍스트.
        // 누락 시 위젯은 라벨 표시 생략 — 기존 LA 인스턴스 호환 안전.
        var sourceLabel: String?
        // #2434 — LA interactive prompt piece ①. 순수 데이터 필드만 (버튼/AppIntent는 후속 piece).
        // 전부 optional이라 기존 LA 세션(구 ContentState)이 decode 시 missing key → nil로 안전.
        var boardingPhase: String?
        var boardingPromptTripToken: String?
        var boardingPromptOriginStation: String?
        var boardingPromptLine: String?
        // #2528 — 행동 필요 프롬프트(승차/하차)에만 alert 부착. JS가 i18n으로 빌드해 전달,
        // 누락 시 LiveActivityManager가 alertConfiguration 없이 조용히 update.
        var boardingAlertTitle: String?
        var boardingAlertBody: String?
        // leg-1 자동락 상태의 pre-boarding 배너 — "탑승하셨나요?" 대신 "추적중" 안내 표시.
        var boardingAutoLocked: Bool?
    }
}

// #613 / #2747: backend LA push update는 (일부 예외를 빼면) 텍스트 i18n 필드를 채우지 않는다.
// widget이 raw 필드(etaMinutes, stopsRemaining, transferStationName, stopsToTransfer 등)에서
// `Localizable.xcstrings`(ko/en/ja/zh-Hans)로 파생해 표시한다 — JS init이 채운 텍스트가 있으면
// 그 값을 우선하고, 없을 때만(=backend push 직후) 숫자에서 derive해 텍스트 블록이 비지 않게 한다.
// backend가 직접 한국어 텍스트를 채우지 않는다는 원칙(#613)은 그대로 유지 — 텍스트 조립은
// widget 쪽 Localizable.xcstrings에서만 일어난다.
@available(iOS 16.1, *)
extension SubwayActivityAttributes.ContentState {
    /// 거리 표시. distanceText(i18n) 우선, 없으면 raw distanceM에 universal "m" 단위.
    /// 단위 "m"은 모든 로캘 공통이라 한국어 강제 위험이 없다.
    var resolvedDistanceText: String? {
        if let text = distanceText { return text }
        if let m = distanceM { return "\(m)m" }
        return nil
    }

    /// ETA 텍스트 (#2747). etaText(JS i18n) 우선, 없으면 backend가 채우는 etaMinutes에서 파생.
    /// backend LA push는 텍스트를 채우지 않고 숫자만 채우므로, 이 파생 없이는 lock 이후 첫
    /// backend push에서 ETA 블록 전체가 사라진다 — #2747 사용자 보고의 직접 원인.
    var resolvedEtaText: String? {
        if let text = etaText { return text }
        guard let minutes = etaMinutes else { return nil }
        return String(
            format: NSLocalizedString(
                "widget.la.eta.value",
                comment: "ETA text derived from backend etaMinutes when JS-built etaText is absent"
            ),
            minutes
        )
    }

    /// ETA 블록 보조 텍스트 (#2747). etaSubtext(JS i18n) 우선, 없으면 stopsRemaining에서 파생.
    var resolvedEtaSubtext: String? {
        if let text = etaSubtext { return text }
        guard let stops = stopsRemaining else { return nil }
        return String(
            format: NSLocalizedString(
                "widget.la.stopsRemaining",
                comment: "Stops remaining text derived from backend stopsRemaining when JS-built etaSubtext is absent"
            ),
            stops
        )
    }

    /// 목적지 아래 보조 라인 (#2747 요구사항 4). routeSubtext(JS i18n) 우선. 없으면 backend가
    /// 채우는 필드에서 파생하되, 1차 환승(transferStationName/stopsToTransfer)만 노출한다 —
    /// 2차 환승 체인(secondTransferStationName 등)은 lock screen 정보 과밀을 피하기 위해
    /// 의도적으로 노출하지 않는다(근거: backend/alarm-worker의 wire contract 테스트 allowlist).
    /// 환승이 없는 직행 trip은 destinationName + stopsRemaining으로 "도착까지 N정거장"을 보여준다.
    var resolvedRouteSubtext: String? {
        if let text = routeSubtext { return text }
        if let stops = stopsToTransfer, let name = transferStationName {
            return String(
                format: NSLocalizedString(
                    "widget.la.routeSubtext.transfer",
                    comment: "Transfer progress text derived from backend transferStationName/stopsToTransfer when JS-built routeSubtext is absent"
                ),
                stops, name
            )
        }
        if let stops = stopsRemaining, let destination = destinationName {
            return String(
                format: NSLocalizedString(
                    "widget.la.routeSubtext.arrival",
                    comment: "Arrival progress text derived from backend destinationName/stopsRemaining when JS-built routeSubtext is absent"
                ),
                stops, destination
            )
        }
        return nil
    }
}
#endif
