#if os(iOS)
import ActivityKit
import SwiftUI
import WidgetKit

@available(iOS 16.1, *)
struct SubwayLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SubwayActivityAttributes.self) { context in
            // 잠금화면 / 배너 뷰
            LockScreenView(state: context.state)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded
                DynamicIslandExpandedRegion(.leading) {
                    // 정합성 fallback에서는 alarmType이 있어도 긴급 색상 강조를 끄고
                    // 노선 색을 grey로 폴백 — 사용자가 잘못된 정보에 액션하지 않도록.
                    Circle()
                        .fill(context.state.resolvedIndicatorColor(
                            lineColor: Color(hex: context.state.lineColorHex) ?? .gray))
                        .frame(width: 12, height: 12)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        // station 자리 — fallback 시 placeholder
                        Text(context.state.isUnconfirmed
                             ? context.state.unconfirmedStationLabel
                             : context.state.stationName)
                            .font(.headline)
                            .fontWeight(.bold)
                            .foregroundColor(.white)
                        // 보조 라인 — fallback 모드는 정보 표시 보류 (잘못된 station 기준의 거리/route)
                        if context.state.isUnconfirmed {
                            EmptyView()
                        } else if let alarmType = context.state.alarmType,
                           let alarmBody = context.state.alarmBody {
                            Text(alarmBody)
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(alarmType == "destination" ? .red : .orange)
                        } else if context.state.destinationName != nil {
                            ExpandedRouteView(state: context.state)
                        } else {
                            let distance = context.state.resolvedDistanceText
                            Text(distance.map { "\(context.state.lineName) · \($0)" }
                                 ?? context.state.lineName)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            } compactLeading: {
                Circle()
                    .fill(context.state.resolvedIndicatorColor(
                        lineColor: Color(hex: context.state.lineColorHex) ?? .gray))
                    .frame(width: 10, height: 10)
                    .padding(.leading, 2)
            } compactTrailing: {
                Text(context.state.isUnconfirmed
                     ? context.state.unconfirmedStationLabel
                     : context.state.stationName)
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundColor(.white)
                    .lineLimit(1)
            } minimal: {
                Circle()
                    .fill(context.state.resolvedIndicatorColor(
                        lineColor: Color(hex: context.state.lineColorHex) ?? .gray))
                    .frame(width: 10, height: 10)
            }
        }
    }
}

// #1389 PR-4 — Live Activity 정합성 fallback 정책.
// 위젯이 i18n 인프라 없이도 station/eta 자리를 안전하게 렌더링할 수 있도록 universal symbol을 둔다.
//  - JS init/update 경로가 `unconfirmedText`에 로캘 문구를 채워 주면 그 값을 표시
//  - backend partial update 경로(텍스트 미충전)는 universal placeholder로 폴백
private let unconfirmedDisplayPlaceholder = "—"

@available(iOS 16.1, *)
extension SubwayActivityAttributes.ContentState {
    /// `displayMode == "unconfirmed"` 인지 여부. 위젯/Dynamic Island의 모든 surface 공통 게이트.
    var isUnconfirmed: Bool {
        return displayMode == "unconfirmed"
    }

    /// fallback 모드에서 station 자리 텍스트. JS i18n 우선, 누락 시 universal placeholder.
    var unconfirmedStationLabel: String {
        return unconfirmedText ?? unconfirmedDisplayPlaceholder
    }

    /// alarmType 기반 강조 색상. 정합성 fallback 시에는 일괄 grey로 변환 — 잘못된 station을
    /// 기준으로 사용자에게 긴급 액션을 강요하지 않기 위함. 본 helper는 nested ternary를
    /// 풀어서 SubwayLiveActivityWidget UI의 모든 surface(Lock/Dynamic Island)가 공유한다.
    func resolvedIndicatorColor(lineColor: Color) -> Color {
        if isUnconfirmed {
            return .gray
        }
        guard let alarmType = alarmType else {
            return lineColor
        }
        return alarmType == "destination" ? .red : .orange
    }
}

@available(iOS 16.1, *)
private struct LockScreenView: View {
    let state: SubwayActivityAttributes.ContentState

