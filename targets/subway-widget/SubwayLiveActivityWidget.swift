#if os(iOS)
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// #3221 PR-5 — 여정 LA를 Line Glass 테마로 재작성. 토큰은 LineGlassTokens.swift(theme.ts parity 테스트로 고정).
// 시안: https://claude.ai/artifact/S3gSAWhP51cJ9y6jbcsiZ2 (Main/Journey/Light/Island).
// 질문 행(BoardingPromptRow/BoardingQuestionStandaloneView)은 레이아웃 무변경 — 색 토큰만 맞춘다.

@available(iOS 16.1, *)
extension SubwayActivityAttributes.ContentState {
    /// 다이내믹 아일랜드/배지 점 색 (Dynamic Island는 항상 어두운 배경 -> Night 기준).
    /// 환승 진입이면 갈아탈 노선색, 목적지 진입이면 화이트 계열, 그 외 현재 노선 lit.
    var islandDotColor: Color {
        let night = LineGlassPalette.night
        if alarmType == "destination" { return night.inkStrong.color }
        if alarmType == "transfer", let next = nextLineColorHex {
            return LineTint.make(hex: next, isDark: true).lit
        }
        return LineTint.make(hex: lineColorHex, isDark: true).lit
    }

    /// 짧은 ETA ("15분"). etaMinutes가 없으면 nil.
    var shortEtaText: String? {
        guard let minutes = etaMinutes else { return nil }
        return String(
            format: NSLocalizedString("widget.la.journey.etaShort", comment: "Short ETA for Dynamic Island, e.g. 15 min"),
            minutes
        )
    }

    /// #3221 PR-3 — 매역 도착 표시가 유효한 역명. backend가 split trip의 intermediate 매역 진입 시 무음 update로
    /// `arrivedStationName`/`arrivedUntilEpochSec`를 싣는다. 만료(epoch 초) 전이면 역명, 아니면 nil.
    /// 다음 update는 content-state 전체 교체라 필드 자체가 사라져 자연히 기존 표시로 복귀한다.
    var activeArrivedStationName: String? {
        guard let name = arrivedStationName, let until = arrivedUntilEpochSec,
              Double(until) > Date().timeIntervalSince1970 else { return nil }
        return name
    }

    /// 도착 표시의 오른쪽: 환승이 남았으면 "N분·환승K역", 아니면 "N분·K역"(K = 환승/목적지까지 남은 정거장).
    /// etaMinutes나 정거장 수가 없으면 nil -> 기존 오른쪽 표시로 폴백.
    var arrivedTrailingText: String? {
        guard let minutes = etaMinutes else { return nil }
        if let stops = stopsToTransfer, transferStationName != nil {
            return String(
                format: NSLocalizedString("widget.la.journey.islandArrivedEtaTransfer", comment: "Arrived: minutes and stops to transfer"),
                minutes, stops
            )
        }
        guard let stops = stopsRemaining else { return nil }
        return String(
            format: NSLocalizedString("widget.la.journey.islandArrivedEtaDestination", comment: "Arrived: minutes and stops left"),
            minutes, stops
        )
    }

    /// compact leading 도착 문구: "{역}역 도착".
    func arrivedLeadingText(_ station: String) -> String {
        String(
            format: NSLocalizedString("widget.la.journey.islandArrived", comment: "Arrived at station"),
            station
        )
    }

    /// compact trailing: "역 · N분". 도착 표시 중이면 "N분·환승K역"(정보가 모자라면 기존 표시).
    var compactTrailingText: String {
        if activeArrivedStationName != nil, let arrived = arrivedTrailingText { return arrived }
        guard let eta = shortEtaText else { return stationName }
        return "\(stationName) · \(eta)"
    }
}

