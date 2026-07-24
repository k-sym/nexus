import SwiftUI
import NexusCore

@main
struct NexusApp: App {
    /// One shared `APIClient` drives both the connection lifecycle and the live
    /// approvals hub. Held in `@State`; injected into the environment.
    @State private var connection: ConnectionStore
    @State private var liveHub: LiveHub

    init() {
        let api = APIClient()
        _connection = State(initialValue: ConnectionStore(api: api))
        _liveHub = State(initialValue: LiveHub(api: api))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(connection)
                .environment(liveHub)
                .task { await connection.loadPersisted() }
        }
    }
}
