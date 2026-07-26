import SwiftUI
import NexusCore

@MainActor
@Observable
final class DiffViewModel {
    private let api: APIClient
    let projectId: String
    var state: LoadState<GitDiffState> = .idle

    init(api: APIClient, projectId: String) {
        self.api = api
        self.projectId = projectId
    }

    func refresh() async {
        if state.value == nil { state = .loading }
        do { state = .loaded(try await api.gitDiff(projectId: projectId)) }
        catch { state = .failed(LoadState<GitDiffState>.message(for: error)) }
    }
}

/// Read-only git diff for the project's working tree: files with expandable,
/// syntax-colored hunks.
struct DiffView: View {
    @State private var vm: DiffViewModel

    init(api: APIClient, projectId: String) {
        _vm = State(initialValue: DiffViewModel(api: api, projectId: projectId))
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
        case .loaded(.available(let diff)):
            if !diff.hasChanges {
                ContentUnavailableView("No changes", systemImage: "checkmark.circle",
                                       description: Text("The working tree is clean."))
            } else {
                List {
                    Section {
                        Label("\(diff.summary.files) file\(diff.summary.files == 1 ? "" : "s") · +\(diff.summary.added) −\(diff.summary.deleted)",
                              systemImage: "plusminus")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(diff.files) { file in
                        DiffFileView(file: file)
                    }
                }
                .listStyle(.plain)
                .refreshable { await vm.refresh() }
            }
        case .loaded(.unavailable(_, let message)):
            ContentUnavailableView("No diff", systemImage: "xmark.circle", description: Text(message))
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }
}

struct DiffFileView: View {
    let file: GitDiffFile
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ForEach(file.hunks) { hunk in
                VStack(alignment: .leading, spacing: 0) {
                    Text(hunk.header).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        .padding(.top, 4)
                    DiffText(diff: hunk.diff)
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: statusIcon).foregroundStyle(statusColor).font(.caption)
                Text(file.path).font(.callout.monospaced()).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 8)
                Text("+\(file.added)").font(.caption2).foregroundStyle(.green)
                Text("−\(file.deleted)").font(.caption2).foregroundStyle(.red)
            }
        }
    }

    private var statusIcon: String {
        switch file.status {
        case "added": return "plus.circle.fill"
        case "deleted": return "minus.circle.fill"
        case "renamed": return "arrow.triangle.turn.up.right.circle.fill"
        default: return "pencil.circle.fill"
        }
    }

    private var statusColor: Color {
        switch file.status {
        case "added": return .green
        case "deleted": return .red
        case "renamed": return .blue
        default: return .orange
        }
    }
}

/// Renders unified-diff text with per-line +/- coloring.
struct DiffText: View {
    let diff: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(diff.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                Text(line.isEmpty ? " " : String(line))
                    .font(.caption2.monospaced())
                    .foregroundStyle(color(for: line))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(6)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
    }

    private func color(for line: Substring) -> Color {
        if line.hasPrefix("+") { return .green }
        if line.hasPrefix("-") { return .red }
        if line.hasPrefix("@@") { return .secondary }
        return .primary
    }
}