@available(iOS 16.1, *)
struct SubwayLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SubwayActivityAttributes.self) { context in
            // 잠금화면 / 배너 뷰
            LockScreenView(state: context.state)
        } dynamicIsland: { context in
            let night = LineGlassPalette.night
            return DynamicIsland {
                // Expanded — 시안 Journey 카드 축약
                DynamicIslandExpandedRegion(.leading) {
                    Circle()
                        .fill(context.state.islandDotColor)
                        .frame(width: 12, height: 12)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.stationName)
                            .font(.headline)
                            .fontWeight(.heavy)
                            .foregroundColor(night.ink.color)
                        if let alarmType = context.state.alarmType,
                           let alarmBody = context.state.alarmBody {
                            Text(alarmBody)
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(alarmType == "destination"
                                                 ? night.ink.color
                                                 : context.state.islandDotColor)
                        } else if context.state.destinationName != nil {
                            ExpandedRouteView(state: context.state)
                        } else {
                            let distance = context.state.resolvedDistanceText
                            Text(distance.map { "\(context.state.lineName) · \($0)" }
                                 ?? context.state.lineName)
                                .font(.caption)
                                .foregroundColor(night.muted.color)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let eta = context.state.shortEtaText {
                        Text(eta)
                            .font(.system(size: 20, weight: .heavy))
                            .foregroundColor(night.ink.color)
                    }
                }
            } compactLeading: {
                if let arrived = context.state.activeArrivedStationName {
                    // #3221 PR-3 — 매역 도착: 점 대신 "{역}역 도착" (소리·배너 없이 축소 표시만).
                    Text(context.state.arrivedLeadingText(arrived))
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundColor(context.state.islandDotColor)
                        .lineLimit(1)
                } else {
                    Circle()
                        .fill(context.state.islandDotColor)
                        .frame(width: 10, height: 10)
                        .padding(.leading, 2)
                }
            } compactTrailing: {
                Text(context.state.compactTrailingText)
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundColor(night.ink.color)
                    .lineLimit(1)
            } minimal: {
                Circle()
                    .fill(context.state.islandDotColor)
                    .frame(width: 10, height: 10)
            }
        }
    }
}

/// 진행 막대 한 칸 (가중치 비례 폭).
private struct ProgressSegment {
    let weight: Double
    let fill: Color
    let glow: Color?
}

@available(iOS 16.1, *)
private struct LineGlassBadge: View {
    let text: String
    let fill: Color

    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .bold))
            .foregroundColor(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(fill)
            .clipShape(Capsule())
    }
}

@available(iOS 16.1, *)
private struct LineGlassPill: View {
    let text: String
    let fill: Color
    let foreground: Color

    var body: some View {
        Text(text)
            .font(.system(size: 15, weight: .heavy))
            .foregroundColor(foreground)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(fill)
            .clipShape(Capsule())
            .fixedSize()
    }
}

@available(iOS 16.1, *)
private struct JourneyProgressBar: View {
    let segments: [ProgressSegment]

    private let gap: CGFloat = 6

    var body: some View {
        GeometryReader { geo in
            let total = max(segments.reduce(0) { $0 + $1.weight }, 0.0001)
            let usable = max(geo.size.width - gap * CGFloat(max(segments.count - 1, 0)), 0)
            HStack(spacing: gap) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(segment.fill)
                        .frame(width: usable * CGFloat(segment.weight / total), height: 4)
                        .shadow(color: segment.glow ?? .clear, radius: segment.glow == nil ? 0 : 4)
                }
            }
            .frame(height: 6)
        }
        .frame(height: 6)
    }
}

@available(iOS 16.1, *)
private struct LockScreenView: View {
    let state: SubwayActivityAttributes.ContentState

    // AOD (Always-On Display) 환경 감지 — isLuminanceReduced=true 시 lit/glow를 끄고 hair만 쓴다
    @Environment(\.isLuminanceReduced) var isLuminanceReduced
    // Night/Light 분기 — 토큰은 LineGlassTokens.swift
    @Environment(\.colorScheme) var colorScheme

    var isDark: Bool { colorScheme == .dark }

    var palette: LineGlassPalette { LineGlassPalette.resolve(colorScheme) }

    var tint: LineTint { LineTint.make(hex: state.lineColorHex, isDark: isDark) }

