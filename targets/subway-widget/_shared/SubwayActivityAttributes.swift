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
        // #1389 PR-4 — 정합성 게이트가 device signal과 target station의 모순을 감지했을 때
        // 위젯이 station/eta를 "현재 위치 미확정" fallback으로 렌더링하도록 알리는 플래그.
        //  - nil 또는 "confirmed": 정상 (회귀 안전 기본값)
        //  - "unconfirmed": fallback display
        // 위젯이 i18n 텍스트 없이도 안전하게 렌더링할 수 있도록 station을 "—" 로 치환하고
        // alarmType 기반 긴급 강조를 비활성화한다. JS init 경로는 `unconfirmedText`에
        // 로캘별 fallback 문구(예: "현재 위치 미확정")를 채워 보낸다.
        var displayMode: String?
        // JS에서 i18n으로 빌드된 fallback 문구. displayMode == "unconfirmed" 일 때만 사용한다.
        // 누락 시 위젯은 universal placeholder("—")로 폴백 — 한국어 강제 위험이 없다.
        var unconfirmedText: String?
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
