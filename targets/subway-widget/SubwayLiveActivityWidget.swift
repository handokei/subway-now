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
    /// #3007 S4-c — `end-prompt`(정지 15분 "안내를 종료할까요?")도 같은 보조 행을 쓴다.
    var isBoardingPrompt: Bool {
        state.boardingPhase == "pre-boarding"
            || state.boardingPhase == "hop-end"
            || state.boardingPhase == "end-prompt"
    }

    /// #3101 — backend 발사 갱신(phase=pre-boarding + alert 필드)만 참. 무음 heartbeat는
    /// alert 필드를 싣지 않으므로 거짓 → 기존 공존 레이아웃. 응답 시 phase가 바뀌어(boarded/nil)
    /// 자동으로 거짓. `isBoardingPrompt`(end-prompt 포함)는 무변경.
    var isBoardingQuestionAlert: Bool {
        state.boardingPhase == "pre-boarding" && state.boardingAlertTitle != nil
    }

    /// #2997 S2 — 상태 뷰(주)와 탑승/하차 버튼 행(보조)을 **합성**한다.
    ///
    /// 종전에는 `isBoardingPrompt`가 **배타 분기**여서 `boardingPhase`가 오면 긴급/일반 뷰에
    /// 도달하지 못하고 카드 전체가 질문 화면으로 교체됐다 — 역명은 남지만 **남은 정거장·목적지
    /// route(`LockScreenRouteView`)·ETA가 사라졌다**. 2026-10-15 사용자 결정: *"상태가 주,
    /// 버튼은 보조"* — 상태 표시는 **항상** 유지하고 버튼은 아래에 덧붙인다.
    ///
    /// #2997 S1이 `boardingPhase`를 heartbeat마다 싣기 시작하면 lock 전 구간 내내 이 분기가
    /// 참이 되므로, 배타 분기를 그대로 두면 **그 구간 전체에서 상태판이 사라진다.**
    ///
    /// 판정은 추가하지 않는다(A+C 원칙) — `isBoardingPrompt`는 `boardingPhase` 유무만 보고
    /// 그 값은 backend가 결정한다. 이 파일은 **받은 대로 그리기만** 한다.
    ///
    /// #3101 — 단, **발사 순간**(`isBoardingQuestionAlert`)에는 질문 행만 **단독**으로 그린다.
    /// 상태 뷰 + 질문 행을 한 카드에 쌓으면 잠금화면 높이 제한으로 위/아래가 반반 잘려 질문이
    /// 보이지 않는다(2026-10-19/21 사용자 verbatim). 무음 heartbeat(alert 없음)는 위 공존 유지.
    /// Dynamic Island는 질문 행을 그리지 않아(상태만 표시) 클리핑 대상이 아니므로 변경 없음.
    var body: some View {
        VStack(spacing: 0) {
            if isBoardingQuestionAlert {
                BoardingPromptRow(state: state, phase: state.boardingPhase ?? "")
            } else {
                stateView
                if isBoardingPrompt {
                    BoardingPromptRow(state: state, phase: state.boardingPhase ?? "")
                }
            }
        }
    }

    /// 상태 표시(주) — 기존 긴급/일반 분기를 그대로 유지한다(각자 자체 padding/background 보유).
    @ViewBuilder
    private var stateView: some View {
        if isUrgent {
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

                if let etaText = state.resolvedEtaText {
                    VStack(spacing: 2) {
                        Text(etaText)
                            .font(.title3)
                            .fontWeight(.bold)
                            .foregroundColor(.white)
                        Text(state.resolvedEtaSubtext ?? "")
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

/// #2997 S2 — pre-boarding("탑승하셨나요?") / hop-end("하차하셨나요?") **버튼 행**.
///
/// #2439가 만든 `BoardingPromptView`(카드 전체를 차지하는 배너)를 **한 줄로 축소**했다 —
/// 역명은 상태 뷰(`stateView`)가 이미 그리므로 중복을 제거하고 **질문 + 버튼만** 남긴다.
/// 상태(남은 정거장·route·ETA)를 잃지 않으면서 버튼을 상시 노출하기 위한 변경(사용자 결정:
/// "상태가 주, 버튼은 보조").
///
/// LA 자체는 16.1+ 유지 — 버튼만 iOS 17+ `@available` 가드로 분리해, 17 미만 기기는 텍스트만 본다.
@available(iOS 16.1, *)
private struct BoardingPromptRow: View {
    let state: SubwayActivityAttributes.ContentState
    let phase: String

    /// #2528 — leg-1 자동락 상태(device evidence로 이미 확정된 lock)면 "탑승하셨나요?" 질문 대신
    /// "추적중" 안내를 보여준다 — 이미 확정된 열차를 재확인할 필요가 없기 때문(신뢰도 분기 표시).
    var isAutoLockedTracking: Bool {
        phase == "pre-boarding" && state.boardingAutoLocked == true
    }

    var questionKey: String {
        if isAutoLockedTracking {
            return "widget.boardingPrompt.autoLocked.tracking"
        }
        // #3007 S4-c — 정지 15분 종료 제안.
        if phase == "end-prompt" {
            return "widget.endPrompt.question"
        }
        return phase == "pre-boarding"
            ? "widget.boardingPrompt.boarded.question"
            : "widget.boardingPrompt.disembark.question"
    }

    var body: some View {
        VStack(spacing: 0) {
            // 상태 뷰와의 경계 — 버튼 행이 "보조"임을 시각적으로 구분한다.
            Rectangle()
                .fill(.white.opacity(0.12))
                .frame(height: 1)

            HStack(spacing: 12) {
                // #2997 S2 — 역명은 상태 뷰(`stateView`)가 이미 그린다. 여기서는 질문만.
                Text(NSLocalizedString(questionKey, comment: "Live Activity boarding/disembark confirmation prompt"))
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(.white.opacity(0.85))

                Spacer()

                if #available(iOS 17.0, *) {
                    BoardingPromptButton(state: state, phase: phase, autoLockedTracking: isAutoLockedTracking)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        // 상태 뷰의 배경과 이어지도록 동일 계열을 쓴다(상태 뷰가 분기별 배경을 각자 보유).
        .background(Color.black.opacity(0.85))
    }
}

/// AppIntent 버튼 자체는 iOS 17+ (`LiveActivityIntent`)에서만 렌더 — 17 미만은 위 텍스트만 노출.
@available(iOS 17.0, *)
private struct BoardingPromptButton: View {
    let state: SubwayActivityAttributes.ContentState
    let phase: String
    /// #2528 — leg-1 자동락 "추적중" 상태면 재확인 질문 버튼([탑승])은 생략하고 탈출구
    /// ([아니에요]=NotBoardedIntent)만 노출한다.
    var autoLockedTracking: Bool = false

    var body: some View {
        if phase == "end-prompt" {
            // #3007 S4-c — 종료는 사용자 결정이므로 버튼 하나만 둔다. "계속"은 **버튼이 아니라
            // 무응답**이다(아무것도 누르지 않으면 트립이 그대로 유지된다) — 선택을 강요하지 않는다.
            Button(intent: EndTripIntent(tripToken: state.boardingPromptTripToken ?? "")) {
                Text(NSLocalizedString("widget.endPrompt.end.button", comment: "End guidance button label"))
                    .font(.subheadline)
                    .fontWeight(.bold)
            }
            .tint(.white)
        } else if autoLockedTracking {
            Button(intent: NotBoardedIntent(
                tripToken: state.boardingPromptTripToken ?? "",
                originStation: state.boardingPromptOriginStation ?? "",
                line: state.boardingPromptLine ?? "",
                trainCode: state.trainCode
            )) {
                Text(NSLocalizedString("widget.boardingPrompt.boarded.notBoarded.button", comment: "Not boarded button label"))
                    .font(.subheadline)
            }
            .tint(.secondary)
        } else if phase == "pre-boarding" {
            VStack(spacing: 6) {
                // #2962 — state.trainCode(LA가 지금 들고 있는 값, 이 특정 프롬프트 발사의
                // trainCode)를 그대로 캡처해 탭 시점에 backend로 forward한다.
                Button(intent: BoardingConfirmIntent(
                    tripToken: state.boardingPromptTripToken ?? "",
                    originStation: state.boardingPromptOriginStation ?? "",
                    line: state.boardingPromptLine ?? "",
                    trainCode: state.trainCode
                )) {
                    Text(NSLocalizedString("widget.boardingPrompt.boarded.button", comment: "Confirm boarding button label"))
                        .font(.subheadline)
                        .fontWeight(.bold)
                }
                .tint(.white)

                Button(intent: NotBoardedIntent(
                    tripToken: state.boardingPromptTripToken ?? "",
                    originStation: state.boardingPromptOriginStation ?? "",
                    line: state.boardingPromptLine ?? "",
                    trainCode: state.trainCode
                )) {
                    Text(NSLocalizedString("widget.boardingPrompt.boarded.notBoarded.button", comment: "Not boarded button label"))
                        .font(.subheadline)
                }
                .tint(.secondary)
            }
        } else {
            VStack(spacing: 6) {
                Button(intent: DisembarkConfirmIntent(
                    tripToken: state.boardingPromptTripToken ?? "",
                    originStation: state.boardingPromptOriginStation ?? "",
                    line: state.boardingPromptLine ?? "",
                    trainCode: state.trainCode
                )) {
                    Text(NSLocalizedString("widget.boardingPrompt.disembark.button", comment: "Confirm disembark button label"))
                        .font(.subheadline)
                        .fontWeight(.bold)
                }
                .tint(.white)

                Button(intent: DisembarkNotYetIntent(
                    tripToken: state.boardingPromptTripToken ?? "",
                    originStation: state.boardingPromptOriginStation ?? "",
                    line: state.boardingPromptLine ?? "",
                    trainCode: state.trainCode
                )) {
                    Text(NSLocalizedString("widget.boardingPrompt.disembark.notYet.button", comment: "Not yet disembark button label"))
                        .font(.subheadline)
                }
                .tint(.secondary)
            }
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

            if let subtext = state.resolvedRouteSubtext {
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
