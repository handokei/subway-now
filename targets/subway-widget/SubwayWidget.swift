import WidgetKit
import SwiftUI

// MARK: - Data Model

struct SubwayEntry: TimelineEntry {
    let date: Date
    let stationName: String
    let lineColor: String
    let distanceM: Int
    let isAvailable: Bool
    // 앱이 마지막으로 위젯 데이터를 기록한 시각. nil이면 freshness 표시 생략 (legacy 데이터).
    let savedAt: Date?
    // #1781 — trip 활성 시 추가 필드. nil이면 기존 nearest station UI 유지 (backward compat).
    let tripActive: Bool
    let currentStationName: String?
    let destinationName: String?
    let nextTransferName: String?
    // P4: staleDate — savedAt + 10분 초과 시 시스템 "stale" overlay 표시 차단 임계.
    var staleDate: Date? { savedAt.map { $0.addingTimeInterval(EXPIRED_THRESHOLD_SECONDS) } }
    // P3: Smart Stack relevance (iOS 17+). trip 활성+환승 임박 → 1.0, trip 활성 → 0.8, 평시 → 0.3.
    var relevance: TimelineEntryRelevance? {
        if tripActive && nextTransferName != nil {
            return TimelineEntryRelevance(score: 1.0, duration: 60)
        } else if tripActive {
            return TimelineEntryRelevance(score: 0.8, duration: 60)
        } else {
            return TimelineEntryRelevance(score: 0.3, duration: 0)
        }
    }
}

// Freshness 3단계 임계. savedAt으로부터 경과 시간으로 tier를 결정한다.
// - fresh: ≤ STALE_THRESHOLD_SECONDS → 캡션 미표시 (정상)
// - stale: STALE < t ≤ EXPIRED → "갱신 지연" 캡션 (백그라운드 갱신 일시 중단 신호)
// - expired: > EXPIRED_THRESHOLD_SECONDS → "정보 오래됨" 캡션 + 본문 dim (앱이 죽었거나 권한 끊김)
private let STALE_THRESHOLD_SECONDS: TimeInterval = 2 * 60
private let EXPIRED_THRESHOLD_SECONDS: TimeInterval = 10 * 60

// 본문 dim 시 사용할 opacity (expired tier에서만 적용).
private let EXPIRED_CONTENT_OPACITY: Double = 0.45

enum WidgetFreshness {
    case fresh
    case stale
    case expired
    case unknown // legacy: savedAt nil

    static func from(savedAt: Date?, now: Date) -> WidgetFreshness {
        guard let savedAt = savedAt else { return .unknown }
        let elapsed = now.timeIntervalSince(savedAt)
        if elapsed > EXPIRED_THRESHOLD_SECONDS { return .expired }
        if elapsed > STALE_THRESHOLD_SECONDS { return .stale }
        return .fresh
    }
}

// MARK: - Timeline Provider

struct SubwayProvider: TimelineProvider {
    private let appGroup = "group.com.subwaynow.app"

