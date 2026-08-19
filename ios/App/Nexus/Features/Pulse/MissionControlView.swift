import SwiftUI
import NexusCore

@MainActor
@Observable
final class MissionControlViewModel {
    private let api: APIClient
    var state: LoadState<MissionStatus> = .idle

    init(api: APIClient) { self.api = api }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.missionControl())
        } catch {
            state = .failed(LoadState<MissionStatus>.message(for: error))
        }
    }
}

struct MissionControlView: View {
    private let api: APIClient
    @State private var vm: MissionControlViewModel

    init(api: APIClient) {
        self.api = api
        _vm = State(initialValue: MissionControlViewModel(api: api))
    }

    var body: some View {
        content
            .refreshable { await vm.refresh() }
            .polling(PollingCadence.missionControl) { await vm.refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let status):
            ScrollView {
                VStack(spacing: 16) {
                    memoryCard(status.memory)
                    // Above the fleet card: a draft waiting on a tap is more
                    // urgent than routine health, and it hides itself when the
                    // queue is empty (baker-internal#42).
                    DraftsCard(api: api)
                    RoutinesCard(api: api)
                    if let counts = status.modelCounts {
                        modelsCard(counts)
                    }
                    if let stats = status.stats, !stats.isEmpty {
                        usageCard(stats)
                    }
                }
                .padding()
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }

    private func memoryCard(_ memory: MissionStatus.Memory) -> some View {
        Card(title: "Memory daemon", systemImage: "brain") {
            HStack {
                StatusPill(text: memory.ok ? (memory.status ?? "ok") : "down",
                           systemImage: memory.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                    .foregroundStyle(memory.ok ? .green : .red)
                Spacer()
                if let memories = memory.memories {
                    Text("\(memories) memories").font(.callout).foregroundStyle(.secondary)
                }
            }
            if let jobs = memory.jobs {
                Text("Jobs — \(jobs.pending) pending, \(jobs.dead) dead")
                    .font(.caption)
                    .foregroundStyle(jobs.dead > 0 ? .orange : .secondary)
            }
            if let models = memory.models {
                HStack(spacing: 12) {
                    modelFlag("gen", models.gen)
                    modelFlag("embed", models.embed)
                    modelFlag("rerank", models.rerank)
                }
                .font(.caption)
            }
            if let error = memory.error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private func modelFlag(_ label: String, _ up: Bool) -> some View {
        Label(label, systemImage: up ? "circle.fill" : "circle")
            .foregroundStyle(up ? .green : .secondary)
            .labelStyle(.titleAndIcon)
    }

    private func modelsCard(_ counts: MissionStatus.ModelCounts) -> some View {
        Card(title: "Models", systemImage: "cpu") {
            HStack(spacing: 24) {
                metric("\(counts.active)", "active")
                metric("\(counts.available)", "available")
            }
        }
    }

    private func metric(_ value: String, _ caption: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title2.weight(.semibold))
            Text(caption).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func usageCard(_ stats: [String: MissionStatus.ProviderStat]) -> some View {
        Card(title: "Usage", systemImage: "gauge.with.dots.needle.67percent") {
            ForEach(stats.keys.sorted(), id: \.self) { key in
                if let stat = stats[key] {
                    HStack {
                        Text(key.capitalized).font(.callout.weight(.medium))
                        Spacer()
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(stat.value)
                                .font(.callout.weight(.semibold))
                                .foregroundStyle(stat.ok ? .primary : .secondary)
                            Text(stat.error ?? stat.caption)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }
}
