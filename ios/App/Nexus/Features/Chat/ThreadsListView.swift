import SwiftUI
import NexusCore

@MainActor
@Observable
final class ThreadsViewModel {
    private let api: APIClient
    let projectId: String
    var state: LoadState<[ChatThread]> = .idle
    var isCreating = false
    /// Threads whose archive is in flight (archive is a slow, model-backed op).
    private(set) var archivingIds: Set<String> = []
    /// Non-nil surfaces an archive/delete failure as an alert.
    var actionError: String?

    init(api: APIClient, projectId: String) {
        self.api = api
        self.projectId = projectId
    }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.projectThreads(projectId: projectId))
        } catch {
            state = .failed(LoadState<[ChatThread]>.message(for: error))
        }
    }

    func createThread() async -> ChatThread? {
        isCreating = true
        defer { isCreating = false }
        let thread = try? await api.createThread(projectId: projectId)
        await refresh()
        return thread
    }

    func isArchiving(_ thread: ChatThread) -> Bool { archivingIds.contains(thread.id) }

    /// Archive (summarize-to-memory, then the backend removes the thread). Keeps
    /// the row in place with a spinner until it completes, since it can take
    /// seconds and can fail (e.g. an empty thread).
    func archive(_ thread: ChatThread) async {
        guard !archivingIds.contains(thread.id) else { return }
        archivingIds.insert(thread.id)
        defer { archivingIds.remove(thread.id) }
        do {
            try await api.archiveThread(threadId: thread.id)
            await refresh()
        } catch {
            actionError = Self.message(for: error, verb: "archive")
        }
    }

    /// Delete optimistically; restore the row if the request fails.
    func delete(_ thread: ChatThread) async {
        let previous = state.value
        if var threads = state.value {
            threads.removeAll { $0.id == thread.id }
            state = .loaded(threads)
        }
        do {
            try await api.deleteThread(threadId: thread.id)
            await refresh()
        } catch {
            if let previous { state = .loaded(previous) }
            actionError = Self.message(for: error, verb: "delete")
        }
    }

    private static func message(for error: Error, verb: String) -> String {
        (error as? APIError)?.errorDescription ?? "Couldn't \(verb) the session."
    }
}

/// Threads for a project. Tapping opens the shared streaming chat.
struct ThreadsListView: View {
    private let api: APIClient
    @Environment(ThreadReadStore.self) private var readStore
    @State private var vm: ThreadsViewModel
    /// Set by the Delete swipe action; drives the confirmation dialog.
    @State private var pendingDelete: ChatThread?

    init(api: APIClient, project: Project) {
        self.api = api
        _vm = State(initialValue: ThreadsViewModel(api: api, projectId: project.id))
    }

    var body: some View {
        content
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await vm.createThread() }
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .disabled(vm.isCreating)
                }
            }
            .task { if vm.state.value == nil { await vm.refresh() } }
            .confirmationDialog(
                "Delete this session?",
                isPresented: deleteDialogBinding,
                presenting: pendingDelete
            ) { thread in
                Button("Delete", role: .destructive) { Task { await vm.delete(thread) } }
                Button("Cancel", role: .cancel) {}
            } message: { thread in
                Text("“\(thread.title)” will be permanently deleted. This can't be undone.")
            }
            .alert("Something went wrong", isPresented: actionErrorBinding, presenting: vm.actionError) { _ in
                Button("OK", role: .cancel) { vm.actionError = nil }
            } message: { message in
                Text(message)
            }
    }

    private var deleteDialogBinding: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var actionErrorBinding: Binding<Bool> {
        Binding(get: { vm.actionError != nil }, set: { if !$0 { vm.actionError = nil } })
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let threads):
            if threads.isEmpty {
                ContentUnavailableView {
                    Label("No chats yet", systemImage: "bubble.left.and.text.bubble.right")
                } description: {
                    Text("Start a thread with the compose button.")
                }
            } else {
                List(threads) { thread in
                    NavigationLink {
                        StreamingChatView(api: api, threadId: thread.id, title: thread.title)
                            .onAppear { readStore.markRead(thread) }
                    } label: {
                        ThreadRow(
                            thread: thread,
                            isUnread: readStore.isUnread(thread),
                            isArchiving: vm.isArchiving(thread))
                    }
                    .disabled(vm.isArchiving(thread))
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            pendingDelete = thread
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        Button {
                            Task { await vm.archive(thread) }
                        } label: {
                            Label("Archive", systemImage: "archivebox")
                        }
                        .tint(.indigo)
                    }
                }
                .refreshable { await vm.refresh() }
                .onAppear { readStore.seed(threads) }
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }
}

struct ThreadRow: View {
    let thread: ChatThread
    var isUnread: Bool = false
    var isArchiving: Bool = false

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(thread.title)
                    .font(.body)
                    .fontWeight(isUnread ? .semibold : .regular)
                    .lineLimit(1)
                if let branch = thread.gitBranch, !branch.isEmpty {
                    Label(branch, systemImage: "arrow.triangle.branch")
                        .font(.caption2).foregroundStyle(.secondary).labelStyle(.titleAndIcon)
                }
            }
            Spacer(minLength: 0)
            if isArchiving {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Archiving…").font(.caption2).foregroundStyle(.secondary)
                }
            } else if isUnread {
                GlassUnreadDot()
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .padding(.vertical, 2)
        .opacity(isArchiving ? 0.6 : 1)
        .animation(.snappy, value: isUnread)
    }
}
