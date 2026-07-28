import SwiftUI
import NexusCore

@MainActor
@Observable
final class AssistantSessionsViewModel {
    private let api: APIClient
    var state: LoadState<[AssistantSession]> = .idle
    var isCreating = false
    /// Non-nil surfaces a delete failure as an alert.
    var actionError: String?

    init(api: APIClient) { self.api = api }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.assistantSessions())
        } catch {
            state = .failed(LoadState<[AssistantSession]>.message(for: error))
        }
    }

    /// Create a new local session and return it (for immediate navigation).
    func createSession() async -> AssistantSession? {
        isCreating = true
        defer { isCreating = false }
        let session = try? await api.createAssistantSession()
        await refresh()
        return session
    }

    /// Hard-delete a local session, optimistic with rollback.
    func delete(_ session: AssistantSession) async {
        let previous = state.value
        if var sessions = state.value {
            sessions.removeAll { $0.id == session.id }
            state = .loaded(sessions)
        }
        do {
            try await api.deleteAssistantSession(sessionId: session.id)
            await refresh()
        } catch {
            if let previous { state = .loaded(previous) }
            actionError = (error as? APIError)?.errorDescription ?? "Couldn't delete the session."
        }
    }

    /// Soft-archive a local session (`PATCH {archived:true}`). Reversible on the
    /// backend, unlike thread archive — but the list only shows unarchived rows,
    /// so it drops from view. Optimistic with rollback.
    func archive(_ session: AssistantSession) async {
        let previous = state.value
        if var sessions = state.value {
            sessions.removeAll { $0.id == session.id }
            state = .loaded(sessions)
        }
        do {
            _ = try await api.patchAssistantSession(sessionId: session.id, archived: true)
            await refresh()
        } catch {
            if let previous { state = .loaded(previous) }
            actionError = (error as? APIError)?.errorDescription ?? "Couldn't archive the session."
        }
    }

    /// Rename a local session (`PATCH {title}`). Optimistic with rollback; a
    /// blank title is a no-op.
    func rename(_ session: AssistantSession, to newTitle: String) async {
        let trimmed = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != session.title else { return }
        let previous = state.value
        if var sessions = state.value, let index = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[index] = session.withTitle(trimmed)
            state = .loaded(sessions)
        }
        do {
            _ = try await api.patchAssistantSession(sessionId: session.id, title: trimmed)
            await refresh()
        } catch {
            if let previous { state = .loaded(previous) }
            actionError = (error as? APIError)?.errorDescription ?? "Couldn't rename the session."
        }
    }
}

/// Programmatic push target for a just-created session. Row taps use
/// closure-based `NavigationLink`s (self-contained, no `navigationDestination`
/// registration — value-based routing doesn't reliably register from these
/// stacks, per the #311 nav-redesign finding); create needs a programmatic push,
/// so it goes through this item-based destination instead.
struct NewAssistantSession: Hashable, Identifiable {
    let id: String
    let title: String
}

/// The Assistant surface: a merged list of local + adoptable-remote Hermes
/// sessions, feeding the shared streaming chat via `AssistantChatEndpoint`.
struct AssistantView: View {
    private let api: APIClient
    @State private var vm: AssistantSessionsViewModel
    /// Set by the Delete swipe action; drives the confirmation dialog.
    @State private var pendingDelete: AssistantSession?
    /// Set by the Rename swipe action; drives the rename alert.
    @State private var pendingRename: AssistantSession?
    @State private var renameText: String = ""
    /// Programmatic push target for a just-created session.
    @State private var createdSession: NewAssistantSession?

    init(api: APIClient) {
        self.api = api
        _vm = State(initialValue: AssistantSessionsViewModel(api: api))
    }