    /// 갈아탈 노선 tint. 노선색 필드가 없으면 현재 노선 tint로 대체.
    var nextTint: LineTint {
        guard let hex = state.nextLineColorHex else { return tint }
        return LineTint.make(hex: hex, isDark: isDark)
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
    /// 판정은 추가하지 않는다(A+C 원칙) — `isBoardingPrompt`는 `boardingPhase` 유무만 보고
    /// 그 값은 backend가 결정한다. 이 파일은 **받은 대로 그리기만** 한다.
    ///
    /// #3101 — 단, **발사 순간**(`isBoardingQuestionAlert`)에는 질문 행만 **단독**으로 그린다.
    /// (#3221 PR-1/PR-6에서 탑승 LA가 분리되면 이 합성은 여정 전용으로 줄어든다 — 이 PR은 단일 LA 유지.)
    var body: some View {
        VStack(spacing: 0) {
            if isBoardingQuestionAlert {
                BoardingQuestionStandaloneView(state: state, phase: state.boardingPhase ?? "")
            } else {
                stateView
                if isBoardingPrompt {
                    BoardingPromptRow(state: state, phase: state.boardingPhase ?? "")
                }
            }
        }
        // #3221 — 반투명 55%(배경화면이 비침). 테두리 + 상단 1px 하이라이트로 유리 질감을 낸다.
        // 글자색은 iOS가 배경화면 밝기로 주는 colorScheme을 따른다. AOD는 hair만 쓰고 배경은 iOS 처리에 맡긴다.
        .activityBackgroundTint(palette.laBackground.color)
        .activitySystemActionForegroundColor(palette.ink.color)
        .overlay {
            Rectangle()
                .strokeBorder(isLuminanceReduced ? palette.hair.color : palette.laBorder.color, lineWidth: 1)
        }
        .overlay(alignment: .top) {
            if !isLuminanceReduced {
                Rectangle()
                    .fill(palette.laHighlight.color)
                    .frame(height: 1)
            }
        }
    }

    /// 상태 표시(주) — 환승 진입 / 목적지 진입 / 이동 중.
    @ViewBuilder
    private var stateView: some View {
        if state.alarmType == "transfer" {
            transferCard
        } else if state.alarmType == "destination" {
            destinationCard
        } else {
            journeyCard
        }
    }

    // MARK: 환승역 진입 — 갈아탈 노선 색 그라데이션 + [환승] 알약

    private var transferCard: some View {
        let target = nextTint
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    LineGlassBadge(text: state.lineName, fill: tint.base)
                    if state.nextLineName != nil || state.nextLineColorHex != nil {
                        Text("→")
                            .font(.system(size: 13))
                            .foregroundColor(palette.muted.color)
                        if let nextLineName = state.nextLineName {
                            LineGlassBadge(text: nextLineName, fill: target.base)
                        } else {
                            // 노선명 필드가 없는 payload — 노선색 칩만 표시.
                            Capsule()
                                .fill(target.base)
                                .frame(width: 28, height: 18)
                        }
                    }
                }
                Text(state.alarmStationName ?? state.stationName)
                    .font(.system(size: 30, weight: .heavy))
                    .tracking(-1)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .foregroundColor(palette.ink.color)
                Text(transferHintText)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(isLuminanceReduced ? palette.muted.color : target.text)
                    .lineLimit(2)
            }
            Spacer()
            LineGlassPill(
                text: NSLocalizedString("widget.la.journey.transferBadge", comment: "Transfer pill label"),
                fill: isLuminanceReduced ? palette.hair.color : target.lit,
                foreground: isLuminanceReduced ? palette.ink.color : palette.onInkStrong.color
            )
        }
        .padding(16)
        .background(cardBackground(top: target.base.opacity(isDark ? 0.28 : 0.16)))
    }

    /// "지금 내려서 2호선 성수 방면으로" — 노선+방면이 모두 있을 때. 아니면 서버/기기 alarmBody, 그것도 없으면 기본 문구.
    private var transferHintText: String {
        if let line = state.nextLineName, let direction = state.nextLineDirection {
            return String(
                format: NSLocalizedString("widget.la.journey.transferHintTo", comment: "Transfer hint with next line and direction station"),
                line, direction
            )
        }
        return state.alarmBody ?? NSLocalizedString("widget.la.journey.transferHint", comment: "Transfer hint under station name")
    }

    /// "다음 군자" — 다음 역을 모르면 기존 "현재역".
    private var stationCaption: String {
        guard let next = state.nextStationName else {
            return NSLocalizedString("widget.la.journey.currentStation", comment: "Label above current station")
        }
        return String(format: NSLocalizedString("widget.la.journey.nextStation", comment: "Label: next station"), next)
    }

    // MARK: 목적지 진입 — [하차] inkStrong 알약

    private var destinationCard: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                LineGlassBadge(text: state.lineName, fill: tint.base)
                Text(state.alarmStationName ?? state.stationName)
                    .font(.system(size: 30, weight: .heavy))
                    .tracking(-1)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .foregroundColor(palette.ink.color)
                Text(state.alarmBody ?? NSLocalizedString("widget.la.journey.alightHint", comment: "Alight hint under station name"))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(palette.ink.color)
                    .lineLimit(2)
            }
            Spacer()
            LineGlassPill(
                text: NSLocalizedString("widget.la.journey.alightBadge", comment: "Alight pill label"),
                fill: isLuminanceReduced ? palette.hair.color : palette.inkStrong.color,
                foreground: isLuminanceReduced ? palette.ink.color : palette.onInkStrong.color
            )
        }
        .padding(16)
        // Night만 노선 lit 그라데이션을 얹는다 (시안: Light는 평면 glass).
        .background(cardBackground(top: isDark ? tint.lit.opacity(0.18) : nil))
    }

    /// 카드 배경 — AOD면 그라데이션 없음. top이 nil이면 평면.
    @ViewBuilder
    private func cardBackground(top: Color?) -> some View {
        if let top, !isLuminanceReduced {
            LinearGradient(
                stops: [
                    .init(color: top, location: 0),
                    .init(color: Color.clear, location: 0.7),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        } else {
            Color.clear
        }
    }

    // MARK: 이동 중 — 노선 배지 / 현재역 / 남은 시간 / 진행 막대 / route 줄

    private var journeyCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        LineGlassBadge(
                            text: state.lineName,
                            fill: isLuminanceReduced ? tint.base.opacity(0.5) : tint.base
                        )
                        Text(stationCaption)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(palette.muted.color)
                    }
                    Text(state.stationName)
                        .font(.system(size: 30, weight: .heavy))
                        .tracking(-1)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .foregroundColor(palette.ink.color)
                }
                Spacer(minLength: 8)
                if let eta = state.etaMinutes {
                    VStack(alignment: .trailing, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 2) {
                            Text("\(eta)")
                                .font(.system(size: 30, weight: .heavy))
                                .tracking(-1)
                            Text(NSLocalizedString("widget.la.journey.minuteUnit", comment: "Minute unit next to ETA number"))
                                .font(.system(size: 15, weight: .bold))
                        }
                        .foregroundColor(palette.ink.color)
                        if let destination = state.destinationName {
                            Text(String(
                                format: NSLocalizedString("widget.la.journey.untilArrival", comment: "Caption under ETA, e.g. 'Until arrival at X'"),
                                destination
                            ))
                            .font(.system(size: 12))
                            .foregroundColor(palette.muted.color)
                            .lineLimit(1)
                        }
                    }
                }
            }

            // 필드가 없으면(구 payload / 산출 불가) 막대를 숨긴다.
            if let segments = progressSegments {
                JourneyProgressBar(segments: segments)
            }

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let destination = state.destinationName {
                    Text("→ \(destination)")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(palette.ink.color)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if let trailing = footerTrailingText {
                    Text(trailing)
                        .font(.system(size: 14))
                        .foregroundColor(palette.muted.color)
                        .lineLimit(1)
                }
            }

            // 데이터 출처 자백 (#327). 없으면 표시 생략. (U6 — 별도 칩은 만들지 않는다)
            if let sourceLabel = state.sourceLabel {
                Text(sourceLabel)
                    .font(.caption2)
                    .foregroundColor(palette.muted.color)
            }
        }
        .padding(16)
    }

    /// "건대입구 환승 · 남은 5역" / "남은 5역" / (backend 값이 없으면) 기존 파생 텍스트.
    private var footerTrailingText: String? {
        if let stops = state.stopsRemaining {
            if let transfer = state.transferStationName {
                return String(
                    format: NSLocalizedString("widget.la.journey.transferAndStopsLeft", comment: "Transfer station and remaining stops, e.g. 'Transfer at X · 5 stops left'"),
                    transfer, stops
                )
            }
            return String(
                format: NSLocalizedString("widget.la.journey.stopsLeft", comment: "Remaining stops, e.g. '5 stops left'"),
                stops
            )
        }
        if state.destinationName != nil { return state.resolvedRouteSubtext }
        return state.resolvedDistanceText
    }

    /// 진행 막대: [현재 leg 지난 구간 lit+glow][현재 leg 남은 구간 hair][환승 후 leg 노선색 35%].
    /// 환승이 남아 있으면(nextLegStopsTotal) 현재 leg 남은 수는 stopsToTransfer, 아니면 stopsRemaining.
    private var progressSegments: [ProgressSegment]? {
        guard let total = state.legStopsTotal, total > 0 else { return nil }
        let rawRemaining = state.nextLegStopsTotal != nil ? state.stopsToTransfer : state.stopsRemaining
        guard let rawRemaining else { return nil }
        let remaining = min(max(rawRemaining, 0), total)
        let traveled = total - remaining

        let hair = palette.hair.color
        var segments: [ProgressSegment] = [
            ProgressSegment(
                weight: max(Double(traveled), 0.5),
                fill: isLuminanceReduced ? hair : tint.lit,
                glow: isLuminanceReduced ? nil : tint.glow
            ),
        ]
        if remaining > 0 {
            segments.append(ProgressSegment(weight: Double(remaining), fill: hair, glow: nil))
        }
        if let nextTotal = state.nextLegStopsTotal, nextTotal > 0 {
            segments.append(ProgressSegment(
                weight: Double(nextTotal),
                fill: isLuminanceReduced ? hair : nextTint.base.opacity(0.35),
                glow: nil
            ))
        }
        return segments
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

    @Environment(\.colorScheme) var colorScheme

    var palette: LineGlassPalette { LineGlassPalette.resolve(colorScheme) }

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
                .fill(palette.hair.color)
                .frame(height: 1)

            HStack(spacing: 12) {
                // #2997 S2 — 역명은 상태 뷰(`stateView`)가 이미 그린다. 여기서는 질문만.
                Text(NSLocalizedString(questionKey, comment: "Live Activity boarding/disembark confirmation prompt"))
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundColor(palette.ink.color.opacity(0.85))

                Spacer()

                if #available(iOS 17.0, *) {
                    BoardingPromptButton(state: state, phase: phase, autoLockedTracking: isAutoLockedTracking)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }
}