    func placeholder(in context: Context) -> SubwayEntry {
        SubwayEntry(
            date: Date(),
            stationName: "강남",
            lineColor: "#009933",
            distanceM: 120,
            isAvailable: true,
            savedAt: Date(),
            tripActive: false,
            currentStationName: nil,
            destinationName: nil,
            nextTransferName: nil
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (SubwayEntry) -> Void) {
        completion(makeEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SubwayEntry>) -> Void) {
        let entry = makeEntry()
        // 앱이 종료된 상태에서도 freshness 표시(10분 임계)가 비교적 빨리 반영되도록
        // 5분 간격으로 재평가한다. 앱이 살아있으면 saveWidgetStation이 호출되며 즉시 reload.
        let nextUpdate = Calendar.current.date(byAdding: .minute, value: 5, to: Date()) ?? Date()
        let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
        completion(timeline)
    }

    private func makeEntry() -> SubwayEntry {
        let defaults = UserDefaults(suiteName: appGroup)
        let name = defaults?.string(forKey: "stationName") ?? ""
        let color = defaults?.string(forKey: "lineColor") ?? "#888888"
        let distanceStr = defaults?.string(forKey: "distanceM") ?? "0"
        let distance = Int(distanceStr) ?? 0
        let isAvailable = !name.isEmpty
        // savedAt이 없는 레거시 설치 환경에서는 nil로 두어 freshness 표시를 생략한다.
        let savedAtSec = defaults?.object(forKey: "savedAt") as? Double
        let savedAt = savedAtSec.map { Date(timeIntervalSince1970: $0) }
        // #1781 — trip 활성 필드. 키 없는 레거시 데이터에서는 false로 폴백.
        let tripActive = defaults?.bool(forKey: "tripActive") ?? false
        let currentStationName = defaults?.string(forKey: "currentStationName")
        let destinationName = defaults?.string(forKey: "destinationName")
        let nextTransferName = defaults?.string(forKey: "nextTransferName")

        return SubwayEntry(
            date: Date(),
            stationName: isAvailable ? name : NSLocalizedString("widget.detecting", comment: "Placeholder station name while GPS detection is in progress"),
            lineColor: color,
            distanceM: distance,
            isAvailable: isAvailable,
            savedAt: savedAt,
            tripActive: tripActive,
            currentStationName: currentStationName,
            destinationName: destinationName,
            nextTransferName: nextTransferName
        )
    }
}

// MARK: - Color Extension

extension Color {
    init?(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        guard Scanner(string: hex).scanHexInt64(&int), hex.count == 6 else { return nil }
        let r = Double((int >> 16) & 0xFF) / 255.0
        let g = Double((int >> 8) & 0xFF) / 255.0
        let b = Double(int & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}

// MARK: - Widget View

struct SubwayWidgetView: View {
    var entry: SubwayEntry

    var lineColor: Color {
        Color(hex: entry.lineColor) ?? .gray
    }

    var freshness: WidgetFreshness {
        WidgetFreshness.from(savedAt: entry.savedAt, now: entry.date)
    }

    var freshnessCaption: String? {
        switch freshness {
        case .stale: return NSLocalizedString("widget.freshness.stale", comment: "Caption shown when widget data is stale (2–10 min old)")
        case .expired: return NSLocalizedString("widget.freshness.expired", comment: "Caption shown when widget data is expired (>10 min old)")
        case .fresh, .unknown: return nil
        }
    }

    var contentOpacity: Double {
        freshness == .expired ? EXPIRED_CONTENT_OPACITY : 1.0
    }

    // P4: 위젯 탭 시 앱 딥링크 — 현재역 상세 화면 진입.
    private var deepLink: URL { URL(string: "subway-now://current-station")! }

    var body: some View {
        // iOS 17+는 위젯이 containerBackground를 채택하지 않으면
        // 시스템이 "Please adopt containerBackground API" placeholder를 대신 그린다.
        // 배포 타겟 15.1이라 availability 분기 필요.
        if #available(iOS 17.0, *) {
            content
                .containerBackground(.background, for: .widget)
                .widgetURL(deepLink)
        } else {
            content
                .widgetURL(deepLink)
        }
    }

    private var content: some View {
        Group {
            if entry.tripActive, let currentStation = entry.currentStationName, let destination = entry.destinationName {
                tripActiveContent(currentStation: currentStation, destination: destination)
            } else {
                nearestStationContent
            }
        }
    }

    // trip 비활성 — 기존 최근접 역 UI (backward compat)
    private var nearestStationContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Circle()
                    .fill(lineColor)
                    .frame(width: 10, height: 10)
                Text(NSLocalizedString("widget.header", comment: "Header label shown above the station name in the widget"))
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            Text(entry.stationName)
                .font(.headline)
                .fontWeight(.bold)
                .foregroundColor(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .opacity(contentOpacity)

            if entry.isAvailable {
                Text("\(entry.distanceM)m")
                    .font(.subheadline)
                    .foregroundColor(lineColor)
                    .opacity(contentOpacity)
            }

            if let caption = freshnessCaption {
                Text(caption)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            Spacer()

            Text(entry.date, style: .time)
                .font(.caption2)
                .foregroundColor(.secondary)
        }
        .padding(12)
    }

    // trip 활성 — 현재역 + 다음 환승역(있을 경우) + 도착역
    private func tripActiveContent(currentStation: String, destination: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Circle()
                    .fill(lineColor)
                    .frame(width: 10, height: 10)
                Text("탑승 중")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            Text(currentStation)
                .font(.headline)
                .fontWeight(.bold)
                .foregroundColor(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)

            if let transfer = entry.nextTransferName {
                HStack(spacing: 2) {
                    Text("다음 환승")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Text(transfer)
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .foregroundColor(.primary)
                        .lineLimit(1)
                }
            }

            HStack(spacing: 2) {
                Text("도착 예정")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                Text(destination)
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundColor(lineColor)
                    .lineLimit(1)
            }

            if let caption = freshnessCaption {
                Text(caption)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            Spacer()

            Text(entry.date, style: .time)
                .font(.caption2)
                .foregroundColor(.secondary)
        }
        .padding(12)
    }
}

// MARK: - Lock Screen Widget Views (iOS 16+)

@available(iOS 16.0, *)
struct LockScreenRectangularView: View {
    var entry: SubwayEntry

