import SwiftUI
import NexusCore

@main
struct NexusApp: App {
    /// One shared `APIClient` drives the connection lifecycle, the live
    /// approvals hub, and push. Held in `@State`; injected into the environment.
    @State private var connection: ConnectionStore
    @State private var liveHub: LiveHub
    @State private var pushManager: PushManager
    @State private var router: AppRouter
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        let api = APIClient()
        let router = AppRouter()
        _connection = State(initialValue: ConnectionStore(api: api))
        _liveHub = State(initialValue: LiveHub(api: api))
        _router = State(initialValue: router)
        _pushManager = State(initialValue: PushManager(api: api, router: router))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(connection)
                .environment(liveHub)
                .environment(router)
                .environment(pushManager)
                .task {
                    appDelegate.push = pushManager
                    await connection.loadPersisted()
                }
        }
    }
}