/// #3101 — 발사 순간 **단독** 질문 카드. 상태 뷰(역명)가 숨겨지므로 서버 발신 alert 문구
/// (`boardingAlertTitle`/`boardingAlertBody`)를 크게 보여 "어느 역에 왔는지"를 알린다.
/// 버튼은 `BoardingPromptButton`(iOS 17+) 재사용 — 16.x는 문구만.
@available(iOS 16.1, *)
private struct BoardingQuestionStandaloneView: View {
    let state: SubwayActivityAttributes.ContentState
    let phase: String

    @Environment(\.colorScheme) var colorScheme

    var palette: LineGlassPalette { LineGlassPalette.resolve(colorScheme) }

    /// 서버 문구가 비어 있으면 기존 질문 키로 fallback.
    var titleText: String {
        if let title = state.boardingAlertTitle, !title.isEmpty { return title }
        return NSLocalizedString("widget.boardingPrompt.boarded.question", comment: "Live Activity boarding confirmation prompt")
    }

    var bodyText: String? {
        guard let body = state.boardingAlertBody, !body.isEmpty else { return nil }
        return body
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(titleText)
                    .font(.headline)
                    .fontWeight(.bold)
                    .foregroundColor(palette.ink.color)
                if let bodyText {
                    Text(bodyText)
                        .font(.subheadline)
                        .foregroundColor(palette.ink.color.opacity(0.85))
                }
            }

