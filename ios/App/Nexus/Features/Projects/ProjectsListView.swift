import SwiftUI
import NexusCore

@MainActor
@Observable
final class ProjectsViewModel {
    private let api: APIClient
    var state: LoadState<[ProjectListItem]> = .idle

    init(api: APIClient) { self.api = api }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            // Projects are the source of truth; the run feed only *decorates*
            // them. If it fails (older/broken backend) we still render the list
            // and fall back to chatSessionCount-only activity.
            async let projectsTask = api.projects()
            let runs = (try? await api.activeChatRuns()) ?? []
            let projects = try await projectsTask
            state = .loaded(ProjectListItem.assemble(projects: projects, runs: runs))
        } catch {
            state = .failed(LoadState<[ProjectListItem]>.message(for: error))
        }
    }
}

struct ProjectsListView: View {
    private let api: APIClient
    @State private var vm: ProjectsViewModel

    init(api: APIClient) {
        self.api = api
        _vm = State(initialValue: ProjectsViewModel(api: api))
    }

    var body: some View {
        content
            .navigationTitle("Projects")
            .navigationDestination(for: Project.self) { project in
                ProjectHubView(api: api, project: project)
            }
            .refreshable { await vm.refresh() }
            .polling(PollingCadence.sessions) { await vm.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let items):
            if items.isEmpty {
                ContentUnavailableView("No projects", systemImage: "folder", description: Text("Create a project on the desktop to see it here."))
            } else {
                List(items) { item in
                    NavigationLink(value: item.project) {
                        ProjectRow(project: item.project, activity: item.activity)
                    }
                }
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }
}

struct ProjectRow: View {
    let project: Project
    var activity: ProjectActivity?

    var body: some View {
        HStack(spacing: 12) {
            Text(project.badge)
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Theme.accent.gradient, in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 2) {
                Text(project.name).font(.body)
                if let count = project.taskCount {
                    Text("\(count) task\(count == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 8)

            if let activity {
                ProjectStatusBadge(activity: activity)
            }
        }
        .padding(.vertical, 2)
    }
}

/// A descriptive status pill on the trailing edge of a project row. Replaces the
/// desktop's tiny corner dot now that the mobile row has room for a word.
/// Attention states (RUN/WAIT) are loud filled pills; IDLE is a calm tint.
/// Colour vocabulary matches the project rail: working = red, waiting = amber,
/// idle = green.
struct ProjectStatusBadge: View {
    let activity: ProjectActivity

    var body: some View {
        Text(Self.label(for: activity))
            .font(.caption2.weight(.bold))
            .tracking(0.5)
            .foregroundStyle(foreground)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(fill, in: Capsule())
            .accessibilityLabel(Self.accessibilityLabel(for: activity))
    }

    private var foreground: Color {
        switch activity {
        case .working: return .white
        case .waiting: return .black.opacity(0.8)
        case .idle: return .green
        }
    }

    private var fill: Color {
        switch activity {
        case .working: return .red
        case .waiting: return .orange
        case .idle: return .green.opacity(0.22)
        }
    }

    /// Short pill copy.
    static func label(for activity: ProjectActivity) -> String {
        switch activity {
        case .working: return "RUN"
        case .waiting: return "WAIT"
        case .idle: return "IDLE"
        }
    }

    /// Spoken description for VoiceOver.
    static func accessibilityLabel(for activity: ProjectActivity) -> String {
        switch activity {
        case .working: return "model working"
        case .waiting: return "waiting for input"
        case .idle: return "idle"
        }
    }
}
