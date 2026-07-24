import SwiftUI

/// M1 settings: connection info + disconnect. The full config editor
/// (`GET/PUT /api/settings` with masked-secret handling) lands in M4.
struct SettingsView: View {
    @Environment(ConnectionStore.self) private var connection

    var body: some View {
        List {
            Section("Connection") {
                LabeledContent("Host", value: connection.host ?? "—")
                if let count = connection.projectCount {
                    LabeledContent("Projects", value: "\(count)")
                }
                LabeledContent("Status", value: "Connected")
            }

            Section {
                Button("Disconnect", role: .destructive) {
                    Task { await connection.disconnect() }
                }
            } footer: {
                Text("Forgets the saved base URL and removes the token from the Keychain.")
            }
        }
        .navigationTitle("Settings")
    }
}
