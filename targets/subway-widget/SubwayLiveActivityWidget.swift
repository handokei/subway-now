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
                    Circle()
                        .fill(context.state.alarmType != nil
                              ? (context.state.alarmType == "destination" ? Color.red : Color.orange)
                              : (Color(hex: context.state.lineColorHex) ?? .gray))
                        .frame(width: 12, height: 12)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.stationName)
                            .font(.headline)
                            .fontWeight(.bold)
                            .foregroundColor(.white)
                        if let alarmType = context.state.alarmType,
                           let alarmBody = context.state.alarmBody {
                            Text(alarmBody)
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(alarmType == "destination" ? .red : .orange)
                        } else if context.state.destinationName != nil {
                            ExpandedRouteView(state: context.state)
                        } else {
                            Text(context.state.distanceText.map { "\(context.state.lineName) · \($0)" }
                                 ?? "\(context.state.lineName) · \(context.state.distanceM)m")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            } compactLeading: {
                Circle()
                    .fill(context.state.alarmType != nil
                          ? (context.state.alarmType == "destination" ? Color.red : Color.orange)
                          : (Color(hex: context.state.lineColorHex) ?? .gray))
                    .frame(width: 10, height: 10)
                    .padding(.leading, 2)
            } compactTrailing: {
                Text(context.state.stationName)
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundColor(.white)
                    .lineLimit(1)
            } minimal: {
                Circle()
                    .fill(context.state.alarmType != nil
                          ? (context.state.alarmType == "destination" ? Color.red : Color.orange)
                          : (Color(hex: context.state.lineColorHex) ?? .gray))
                    .frame(width: 10, height: 10)
            }
        }
    }
}

@available(iOS 16.1, *)
private struct LockScreenView: View {
    let state: SubwayActivityAttributes.ContentState

    var lineColor: Color {
        Color(hex: state.lineColorHex) ?? .gray
    }

    var isUrgent: Bool {
        state.alarmType != nil
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

                    // 역 이름
                    Text(state.stationName)
                        .font(.title2)
                        .fontWeight(.black)
                        .foregroundColor(.white)

                    // 목적지 / 거리
                    if state.destinationName != nil {
                        LockScreenRouteView(state: state)
                    } else {
                        Text(state.distanceText ?? "\(state.distanceM)m")
                            .font(.subheadline)
                            .foregroundColor(lineColor)
                    }
                }

                Spacer()

                if let etaText = state.etaText {
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
