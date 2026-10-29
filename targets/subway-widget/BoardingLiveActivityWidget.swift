#if os(iOS)
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// #3221 PR-1 — 탑승여부 Live Activity 위젯(여정 LA `SubwayLiveActivityWidget`와 별도 Widget).
// 시안: Boarding.dc.html(Night) / Light.dc.html(Light). 질문(19pt heavy) + 노선 원형 배지 +
// 열차 정보 + 2열 버튼 높이 44 ([보조 유리 알약][주 알약]).
//   pre-boarding [미탑승][탑승했어요] / hop-end [아직이요][내렸어요] / end-prompt [계속 안내][종료]
//
// 색은 Line Glass 토큰 값이다. 토큰 파일(`LineGlassTokens.swift`)은 PR-5가 만드는 중이라 이 PR은
// 파일 내부 private 상수로 둔다.
// TODO(#3221 PR-5 머지 후): 아래 `BoardingGlass`를 `LineGlassTokens`로 통합하고 이 상수들을 삭제한다.

/// Line Glass 토큰(탑승 LA 사용분). Night/Light 모두 시안 값.
@available(iOS 16.2, *)
private struct BoardingGlass {
    let isDark: Bool

    var cardFill: Color { isDark ? Color(red: 24 / 255, green: 28 / 255, blue: 26 / 255) : .white }
    var ink: Color { isDark ? Color(red: 242 / 255, green: 245 / 255, blue: 243 / 255) : Color(red: 14 / 255, green: 21 / 255, blue: 18 / 255) }
    var inkMuted: Color { isDark ? Color(red: 140 / 255, green: 154 / 255, blue: 147 / 255) : Color(red: 85 / 255, green: 96 / 255, blue: 91 / 255) }
    var hair: Color { isDark ? Color.white.opacity(0.10) : Color(red: 14 / 255, green: 21 / 255, blue: 18 / 255).opacity(0.10) }
    /// 보조 알약 채움(유리).
    var secondaryFill: Color { isDark ? Color.white.opacity(0.14) : .white }
    /// 주 알약 채움 / 글자.
    var primaryFill: Color { ink }
    var primaryText: Color { isDark ? Color(red: 7 / 255, green: 9 / 255, blue: 10 / 255) : .white }

    /// 노선색 틴트: Night = 흰색 55% 혼합(밝게), Light = 55% 어둡게. 시안의 7호선 #747F00 → #C0C58C / #404600.
    func lineTint(_ base: (r: Double, g: Double, b: Double)) -> Color {
        if isDark {
            return Color(
                red: base.r + (1 - base.r) * 0.55,
                green: base.g + (1 - base.g) * 0.55,
                blue: base.b + (1 - base.b) * 0.55
            )
        }
        return Color(red: base.r * 0.55, green: base.g * 0.55, blue: base.b * 0.55)
    }
}

/// "#RRGGBB" → 0...1 RGB. 파싱 실패 시 nil.
private func boardingRGB(hex: String) -> (r: Double, g: Double, b: Double)? {
    let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var value: UInt64 = 0
    guard cleaned.count == 6, Scanner(string: cleaned).scanHexInt64(&value) else { return nil }
    return (
        r: Double((value >> 16) & 0xFF) / 255,
        g: Double((value >> 8) & 0xFF) / 255,
        b: Double(value & 0xFF) / 255
    )
}

private let BOARDING_FALLBACK_RGB: (r: Double, g: Double, b: Double) = (r: 0.5, g: 0.5, b: 0.5)

@available(iOS 16.2, *)
struct BoardingLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BoardingActivityAttributes.self) { context in
            BoardingLockScreenView(attributes: context.attributes, state: context.state)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded: 질문 + 버튼. 두 LA가 동시에 있을 때의 DI 우선순위(B5)는 실기기 확인 항목.
                DynamicIslandExpandedRegion(.leading) {
                    BoardingLineBadge(state: context.state)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.title)
                        .font(.system(size: 17, weight: .heavy))
                        .foregroundColor(.white)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    BoardingButtonRow(
                        tripToken: context.attributes.tripToken,
                        state: context.state,
                        glass: BoardingGlass(isDark: true)
                    )
                }
            } compactLeading: {
                BoardingLineBadge(state: context.state, diameter: 18, fontSize: 11)
            } compactTrailing: {
                Text(NSLocalizedString("widget.boardingLA.compact", comment: "Boarding LA compact trailing label"))
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundColor(.white)
            } minimal: {
                BoardingLineBadge(state: context.state, diameter: 18, fontSize: 11)
            }
        }
    }
}

/// 노선 원형 배지(28pt). hop-end는 갈아탈 노선(`nextLine`)이 있으면 그 노선을 보여준다.
@available(iOS 16.2, *)
private struct BoardingLineBadge: View {
    let state: BoardingActivityAttributes.ContentState
    var diameter: CGFloat = 28
    var fontSize: CGFloat = 14

