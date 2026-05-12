#if canImport(ActivityKit)
import ActivityKit

// ActivityKit이 앱 타겟과 위젯 타겟에서 동일한 정의를 요구한다.
// @bacons/apple-targets의 _shared 디렉토리는 main target과 sub-target에 자동 링크되므로
// 여기에 단일 정의를 두면 양쪽에서 같은 타입을 공유한다.
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
    }
}
#endif
