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

// 저장 시각으로부터 이 시간이 지나면 위젯에 "정보 오래됨"을 표시한다.
// 백그라운드 위치 갱신이 끊겼거나 앱이 종료된 상태를 사용자에게 알리는 용도.
private let STALE_THRESHOLD_SECONDS: TimeInterval = 10 * 60

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

    // savedAt이 임계치 이전이면 stale로 간주. nil(legacy)이면 stale 표시 생략.
    var isStale: Bool {
        guard let savedAt = entry.savedAt else { return false }
        return entry.date.timeIntervalSince(savedAt) > STALE_THRESHOLD_SECONDS
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

            if entry.isAvailable {
                Text("\(entry.distanceM)m")
                    .font(.subheadline)
                    .foregroundColor(lineColor)
            }

            if isStale {
                Text("정보 오래됨")
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

