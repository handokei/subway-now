import ExpoModulesCore
import AVFoundation

public class AudioRouteModule: Module {
    public func definition() -> ModuleDefinition {
        Name("AudioRoute")

        Function("isHeadphonesConnected") { () -> Bool in
            let route = AVAudioSession.sharedInstance().currentRoute
            let headphoneTypes: Set<AVAudioSession.Port> = [
                .headphones,
                .bluetoothA2DP,
                .bluetoothHFP,
                .bluetoothLE,
            ]
            return route.outputs.contains { headphoneTypes.contains($0.portType) }
        }
    }
}
