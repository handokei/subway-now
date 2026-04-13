import WidgetKit
import SwiftUI

// MARK: - Data Model

struct SubwayEntry: TimelineEntry {
    let date: Date
    let stationName: String
    let lineColor: String
    let distanceM: Int
    let isAvailable: Bool
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
            isAvailable: true
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (SubwayEntry) -> Void) {
        completion(makeEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SubwayEntry>) -> Void) {
        let entry = makeEntry()
        let nextUpdate = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date()
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

        return SubwayEntry(
            date: Date(),
            stationName: isAvailable ? name : "감지 중",
            lineColor: color,
            distanceM: distance,
            isAvailable: isAvailable
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

    var body: some View {
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

            if entry.isAvailable {
                Text("\(entry.distanceM)m")
                    .font(.subheadline)
                    .foregroundColor(lineColor)
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

