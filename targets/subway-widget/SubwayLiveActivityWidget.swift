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
                        .fill(Color(hex: context.state.lineColorHex) ?? .gray)
                        .frame(width: 12, height: 12)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.stationName)
                            .font(.headline)
                            .fontWeight(.bold)
                            .foregroundColor(.white)
                        if let dest = context.state.destinationName {
                            ExpandedRouteView(dest: dest, state: context.state)
                        } else {
                            Text("\(context.state.lineName) · \(context.state.distanceM)m")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            } compactLeading: {
                Circle()
                    .fill(Color(hex: context.state.lineColorHex) ?? .gray)
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
                    .fill(Color(hex: context.state.lineColorHex) ?? .gray)
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

    var body: some View {
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
                if let dest = state.destinationName {
                    LockScreenRouteView(dest: dest, state: state)
                } else {
                    Text("약 \(state.distanceM)m")
                        .font(.subheadline)
                        .foregroundColor(lineColor)
                }
            }

            Spacer()

            if let eta = state.etaMinutes {
                VStack(spacing: 2) {
                    Text("약 \(eta)분")
                        .font(.title3)
                        .fontWeight(.bold)
                        .foregroundColor(.white)
                    Text(state.isMock == true ? "예상" : "소요")
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

@available(iOS 16.1, *)
private struct LockScreenRouteView: View {
    let dest: String
    let state: SubwayActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("→ \(dest)")
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundColor(.white)

            if let stops = state.stopsRemaining {
                Text("\(stops)역 후 \(dest) 도착")
                    .font(.caption)
                    .foregroundColor(.secondary)
            } else if let toFirst = state.stopsToTransfer,
                      let firstName = state.transferStationName {
                Text("\(toFirst)역 후 \(firstName) 환승")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

        }
    }
}

@available(iOS 16.1, *)
private struct ExpandedRouteView: View {
    let dest: String
    let state: SubwayActivityAttributes.ContentState

    private var etaSuffix: String {
        guard let eta = state.etaMinutes else { return "" }
        return " · 약 \(eta)분"
    }

    var body: some View {
        if let stops = state.stopsRemaining {
            Text("→ \(dest) · \(stops)역 후 도착\(etaSuffix)")
                .font(.caption)
                .foregroundColor(.secondary)
        } else if let toFirst = state.stopsToTransfer,
                  let firstName = state.transferStationName {
            Text("→ \(dest) · \(toFirst)역 후 \(firstName) 환승\(etaSuffix)")
                .font(.caption)
                .foregroundColor(.secondary)
        } else {
            Text("→ \(dest)\(etaSuffix)")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}
#endif