    /// "7호선" → "7". 숫자가 아닌 노선명(경의중앙 등)은 첫 글자.
    private var label: String {
        let source = (state.phase == "hop-end" ? state.nextLine : nil) ?? state.line
        let trimmed = source.replacingOccurrences(of: "호선", with: "")
        return trimmed.count <= 2 ? trimmed : String(trimmed.prefix(1))
    }

    var body: some View {
        Text(label)
            .font(.system(size: fontSize, weight: .heavy))
            .foregroundColor(.white)
            .frame(width: diameter, height: diameter)
            .background(Circle().fill(Color(hex: state.lineColorHex) ?? .gray))
    }
}

@available(iOS 16.2, *)
private struct BoardingLockScreenView: View {
    @Environment(\.colorScheme) private var colorScheme
    let attributes: BoardingActivityAttributes
    let state: BoardingActivityAttributes.ContentState

    private var glass: BoardingGlass { BoardingGlass(isDark: colorScheme == .dark) }

    /// 부제: 열차 정보가 있으면 노선 틴트, 없으면 보조 설명(회색).
    private var subtitle: (text: String, color: Color)? {
        if let trainInfo = state.trainInfo, !trainInfo.isEmpty {
            let base = boardingRGB(hex: state.lineColorHex) ?? BOARDING_FALLBACK_RGB
            return (trainInfo, glass.lineTint(base))
        }
        if let body = state.body, !body.isEmpty {
            return (body, glass.inkMuted)
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                // end-prompt는 노선과 무관한 질문이라 배지를 생략한다(시안).
                if state.phase != "end-prompt" {
                    BoardingLineBadge(state: state)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.title)
                        .font(.system(size: 19, weight: .heavy))
                        .tracking(-0.4)
                        .foregroundColor(glass.ink)
                    if let subtitle {
                        Text(subtitle.text)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(subtitle.color)
                    }
                }
                Spacer(minLength: 0)
            }
            BoardingButtonRow(tripToken: attributes.tripToken, state: state, glass: glass)
        }
        .padding(16)
        .activityBackgroundTint(glass.cardFill.opacity(0.92))
        .activitySystemActionForegroundColor(glass.ink)
    }
}

/// 2열 버튼 행(높이 44): [보조 유리 알약][주 알약]. AppIntent 버튼은 iOS 17+ — 미만은 질문만 보인다.
@available(iOS 16.2, *)
private struct BoardingButtonRow: View {
    let tripToken: String
    let state: BoardingActivityAttributes.ContentState
    let glass: BoardingGlass

    var body: some View {
        if #available(iOS 17.0, *) {
            HStack(spacing: 8) {
                secondaryButton
                primaryButton
            }
        }
    }

    @available(iOS 17.0, *)
    @ViewBuilder
    private var secondaryButton: some View {
        switch state.phase {
        case "hop-end":
            pill(
                key: "widget.boardingPrompt.disembark.notYet.button",
                primary: false,
                intent: DisembarkNotYetIntent(
                    tripToken: tripToken, originStation: state.originStation, line: state.line, trainCode: nil)
            )
        case "end-prompt":
            pill(
                key: "widget.boardingLA.continue.button",
                primary: false,
                intent: ContinueGuidanceIntent(tripToken: tripToken)
            )
        default:
            pill(
                key: "widget.boardingPrompt.boarded.notBoarded.button",
                primary: false,
                intent: NotBoardedIntent(
                    tripToken: tripToken, originStation: state.originStation, line: state.line, trainCode: nil)
            )
        }
    }

    @available(iOS 17.0, *)
    @ViewBuilder
    private var primaryButton: some View {
        switch state.phase {
        case "hop-end":
            pill(
                key: "widget.boardingLA.disembark.button",
                primary: true,
                intent: DisembarkConfirmIntent(
                    tripToken: tripToken, originStation: state.originStation, line: state.line, trainCode: nil)
            )
        case "end-prompt":
            pill(
                key: "widget.endPrompt.end.button",
                primary: true,
                intent: EndTripIntent(tripToken: tripToken)
            )
        default:
            pill(
                key: "widget.boardingPrompt.boarded.button",
                primary: true,
                intent: BoardingConfirmIntent(
                    tripToken: tripToken, originStation: state.originStation, line: state.line, trainCode: nil)
            )
        }
    }

    @available(iOS 17.0, *)
    private func pill<I: AppIntent>(key: String, primary: Bool, intent: I) -> some View {
        Button(intent: intent) {
            Text(NSLocalizedString(key, comment: "Boarding LA button label"))
                .font(.system(size: 15, weight: primary ? .bold : .semibold))
                .foregroundColor(primary ? glass.primaryText : glass.ink)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(
                    Capsule().fill(primary ? glass.primaryFill : glass.secondaryFill)
                )
                .overlay(
                    Capsule().stroke(primary ? Color.clear : glass.hair, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}
#endif