    var lineColor: Color {
        Color(hex: state.lineColorHex) ?? .gray
    }

    // 정합성 fallback 모드에서는 alarmType이 있어도 긴급 강조를 비활성화 — 잘못된 station
    // 으로 사용자에게 "지금 하차" 같은 액션을 강요하지 않기 위함.
    var isUrgent: Bool {
        if state.isUnconfirmed { return false }
        return state.alarmType != nil
    }

    var urgentColor: Color {
        state.alarmType == "destination" ? .red : .orange
    }

    var urgentText: String {
        return state.alarmBody ?? ""
    }

    var body: some View {
        if isUrgent {
            // 긴급 모드
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(.white.opacity(0.3))
                    .frame(width: 6)

                VStack(alignment: .leading, spacing: 4) {
                    Text(state.lineName)
                        .font(.caption2)
                        .fontWeight(.bold)
                        .foregroundColor(.white.opacity(0.9))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(.white.opacity(0.2))
                        .cornerRadius(10)

                    Text(state.stationName)
                        .font(.title2)
                        .fontWeight(.black)
                        .foregroundColor(.white)

                    Text(urgentText)
                        .font(.subheadline)
                        .fontWeight(.bold)
                        .foregroundColor(.white)
                }

                Spacer()

                Text(state.alarmShortLabel ?? "")
                    .font(.title3)
                    .fontWeight(.black)
                    .foregroundColor(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.white.opacity(0.2))
                    .cornerRadius(8)
            }
            .padding(16)
            .background(urgentColor)
        } else {
            // 일반 모드
            HStack(spacing: 16) {
                // 노선 색상 바
                RoundedRectangle(cornerRadius: 4)
                    .fill(lineColor)
                    .frame(width: 6)

                VStack(alignment: .leading, spacing: 4) {
                    // 노선 배지
                    Text(state.lineName)
                        .font(.caption2)
                        .fontWeight(.bold)
                        .foregroundColor(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(lineColor)
                        .cornerRadius(10)

                    // 역 이름 (정합성 fallback 시 placeholder)
                    Text(state.isUnconfirmed ? state.unconfirmedStationLabel : state.stationName)
                        .font(.title2)
                        .fontWeight(.black)
                        .foregroundColor(.white)

                    // 목적지 / 거리 — fallback 모드에서는 distance/route 자리 모두 표시 보류
                    // (잘못된 station 기준 거리는 무의미하고, route subtext는 다음 hop 기준이라 stale).
                    if state.isUnconfirmed {
                        EmptyView()
                    } else if state.destinationName != nil {
                        LockScreenRouteView(state: state)
                    } else {
                        Text(state.resolvedDistanceText ?? "")
                            .font(.subheadline)
                            .foregroundColor(lineColor)
                    }

                    // 데이터 출처 자백 (#327). 없으면 표시 생략.
                    if let sourceLabel = state.sourceLabel {
                        Text(sourceLabel)
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }

                Spacer()

                // 정합성 fallback에서는 ETA 텍스트도 잘못된 station 기준이므로 숨긴다.
                if !state.isUnconfirmed, let etaText = state.etaText {
                    VStack(spacing: 2) {
                        Text(etaText)
                            .font(.title3)
                            .fontWeight(.bold)
                            .foregroundColor(.white)
                        Text(state.etaSubtext ?? "")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                    .padding(.trailing, 4)
                }
            }
            .padding(16)
            .background(.black.opacity(0.85))
        }
    }
}

@available(iOS 16.1, *)
private struct LockScreenRouteView: View {
    let state: SubwayActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("→ \(state.destinationName ?? "")")
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundColor(.white)

            if let subtext = state.routeSubtext {
                Text(subtext)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }
}

@available(iOS 16.1, *)
private struct ExpandedRouteView: View {
    let state: SubwayActivityAttributes.ContentState

    var body: some View {
        Text(state.routeSummary ?? "→ \(state.destinationName ?? "")")
            .font(.caption)
            .foregroundColor(.secondary)
    }
}
#endif
