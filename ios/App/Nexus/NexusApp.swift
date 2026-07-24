import SwiftUI
import NexusCore

@main
struct NexusApp: App {
    /// Owns the single shared `APIClient` and the connection lifecycle. Held in
    /// `@State` so it survives view updates; injected into the environment.
    @State private var connection = ConnectionStore(api: APIClient())

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(connection)
                .task { await connection.loadPersisted() }
        }
    }
}
