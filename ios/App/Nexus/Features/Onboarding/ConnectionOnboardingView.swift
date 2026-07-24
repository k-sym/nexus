import SwiftUI

/// Pre-auth screen: enter the backend base URL + shared token, then connect.
/// Handles the connecting / unreachable / token-rejected phases inline.
struct ConnectionOnboardingView: View {
    @Environment(ConnectionStore.self) private var connection

    var body: some View {
        @Bindable var connection = connection

        NavigationStack {
            Form {
                Section {
                    TextField("https://host.ts.net:8444", text: $connection.baseURLText)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField(tokenFieldPrompt, text: $connection.tokenText)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Nexus backend")
                } footer: {
                    Text("Reachable over your tailnet. The token is stored in the Keychain and sent as a bearer on every request.")
                }

                Section {
                    Button(action: connect) {
                        HStack {
                            if isConnecting { ProgressView().controlSize(.small) }
                            Text(isConnecting ? "Connecting…" : "Connect")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(isConnecting || connection.baseURLText.isEmpty)
                }

                if let status = statusMessage {
                    Section {
                        Label(status.text, systemImage: status.icon)
                            .foregroundStyle(status.tint)
                            .font(.callout)
                    }
                }
            }
            .navigationTitle("Connect to Nexus")
        }
    }

    private var isConnecting: Bool { connection.phase == .connecting }

    private var tokenFieldPrompt: String {
        connection.hasStoredToken ? "Token (leave blank to keep saved)" : "Access token"
    }

    private var statusMessage: (text: String, icon: String, tint: Color)? {
        switch connection.phase {
        case .unreachable(let reason):
            return (reason, "wifi.exclamationmark", .orange)
        case .tokenRejected:
            return ("The token was rejected (401). Check the shared token and try again.", "lock.trianglebadge.exclamationmark", .red)
        default:
            return nil
        }
    }

    private func connect() {
        Task { await connection.connect() }
    }
}
