#if canImport(ActivityKit)
import ActivityKit

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