            Spacer()

            if #available(iOS 17.0, *) {
                BoardingPromptButton(
                    state: state,
                    phase: phase,
                    autoLockedTracking: phase == "pre-boarding" && state.boardingAutoLocked == true
                )
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 20)
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

    @Environment(\.colorScheme) var colorScheme

    var palette: LineGlassPalette { LineGlassPalette.resolve(colorScheme) }

    var body: some View {
        if phase == "end-prompt" {
            // #3007 S4-c — 종료는 사용자 결정이므로 버튼 하나만 둔다. "계속"은 **버튼이 아니라
            // 무응답**이다(아무것도 누르지 않으면 트립이 그대로 유지된다) — 선택을 강요하지 않는다.
            Button(intent: EndTripIntent(tripToken: state.boardingPromptTripToken ?? "")) {
                Text(NSLocalizedString("widget.endPrompt.end.button", comment: "End guidance button label"))
                    .font(.subheadline)
                    .fontWeight(.bold)
            }
            .tint(palette.inkStrong.color)
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
            .tint(palette.muted.color)
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
                .tint(palette.inkStrong.color)

                Button(intent: NotBoardedIntent(
                    tripToken: state.boardingPromptTripToken ?? "",
                    originStation: state.boardingPromptOriginStation ?? "",
                    line: state.boardingPromptLine ?? "",
                    trainCode: state.trainCode
                )) {
                    Text(NSLocalizedString("widget.boardingPrompt.boarded.notBoarded.button", comment: "Not boarded button label"))
                        .font(.subheadline)
                }
                .tint(palette.muted.color)
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
                .tint(palette.inkStrong.color)

                Button(intent: DisembarkNotYetIntent(
                    tripToken: state.boardingPromptTripToken ?? "",
                    originStation: state.boardingPromptOriginStation ?? "",
                    line: state.boardingPromptLine ?? "",
                    trainCode: state.trainCode
                )) {
                    Text(NSLocalizedString("widget.boardingPrompt.disembark.notYet.button", comment: "Not yet disembark button label"))
                        .font(.subheadline)
                }
                .tint(palette.muted.color)
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
            .foregroundColor(LineGlassPalette.night.muted.color)
    }
}
#endif
