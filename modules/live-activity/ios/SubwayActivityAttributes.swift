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
        var distanceM: Int
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
    }
}
#endif