    var body: some View {
        content
            .navigationTitle("Assistant")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task {
                            if let session = await vm.createSession() {
                                createdSession = NewAssistantSession(id: session.id, title: session.title)
                            }
                        }
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .disabled(vm.isCreating)
                }
            }
            .navigationDestination(item: $createdSession) { session in
                StreamingChatView(
                    endpoint: AssistantChatEndpoint(api: api, sessionId: session.id), title: session.title)
            }
            .task { if vm.state.value == nil { await vm.refresh() } }
            .confirmationDialog(
                "Delete this session?",
                isPresented: deleteDialogBinding,
                presenting: pendingDelete
            ) { session in
                Button("Delete", role: .destructive) { Task { await vm.delete(session) } }
                Button("Cancel", role: .cancel) {}
            } message: { session in
                Text("“\(session.title)” will be permanently deleted. This can't be undone.")
            }
            .alert("Rename session", isPresented: renameDialogBinding, presenting: pendingRename) { session in
                TextField("Title", text: $renameText)
                Button("Save") {
                    Task { await vm.rename(session, to: renameText) }
                    pendingRename = nil
                }
                Button("Cancel", role: .cancel) { pendingRename = nil }
            } message: { _ in
                Text("Enter a new name for this session.")
            }
            .alert("Something went wrong", isPresented: actionErrorBinding, presenting: vm.actionError) { _ in
                Button("OK", role: .cancel) { vm.actionError = nil }
            } message: { message in
                Text(message)
            }
    }

    /// A local session opens the chat directly; a remote-only row adopts first.
    @ViewBuilder
    private func rowDestination(_ session: AssistantSession) -> some View {
        if session.remoteOnly {
            AssistantAdoptingView(
                api: api, remoteSessionId: session.adoptableRemoteId, fallbackTitle: session.title,
                onAdopted: { Task { await vm.refresh() } })
        } else {
            StreamingChatView(endpoint: AssistantChatEndpoint(api: api, sessionId: session.id), title: session.title)
        }
    }

    private var deleteDialogBinding: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var renameDialogBinding: Binding<Bool> {
        Binding(get: { pendingRename != nil }, set: { if !$0 { pendingRename = nil } })
    }

    private var actionErrorBinding: Binding<Bool> {
        Binding(get: { vm.actionError != nil }, set: { if !$0 { vm.actionError = nil } })
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let sessions):
            if sessions.isEmpty {
                ContentUnavailableView {
                    Label("No assistant sessions", systemImage: "bubble.left.and.text.bubble.right")
                } description: {
                    Text("Start one with the compose button.")
                }
            } else {
                List(sessions) { session in
                    NavigationLink {
                        rowDestination(session)
                    } label: {
                        AssistantSessionRow(session: session)
                    }
                    // Session actions apply to local rows only — a remote-only
                    // row isn't a local session until it's adopted (on tap).
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if !session.remoteOnly {
                            Button(role: .destructive) {
                                pendingDelete = session
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button {
                                Task { await vm.archive(session) }
                            } label: {
                                Label("Archive", systemImage: "archivebox")
                            }
                            .tint(.orange)
                        }
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        if !session.remoteOnly {
                            Button {
                                renameText = session.title
                                pendingRename = session
                            } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            .tint(.blue)
                        }
                    }
                }
                .refreshable { await vm.refresh() }
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }
}

/// One merged-list row: title, an "Updated Xm ago" subtitle with a source badge
/// for remote rows, and a running indicator when the latest run is in flight.
struct AssistantSessionRow: View {
    let session: AssistantSession

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title)
                    .font(.body)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    if let badge = session.sourceBadge {
                        Text(badge)
                            .font(.caption2.weight(.bold))
                            .tracking(0.5)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(.thinMaterial, in: Capsule())
                    }
                    if let subtitle = updatedSubtitle {
                        Text(subtitle)
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
            if session.isRunning {
                AssistantRunningDot()
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .padding(.vertical, 2)
        .animation(.snappy, value: session.isRunning)
    }

    private var updatedSubtitle: String? {
        guard let iso = session.updatedAt, let date = RelativeTime.parse(iso) else { return nil }
        return "Updated \(RelativeTime.string(from: date))"
    }
}

/// A small pulsing green dot signalling an in-flight run. Mirrors the run/idle
/// colour vocabulary used by `ProjectStatusBadge` (working = green here as a dot).
struct AssistantRunningDot: View {
    @State private var pulsing = false

    var body: some View {
        Circle()
            .fill(.green)
            .frame(width: 9, height: 9)
            .opacity(pulsing ? 0.35 : 1)
            .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: pulsing)
            .onAppear { pulsing = true }
            .accessibilityLabel("Running")
    }
}

/// Adopts a remote-only Hermes session (import → local), then hands off to the
/// shared chat. Tolerates a slow/failed import with a spinner and retry.
struct AssistantAdoptingView: View {
    let api: APIClient
    let remoteSessionId: String
    let fallbackTitle: String
    var onAdopted: () -> Void = {}

    @State private var phase: Phase = .loading

    enum Phase: Equatable {
        case loading
        case ready(id: String, title: String)
        case failed(String)
    }

    var body: some View {
        Group {
            switch phase {
            case .loading:
                ProgressView("Adopting session…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .ready(let id, let title):
                StreamingChatView(endpoint: AssistantChatEndpoint(api: api, sessionId: id), title: title)
            case .failed(let message):
                ErrorStateView(message: message) { Task { await adopt() } }
            }
        }
        .navigationTitle(fallbackTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task { if case .loading = phase { await adopt() } }
    }

    private func adopt() async {
        phase = .loading
        do {
            let detail = try await api.importAssistantSession(remoteSessionId: remoteSessionId)
            phase = .ready(id: detail.session.id, title: detail.session.title)
            onAdopted()
        } catch {
            phase = .failed((error as? APIError)?.errorDescription ?? "Couldn't adopt this session.")
        }
    }
}

/// ISO-8601 → compact relative string ("3m ago"). Assistant rows carry
/// millisecond-precision ISO timestamps (`new Date().toISOString()`), so try the
/// fractional-seconds parser first, then the plain one.
enum RelativeTime {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()
    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    static func parse(_ iso: String) -> Date? {
        fractional.date(from: iso) ?? plain.date(from: iso)
    }

    static func string(from date: Date, now: Date = Date()) -> String {
        relative.localizedString(for: date, relativeTo: now)
    }
}
