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
                KanbanBoardView(api: api, projectId: project.id)
            case .chat:
                ThreadsListView(api: api, project: project)
            case .memory:
                MemoryView(api: api, projectId: project.id)
            case .missions:
                MissionsView(api: api, projectId: project.id)
            case .monday:
                MondayView(api: api, projectId: project.id)
            case .diff:
                DiffView(api: api, projectId: project.id)
            }
        }
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
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
