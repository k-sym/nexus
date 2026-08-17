import SwiftUI
import NexusCore

/// Per-project hub. A drill-down list of the project's surfaces (Chat, Board,
/// Diff, Memory, Monday), each pushing a full-height destination.
///
/// Replaces the old 6-item segmented control: that packed six destinations into
/// a fixed-width control that couldn't scroll, so labels truncated and tap
/// targets shrank to ~26pt. A list gives every surface a full-width 44pt row, a
/// leading icon, and room for a glanceable stat — and matches the list-based
/// navigation the app already uses for the "More" tab.
struct ProjectHubView: View {
    let api: APIClient
    let project: Project
    @State private var summary: ProjectHubSummary

    init(api: APIClient, project: Project) {
        self.api = api
        self.project = project
        _summary = State(initialValue: ProjectHubSummary(api: api, project: project))
    }

    var body: some View {
        List {
            Section {
                row(.chat) { ThreadsListView(api: api, project: project) }
                row(.board) { KanbanBoardView(api: api, projectId: project.id) }
                row(.diff) { DiffView(api: api, projectId: project.id) }
                row(.memory) { MemoryView(api: api, projectId: project.id) }
                row(.monday) { MondayView(api: api, projectId: project.id) }
            }
        }
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await summary.load() }
        .task { await summary.load() }
    }

    /// One surface row: a full-width `NavigationLink` (List supplies the
    /// disclosure chevron and the ≥44pt tap target) that titles its destination.
    @ViewBuilder
    private func row<Destination: View>(
        _ surface: Surface, @ViewBuilder destination: () -> Destination
    ) -> some View {
        NavigationLink {
            destination()
                .navigationTitle(surface.title)
                .navigationBarTitleDisplayMode(.inline)
        } label: {
            HStack(spacing: 14) {
                Image(systemName: surface.systemImage)
                    .font(.system(size: 18))
                    .foregroundStyle(surface == .chat ? Theme.accent : .secondary)
                    .frame(width: 26)
                Text(surface.title)
                Spacer(minLength: 8)
                stat(for: surface)
            }
            .padding(.vertical, 4)
        }
    }

    /// A glanceable, best-effort summary per surface. Absent until (or unless)
    /// the summary loads, so a slow or unreachable endpoint just shows no stat.
    @ViewBuilder
    private func stat(for surface: Surface) -> some View {
        switch surface {
        case .chat:
            if let count = summary.threadCount {
                Text("\(count) thread\(count == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary)
            }
        case .board:
            if let count = project.taskCount {
                Text("\(count) task\(count == 1 ? "" : "s")")
                    .font(.caption).foregroundStyle(.secondary)
            }
        case .diff:
            if let diff = summary.diff {
                HStack(spacing: 5) {
                    Text("+\(diff.added)").foregroundStyle(.green)
                    Text("−\(diff.deleted)").foregroundStyle(.red)
                }
                .font(.caption.monospacedDigit())
            }
        case .memory:
            if let count = summary.memoryCount {
                Text("\(count)").font(.caption).foregroundStyle(.secondary)
            }
        case .monday:
            EmptyView()
        }
    }
}

// MARK: - Surfaces

private enum Surface: Equatable {
    case chat, board, diff, memory, monday

    var title: String {
        switch self {
        case .chat: return "Chat"
        case .board: return "Board"
        case .diff: return "Diff"
        case .memory: return "Memory"
        case .monday: return "Monday"
        }
    }

    var systemImage: String {
        switch self {
        case .chat: return "bubble.left.and.text.bubble.right.fill"
        case .board: return "rectangle.split.3x1.fill"
        case .diff: return "arrow.triangle.branch"
        case .memory: return "brain.head.profile"
        case .monday: return "calendar"
        }
    }
}

// MARK: - Hub summary

/// Loads the hub's per-surface stats concurrently and best-effort. Each fetch is
/// independent: one failing (older backend, no git, no Monday) leaves the others
/// intact and simply hides that surface's stat.
@MainActor
@Observable
final class ProjectHubSummary {
    struct DiffStat: Equatable { let added: Int; let deleted: Int }

    private let api: APIClient
    private let project: Project

    var threadCount: Int?
    var diff: DiffStat?
    var memoryCount: Int?

    init(api: APIClient, project: Project) {
        self.api = api
        self.project = project
    }

    func load() async {
        let id = project.id
        async let threads = api.projectThreads(projectId: id)
        async let diffState = api.gitDiff(projectId: id)
        async let memories = api.memories(projectId: id)

        threadCount = (try? await threads)?.count
        if case .available(let d)? = try? await diffState, d.hasChanges {
            diff = DiffStat(added: d.summary.added, deleted: d.summary.deleted)
        }
        memoryCount = (try? await memories)?.count
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
