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
    }
}

// #613: backend LA push update가 raw 필드(etaMinutes/distanceM/alarmType 등)만 보내는 경우의
// 텍스트 폴백. 텍스트 필드가 채워져 있으면 그대로 쓰고, 비어 있으면 raw에서 derive한다.
// 새 필드를 추가할 때는 여기 한 곳만 갱신하면 widget UI 전체가 같은 정책을 공유한다.
@available(iOS 16.1, *)
extension SubwayActivityAttributes.ContentState {
    var resolvedAlarmBody: String? {
        if let body = alarmBody { return body }
        guard let type = alarmType else { return nil }
        let station = alarmStationName ?? stationName
        switch type {
        case "destination": return "\(station) 곧 도착"
        case "transfer": return "\(station) 환승"
        case "intermediate": return "\(station) 통과"
        default: return nil
        }
    }

    var resolvedEtaText: String? {
        if let text = etaText { return text }
        guard let m = etaMinutes else { return nil }
        return "\(m)분"
    }

    var resolvedDistanceText: String? {
        if let text = distanceText { return text }
        guard let m = distanceM else { return nil }
        return "\(m)m"
    }

    var resolvedRouteSubtext: String? {
        if let text = routeSubtext { return text }
        if let stops = stopsToTransfer, let name = transferStationName {
            return "\(stops)정거장 후 \(name) 환승"
        }
        if let stops = stopsRemaining {
            return "\(stops)정거장 남음"
        }
        return nil
    }

    var resolvedAlarmShortLabel: String? {
        if let label = alarmShortLabel { return label }
        return resolvedEtaText
    }
}
#endif
