import SwiftUI

/// Top-level gate: show the connected shell once the backend is reachable and
/// the token is accepted, otherwise the onboarding/connection screen.
struct RootView: View {
    @Environment(ConnectionStore.self) private var connection

    var body: some View {
        switch connection.phase {
        case .connected:
            RootShellView()
        default:
            ConnectionOnboardingView()
        }
    }
}
