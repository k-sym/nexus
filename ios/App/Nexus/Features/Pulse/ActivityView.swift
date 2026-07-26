import SwiftUI
import NexusCore

@MainActor
@Observable
final class ActivityViewModel {
    private let api: APIClient
    var state: LoadState<ActivityResponse> = .idle

    init(api: APIClient) { self.api = api }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.activity())
        } catch {
            state = .failed(LoadState<ActivityResponse>.message(for: error))
        }
    }
}

struct ActivityView: View {
    @State private var vm: ActivityViewModel

    init(api: APIClient) {
        _vm = State(initialValue: ActivityViewModel(api: api))
    }

    var body: some View {
        content
            .refreshable { await vm.refresh() }
            .polling(PollingCadence.activity) { await vm.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let activity):
            if activity.running.isEmpty && activity.recent.isEmpty {
                ContentUnavailableView("Nothing running", systemImage: "moon.zzz")
            } else {
                List {
                    if !activity.running.isEmpty {
                        Section("Running") {
                            ForEach(activity.running) { OperationRow(op: $0, live: true) }
                        }
                    }
                    if !activity.recent.isEmpty {
                        Section("Recent") {
                            ForEach(activity.recent) { OperationRow(op: $0, live: false) }
                        }
                    }
                }
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }
}

struct OperationRow: View {
    let op: ActivityOperation
    let live: Bool

    var body: some View {
        HStack(spacing: 12) {
            if live {
                ProgressView().controlSize(.small)
            } else {
                Circle().fill(op.status.tint).frame(width: 9, height: 9)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(op.title).lineLimit(1)
                HStack(spacing: 6) {
                    Text(op.kind.label)
                    if let event = op.lastEvent, live {
                        Text("· \(event)").lineLimit(1)
                    } else if !live {
                        Text("· \(op.status.rawValue)")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)

            Text(ActivityFormat.duration(op.durationMs))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

extension OperationStatus {
    var tint: Color {
        switch self {
        case .running: return .blue
        case .succeeded: return .green
        case .failed: return .red
        case .cancelled: return .secondary
        case .unknown: return .secondary
        }
    }
}

enum ActivityFormat {
    static func duration(_ ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        let seconds = Double(ms) / 1000
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        let minutes = Int(seconds) / 60
        let rem = Int(seconds) % 60
        return "\(minutes)m \(rem)s"
    }
}
