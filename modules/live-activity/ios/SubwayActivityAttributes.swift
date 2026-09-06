#if canImport(ActivityKit)
import ActivityKit

// ⚠️ MIRROR: targets/subway-widget/_shared/SubwayActivityAttributes.swift
// LiveActivity CocoaPod 모듈은 @bacons/apple-targets의 _shared 자동 링크 범위 밖이라
// pod 컴파일 단위에 동일한 정의를 사본으로 두어야 한다. 원본을 수정하면 반드시 함께 갱신하여
// app 모듈과 widget extension 간 ActivityKit wire format을 일치시킨다.
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
    }
}

// #613: backend LA push update는 텍스트 i18n 필드를 채우지 않는다 (한국어 강제 회피).
// 위젯의 i18n-안전한 폴백은 universal unit ("m") 표시에만 한정한다. 다른 텍스트(alarmBody, etaText,
// routeSubtext, alarmShortLabel)는 JS init에서 i18n으로 채워진 값을 유지하고, 누락 시 UI에서
// 자연 hide — backend가 텍스트를 채우려면 Localizable.strings(ko/en/ja/zh) 인프라가 선행되어야 한다.
@available(iOS 16.1, *)
extension SubwayActivityAttributes.ContentState {
    /// 거리 표시. distanceText(i18n) 우선, 없으면 raw distanceM에 universal "m" 단위.
    /// 단위 "m"은 모든 로캘 공통이라 한국어 강제 위험이 없다.
    var resolvedDistanceText: String? {
        if let text = distanceText { return text }
        if let m = distanceM { return "\(m)m" }
        return nil
    }
}
#endif
