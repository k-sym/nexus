import SwiftUI
import NexusCore

@MainActor
@Observable
final class MissionsViewModel {
    private let api: APIClient
    let projectId: String
    var state: LoadState<[Mission]> = .idle
    var busyId: String?
    var actionError: String?

    init(api: APIClient, projectId: String) {
        self.api = api
        self.projectId = projectId
    }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.missions(projectId: projectId))
        } catch {
            state = .failed(LoadState<[Mission]>.message(for: error))
        }
    }

    func perform(id: String, action: String) async {
        busyId = id
        defer { busyId = nil }
        do {
            try await api.missionAction(id: id, action: action)
            await refresh()
        } catch {
            actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// Per-project autonomous missions: status + resume/pause/stop.
struct MissionsView: View {
    @State private var vm: MissionsViewModel

    init(api: APIClient, projectId: String) {
        _vm = State(initialValue: MissionsViewModel(api: api, projectId: projectId))
    }

    var body: some View {
        content
            .task { if vm.state.value == nil { await vm.refresh() } }
            .alert("Error", isPresented: Binding(get: { vm.actionError != nil }, set: { if !$0 { vm.actionError = nil } }), presenting: vm.actionError) { _ in
                Button("OK", role: .cancel) {}
            } message: { Text($0) }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let missions):
            if missions.isEmpty {
                ContentUnavailableView("No missions", systemImage: "target", description: Text("Create missions on the desktop."))
            } else {
                List(missions) { mission in
                    MissionRow(mission: mission, busy: vm.busyId == mission.id) { action in
                        Task { await vm.perform(id: mission.id, action: action) }
                    }
                }
                .listStyle(.plain)
                .refreshable { await vm.refresh() }
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }
}

struct MissionRow: View {
    let mission: Mission
    let busy: Bool
    let onAction: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(mission.title).font(.subheadline.weight(.medium)).lineLimit(1)
                Spacer()
                statusBadge
            }
            if !mission.description.isEmpty {
                Text(mission.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Text(metaLine).font(.caption2).foregroundStyle(.secondary)

            if busy {
                ProgressView().controlSize(.small)
            } else {
                HStack(spacing: 12) {
                    switch mission.status {
                    case .active:
                        actionButton("Pause", "pause.fill", "pause")
                        actionButton("Stop", "stop.fill", "stop", role: .destructive)
                    case .paused:
                        actionButton("Resume", "play.fill", "resume")
                        actionButton("Stop", "stop.fill", "stop", role: .destructive)
                    case .stopped, .unknown:
                        actionButton("Resume", "play.fill", "resume")
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 4)
    }

    private func actionButton(_ label: String, _ icon: String, _ action: String, role: ButtonRole? = nil) -> some View {
        Button(role: role) { onAction(action) } label: {
            Label(label, systemImage: icon).font(.caption)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private var statusBadge: some View {
        Text(mission.status.rawValue)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(statusColor.opacity(0.18), in: Capsule())
            .foregroundStyle(statusColor)
    }

    private var statusColor: Color {
        switch mission.status {
        case .active: return .green
        case .paused: return .orange
        case .stopped, .unknown: return .secondary
        }
    }

    private var metaLine: String {
        var parts = [mission.kind.replacingOccurrences(of: "_", with: " ")]
        parts.append("every \(Self.humanInterval(mission.intervalSeconds))")
        parts.append("\(mission.iterationCount) run\(mission.iterationCount == 1 ? "" : "s")")
        if mission.tokensUsed > 0 { parts.append("\(mission.tokensUsed / 1000)k tok") }
        return parts.joined(separator: " · ")
    }

    static func humanInterval(_ seconds: Int) -> String {
        if seconds % 86400 == 0 { return "\(seconds / 86400)d" }
        if seconds % 3600 == 0 { return "\(seconds / 3600)h" }
        if seconds % 60 == 0 { return "\(seconds / 60)m" }
        return "\(seconds)s"
    }
}
