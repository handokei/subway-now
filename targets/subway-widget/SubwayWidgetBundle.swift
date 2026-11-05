import WidgetKit
import SwiftUI

@main
struct SubwayWidgetBundle: WidgetBundle {
    @WidgetBundleBuilder
    var body: some Widget {
        SubwayWidget()
        if #available(iOS 16.1, *) {
            SubwayLiveActivityWidget()
        }
        // #3221 — 탑승여부 LA(별도 ActivityKit 타입).
        if #available(iOS 16.2, *) {
            BoardingLiveActivityWidget()
        }
    }
}
