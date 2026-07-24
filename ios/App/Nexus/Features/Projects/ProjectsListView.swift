import SwiftUI
import NexusCore

@MainActor
@Observable
final class ProjectsViewModel {
    private let api: APIClient
    var state: LoadState<[Project]> = .idle

    init(api: APIClient) { self.api = api }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.projects())
        } catch {
            state = .failed(LoadState<[Project]>.message(for: error))
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
            .polling(PollingCadence.projects) { await vm.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let projects):
            if projects.isEmpty {
                ContentUnavailableView("No projects", systemImage: "folder", description: Text("Create a project on the desktop to see it here."))
            } else {
                List(projects) { project in
                    NavigationLink(value: project) {
                        ProjectRow(project: project)
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
        }
        .padding(.vertical, 2)
    }
}