    var lineColor: Color {
        Color(hex: entry.lineColor) ?? .gray
    }

    var body: some View {
        HStack(spacing: 6) {
            // 노선 색 stripe
            RoundedRectangle(cornerRadius: 2)
                .fill(lineColor)
                .frame(width: 4)

            VStack(alignment: .leading, spacing: 2) {
                Text(NSLocalizedString("widget.lockscreen.title", comment: "Title shown in lock screen rectangular widget"))
                    .font(.caption2)
                    .foregroundColor(.secondary)
                Text(entry.stationName)
                    .font(.headline)
                    .fontWeight(.bold)
                    .foregroundColor(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }

            Spacer(minLength: 0)
        }
        .widgetAccentable()
    }
}

@available(iOS 16.0, *)
struct LockScreenCircularView: View {
    var entry: SubwayEntry

    var lineColor: Color {
        Color(hex: entry.lineColor) ?? .gray
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(lineColor)
            Text(entry.stationName.prefix(2))
                .font(.caption2)
                .fontWeight(.bold)
                .foregroundColor(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .widgetAccentable()
    }
}

// MARK: - Lock Screen Widget Entry View Router

struct SubwayLockScreenWidgetView: View {
    @Environment(\.widgetFamily) var family
    var entry: SubwayEntry

    var body: some View {
        if #available(iOS 16.0, *) {
            switch family {
            case .accessoryRectangular:
                LockScreenRectangularView(entry: entry)
            case .accessoryCircular:
                LockScreenCircularView(entry: entry)
            default:
                EmptyView()
            }
        }
    }
}

// MARK: - Widget Configuration

struct SubwayWidget: Widget {
    let kind = "SubwayWidget"

    private var supportedFamilies: [WidgetFamily] {
        if #available(iOS 16.0, *) {
            return [.systemSmall, .systemMedium, .accessoryRectangular, .accessoryCircular]
        }
        return [.systemSmall, .systemMedium]
    }

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SubwayProvider()) { entry in
            if #available(iOS 16.0, *) {
                SubwayWidgetEntryView(entry: entry)
            } else {
                SubwayWidgetView(entry: entry)
            }
        }
        .configurationDisplayName(NSLocalizedString("widget.displayName", comment: "Widget configuration display name shown in the widget picker"))
        .description(NSLocalizedString("widget.description", comment: "Widget description shown in the widget picker"))
        .supportedFamilies(supportedFamilies)
    }
}

// Routes between home-screen and lock-screen families (iOS 16+).
@available(iOS 16.0, *)
private struct SubwayWidgetEntryView: View {
    @Environment(\.widgetFamily) var family
    var entry: SubwayEntry

    var body: some View {
        switch family {
        case .accessoryRectangular, .accessoryCircular:
            SubwayLockScreenWidgetView(entry: entry)
        default:
            SubwayWidgetView(entry: entry)
        }
    }
}

