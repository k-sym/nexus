import SwiftUI
import NexusCore

/// Per-project hub: a segmented picker over the project's sub-views. In M1 only
/// Board (a read-only task list) has real content; Chat/Memory/Missions/Monday/
/// Diff arrive in M2–M4.
struct ProjectHubView: View {
    let api: APIClient
    let project: Project

    enum Sub: String, CaseIterable, Identifiable {
        case chat = "Chat"
        case board = "Board"
        case memory = "Memory"
        case missions = "Missions"
        case monday = "Monday"
        case diff = "Diff"
        var id: String { rawValue }
    }

    @State private var sub: Sub = .board

    var body: some View {
        VStack(spacing: 0) {
            Picker("View", selection: $sub) {
                ForEach(Sub.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding([.horizontal, .top])
            .padding(.bottom, 8)

            Divider()

            switch sub {
            case .board:
                ProjectTasksView(api: api, project: project)
            case .chat:
                ThreadsListView(api: api, project: project)
            case .memory:
                PlaceholderView(title: "Memory", systemImage: "brain", note: "Memory CRUD lands in M3.")
            case .missions:
                PlaceholderView(title: "Missions", systemImage: "target", note: "Missions land in M3.")
            case .monday:
                PlaceholderView(title: "Monday", systemImage: "square.grid.3x3.fill", note: "Monday items land in M4.")
            case .diff:
                PlaceholderView(title: "Diff", systemImage: "plusminus", note: "Git diff lands in M4.")
            }
        }
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Board (read-only tasks)

@MainActor
@Observable
final class ProjectTasksViewModel {
    private let api: APIClient
    let projectId: String
    var state: LoadState<[ProjectTask]> = .idle

    init(api: APIClient, projectId: String) {
        self.api = api
        self.projectId = projectId
    }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.tasks(projectId: projectId))
        } catch {
            state = .failed(LoadState<[ProjectTask]>.message(for: error))
        }
    }
}

struct ProjectTasksView: View {
    @State private var vm: ProjectTasksViewModel

    init(api: APIClient, project: Project) {
        _vm = State(initialValue: ProjectTasksViewModel(api: api, projectId: project.id))
    }

    var body: some View {
        content
            .refreshable { await vm.refresh() }
            .polling(PollingCadence.tasks) { await vm.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let tasks):
            if tasks.isEmpty {
                ContentUnavailableView("No tasks", systemImage: "checklist")
            } else {
                List {
                    ForEach(TaskStatus.allCases, id: \.rawValue) { status in
                        let inColumn = tasks.filter { $0.status == status }
                        if !inColumn.isEmpty {
                            Section("\(status.label) (\(inColumn.count))") {
                                ForEach(inColumn) { TaskRow(task: $0) }
                            }
                        }
                    }
                }
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }
}

struct TaskRow: View {
    let task: ProjectTask

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(task.priority.tint)
                .frame(width: 8, height: 8)
            Text(task.title)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Display helpers (app-side, over NexusCore enums)

extension TaskStatus {
    var label: String {
        switch self {
        case .triage: return "Triage"
        case .todo: return "To do"
        case .inProgress: return "In progress"
        case .review: return "Review"
        case .deploy: return "Deploy"
        case .unknown(let raw): return raw.capitalized
        }
    }
}

extension TaskPriority {
    var tint: Color {
        switch self {
        case .urgent: return .red
        case .high: return .orange
        case .medium: return .yellow
        case .low: return .secondary
        case .unknown: return .secondary
        }
    }
}
