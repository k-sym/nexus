import SwiftUI
import NexusCore

@MainActor
@Observable
final class MondayViewModel {
    private let api: APIClient
    let projectId: String
    var state: LoadState<[MondayItem]> = .idle

    init(api: APIClient, projectId: String) {
        self.api = api
        self.projectId = projectId
    }

    func refresh() async {
        if state.value == nil { state = .loading }
        do { state = .loaded(try await api.mondayItems(projectId: projectId)) }
        catch { state = .failed(LoadState<[MondayItem]>.message(for: error)) }
    }
}

/// Read-only Monday.com items mirrored for this project, with the Nexus roll-up.
struct MondayView: View {
    @State private var vm: MondayViewModel

    init(api: APIClient, projectId: String) {
        _vm = State(initialValue: MondayViewModel(api: api, projectId: projectId))
    }

    var body: some View {
        content
            .task { if vm.state.value == nil { await vm.refresh() } }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let items):
            if items.isEmpty {
                ContentUnavailableView("No Monday items", systemImage: "square.grid.3x3",
                                       description: Text("Link this project to a Monday board on the desktop."))
            } else {
                List(items) { MondayItemRow(item: $0) }.listStyle(.plain).refreshable { await vm.refresh() }
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }
}

struct MondayItemRow: View {
    let item: MondayItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.name).font(.subheadline.weight(.medium)).lineLimit(2)
            HStack(spacing: 8) {
                if let label = item.statusLabel {
                    Text(label).font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background((Color(hex: item.statusColor) ?? .secondary).opacity(0.22), in: Capsule())
                        .foregroundStyle(Color(hex: item.statusColor) ?? .secondary)
                }
                Text(item.boardName + (item.groupTitle.map { " · \($0)" } ?? ""))
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            if let rollup = item.rollup, rollup.total > 0 {
                Text("Tasks — \(rollup.open) open · \(rollup.inProgress) in progress · \(rollup.inReview) review · \(rollup.done) done")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
