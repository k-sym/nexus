import SwiftUI
import NexusCore

/// Import from Claude Desktop: the desktop app's and the terminal's Claude Code
/// sessions under the project's repo path, minus those already on the board.
/// Tapping one creates a thread that continues it on the same session id and
/// opens the chat through the router, the way a board card does.
struct DesktopSessionListView: View {
    private let api: APIClient
    private let projectId: String
    @State private var state: LoadState<DesktopSessionsResponse> = .idle
    @State private var importing: String?
    @State private var importError: String?
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss

    init(api: APIClient, projectId: String) {
        self.api = api
        self.projectId = projectId
    }

    var body: some View {
        content
            .navigationTitle("Claude Desktop")
            .navigationBarTitleDisplayMode(.inline)
            .task { if state.value == nil { await load() } }
            .refreshable { await load() }
            .alert("Couldn't import", isPresented: Binding(get: { importError != nil }, set: { if !$0 { importError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(importError ?? "")
            }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .idle, .loading:
            ProgressView("Looking for sessions…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ErrorStateView(message: message) { Task { await load() } }
        case .loaded(let res):
            if res.sessions.isEmpty {
                ContentUnavailableView {
                    Label("No sessions", systemImage: "desktopcomputer")
                } description: {
                    Text("No Claude Desktop or terminal sessions for this project's repo path.")
                }
            } else {
                List {
                    Section {
                        ForEach(res.sessions) { session in
                            Button {
                                Task { await importSession(session) }
                            } label: {
                                row(session)
                            }
                            .disabled(importing != nil)
                        }
                    } footer: {
                        if !res.desktop.appFound {
                            Text("Claude Desktop is not installed on the machine running Nexus; these are terminal sessions.")
                        } else {
                            Text("Importing keeps the session live in the desktop app too.")
                        }
                    }
                }
            }
        }
    }

    private func row(_ session: DesktopSessionSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.title).font(.body).lineLimit(2).foregroundStyle(.primary)
                Spacer(minLength: 0)
                if importing == session.id {
                    ProgressView().controlSize(.mini)
                }
            }
            if let prompt = session.firstPrompt, prompt != session.title {
                Text(prompt).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack(spacing: 6) {
                if let branch = session.gitBranch {
                    Text(branch).font(.caption2.monospaced())
                }
                if let when = RelativeTime.parse(session.lastModified) {
                    if session.gitBranch != nil { Text("·") }
                    Text(RelativeTime.string(from: when))
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }

    private func load() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.desktopSessions(projectId: projectId))
        } catch {
            if state.value == nil { state = .failed(LoadState<DesktopSessionsResponse>.message(for: error)) }
        }
    }

    private func importSession(_ session: DesktopSessionSummary) async {
        guard importing == nil else { return }
        importing = session.id
        defer { importing = nil }
        do {
            let result = try await api.importDesktopSession(projectId: projectId, sessionId: session.id)
            router.openThread = OpenThread(id: result.thread.id, title: result.thread.title)
            dismiss()
        } catch {
            importError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
