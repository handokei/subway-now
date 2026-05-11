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
    }
}
