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
            savedAt: Date()
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

        return SubwayEntry(
            date: Date(),
            stationName: isAvailable ? name : "감지 중",
            lineColor: color,
            distanceM: distance,
            isAvailable: isAvailable,
            savedAt: savedAt
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
        case .stale: return "갱신 지연"
        case .expired: return "정보 오래됨"
        case .fresh, .unknown: return nil
        }
    }

    var contentOpacity: Double {
        freshness == .expired ? EXPIRED_CONTENT_OPACITY : 1.0
    }

    var body: some View {
        // iOS 17+는 위젯이 containerBackground를 채택하지 않으면
        // 시스템이 "Please adopt containerBackground API" placeholder를 대신 그린다.
        // 배포 타겟 15.1이라 availability 분기 필요.
        if #available(iOS 17.0, *) {
            content.containerBackground(.background, for: .widget)
        } else {
            content
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Circle()
                    .fill(lineColor)
                    .frame(width: 10, height: 10)
                Text("지하철")
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
}

// MARK: - Widget Configuration

struct SubwayWidget: Widget {
    let kind = "SubwayWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SubwayProvider()) { entry in
            SubwayWidgetView(entry: entry)
        }
        .configurationDisplayName("지하철 현재 역")
        .description("가장 가까운 지하철역을 홈 화면에서 확인하세요.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

