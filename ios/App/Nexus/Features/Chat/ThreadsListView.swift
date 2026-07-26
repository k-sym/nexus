import SwiftUI
import NexusCore

@MainActor
@Observable
final class ThreadsViewModel {
    private let api: APIClient
    let projectId: String
    var state: LoadState<[ChatThread]> = .idle
    var isCreating = false

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
}

/// Threads for a project. Tapping opens the shared streaming chat.
struct ThreadsListView: View {
    private let api: APIClient
    @State private var vm: ThreadsViewModel

    init(api: APIClient, project: Project) {
        self.api = api
        _vm = State(initialValue: ThreadsViewModel(api: api, projectId: project.id))
    }

    var body: some View {
        content
            .navigationDestination(for: ChatThread.self) { thread in
                StreamingChatView(api: api, threadId: thread.id, title: thread.title)
            }
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
                    NavigationLink(value: thread) { ThreadRow(thread: thread) }
                }
                .refreshable { await vm.refresh() }
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }
}

struct ThreadRow: View {
    let thread: ChatThread
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(thread.title).font(.body).lineLimit(1)
            if let branch = thread.gitBranch, !branch.isEmpty {
                Label(branch, systemImage: "arrow.triangle.branch")
                    .font(.caption2).foregroundStyle(.secondary).labelStyle(.titleAndIcon)
            }
        }
        .padding(.vertical, 2)
    }
}
