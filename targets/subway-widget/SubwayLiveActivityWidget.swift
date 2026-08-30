#if os(iOS)
import ActivityKit
import AppIntents
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
                    .fill(context.state.alarmType != nil
                          ? (context.state.alarmType == "destination" ? Color.red : Color.orange)
                          : (Color(hex: context.state.lineColorHex) ?? .gray))
                    .frame(width: 10, height: 10)
                    .padding(.leading, 2)
            } compactTrailing: {
                let alarmType = context.state.alarmType
                let trailingColor: Color = {
                    if alarmType == "destination" { return .red }
                    if alarmType == "transfer" { return .orange }
                    return .white
                }()
                Text(alarmType == "destination" ? "🔴" : alarmType == "transfer" ? "🟠" : context.state.stationName)
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundColor(trailingColor)
                    .lineLimit(1)
            } minimal: {
                let alarmTypeMin = context.state.alarmType
                Circle()
                    .fill(alarmTypeMin == "destination" ? Color.red
                          : alarmTypeMin == "transfer" ? Color.orange
                          : (Color(hex: context.state.lineColorHex) ?? .gray))
                    .frame(width: 10, height: 10)
            }
        }
    }
}

@available(iOS 16.1, *)
private struct LockScreenView: View {
    let state: SubwayActivityAttributes.ContentState

    // AOD (Always-On Display) 환경 감지 — isLuminanceReduced=true 시 명도 최소화
    @Environment(\.isLuminanceReduced) var isLuminanceReduced

    var lineColor: Color {
        Color(hex: state.lineColorHex) ?? .gray
    }

    var isUrgent: Bool {
        state.alarmType != nil
    }

    var urgentColor: Color {
        // AOD 시 accent(색조)만 유지하되 배경을 거의 블랙으로 낮춘다
        if isLuminanceReduced {
            return state.alarmType == "destination" ? .red.opacity(0.7) : .orange.opacity(0.7)
        }
        return state.alarmType == "destination" ? .red : .orange
    }

    var urgentText: String {
        return state.alarmBody ?? ""
    }


    /// #2439 — pre-boarding/hop-end 단계는 "탑승/하차 확인" 프롬프트를 최우선 표시.
    var isBoardingPrompt: Bool {
        state.boardingPhase == "pre-boarding" || state.boardingPhase == "hop-end"
    }

    var body: some View {
        if isBoardingPrompt {
            BoardingPromptView(state: state, phase: state.boardingPhase ?? "")
        } else if isUrgent {
            // 긴급 모드
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(.white.opacity(isLuminanceReduced ? 0.15 : 0.3))
                    .frame(width: 6)

                VStack(alignment: .leading, spacing: 4) {
                    Text(state.lineName)
                        .font(.caption2)
                        .fontWeight(.bold)
                        .foregroundColor(.white.opacity(0.9))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(.white.opacity(isLuminanceReduced ? 0.1 : 0.2))
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
                    .background(.white.opacity(isLuminanceReduced ? 0.1 : 0.2))
                    .cornerRadius(8)
            }
            .padding(16)
            // AOD 시 배경은 블랙(.opacity 0.9) + urgentColor accent strip
            .background(isLuminanceReduced ? .black.opacity(0.9) : urgentColor)
        } else {
            // 일반 모드
            HStack(spacing: 16) {
                // 노선 색상 바 — AOD 시 opacity 낮춤
                RoundedRectangle(cornerRadius: 4)
                    .fill(lineColor.opacity(isLuminanceReduced ? 0.5 : 1.0))
                    .frame(width: 6)

                VStack(alignment: .leading, spacing: 4) {
                    // 노선 배지 — AOD 시 배경 opacity 낮춤
                    Text(state.lineName)
                        .font(.caption2)
                        .fontWeight(.bold)
                        .foregroundColor(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(lineColor.opacity(isLuminanceReduced ? 0.4 : 1.0))
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
                        Text(state.resolvedDistanceText ?? "")
                            .font(.subheadline)
                            .foregroundColor(lineColor.opacity(isLuminanceReduced ? 0.6 : 1.0))
                    }

                    // 데이터 출처 자백 (#327). 없으면 표시 생략.
                    if let sourceLabel = state.sourceLabel {
                        Text(sourceLabel)
                            .font(.caption2)
                            .foregroundColor(.secondary)
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
            // AOD 시 배경: 거의 블랙 + 노선색 약한 tint / 일반: 기존 반투명 블랙
            .background(
                Color.black.opacity(isLuminanceReduced ? 0.9 : 0.85)
                    .overlay(isLuminanceReduced ? lineColor.opacity(0.08) : Color.clear)
            )
        }
    }
}

/// #2439 — pre-boarding("탑승하셨나요?") / hop-end("하차하셨나요?") 프롬프트 배너.
/// LA 자체는 16.1+ 유지 — 버튼만 iOS 17+ `@available` 가드로 분리해, 17 미만 기기는 텍스트만 본다.
@available(iOS 16.1, *)
private struct BoardingPromptView: View {
    let state: SubwayActivityAttributes.ContentState
    let phase: String

    var questionKey: String {
        phase == "pre-boarding"
            ? "widget.boardingPrompt.boarded.question"
            : "widget.boardingPrompt.disembark.question"
    }

    var body: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(state.boardingPromptOriginStation ?? state.stationName)
                    .font(.title3)
                    .fontWeight(.black)
                    .foregroundColor(.white)
                Text(NSLocalizedString(questionKey, comment: "Live Activity boarding/disembark confirmation prompt"))
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(.white.opacity(0.85))
            }

            Spacer()

            if #available(iOS 17.0, *) {
                BoardingPromptButton(state: state, phase: phase)
            }
        }
        .padding(16)
        .background(Color.black.opacity(0.85))
    }
}

/// AppIntent 버튼 자체는 iOS 17+ (`LiveActivityIntent`)에서만 렌더 — 17 미만은 위 텍스트만 노출.
@available(iOS 17.0, *)
private struct BoardingPromptButton: View {
    let state: SubwayActivityAttributes.ContentState
    let phase: String

    var body: some View {
        if phase == "pre-boarding" {
            Button(intent: BoardingConfirmIntent(
                tripToken: state.boardingPromptTripToken ?? "",
                originStation: state.boardingPromptOriginStation ?? "",
                line: state.boardingPromptLine ?? ""
            )) {
                Text(NSLocalizedString("widget.boardingPrompt.boarded.button", comment: "Confirm boarding button label"))
                    .font(.subheadline)
                    .fontWeight(.bold)
            }
            .tint(.white)
        } else {
            Button(intent: DisembarkConfirmIntent(
                tripToken: state.boardingPromptTripToken ?? "",
                originStation: state.boardingPromptOriginStation ?? "",
                line: state.boardingPromptLine ?? ""
            )) {
                Text(NSLocalizedString("widget.boardingPrompt.disembark.button", comment: "Confirm disembark button label"))
                    .font(.subheadline)
                    .fontWeight(.bold)
            }
            .tint(.white)
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
