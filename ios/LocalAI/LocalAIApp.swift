// Local AI for iPhone: talk to LFM3 running on the phone itself, or to the models your own machines are running.
//   Engine/   the model on this iPhone: its file, llama.cpp, and how LFM3's conversations are written
//   Remote/   your machines running Local AI, and chatting with their models
//   Views/    the screens
import SwiftUI

@main
struct LocalAIApp: App {
    @State private var file = ModelFile()
    @State private var machines = Machines()
    @State private var talk = Conversation()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ChatScreen()
                .environment(file)
                .environment(machines)
                .environment(talk)
                .preferredColorScheme(.dark)
                .tint(Ink.text)
                // While the app is in front, your machines are asked every few seconds what they are running.
                .task(id: phase) {
                    while phase == .active, !Task.isCancelled {
                        await machines.refresh()
                        talk.settle(phoneReady: phoneReady, machines: machines.models)
                        try? await Task.sleep(for: .seconds(5))
                    }
                }
                .onChange(of: file.state) { talk.settle(phoneReady: phoneReady, machines: machines.models) }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in talk.unload() }
        }
    }

    private var phoneReady: Bool { OnDeviceModel.canRun && OnDeviceModel.fits && file.state == .ready }
}
