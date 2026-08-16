import SwiftUI
import NexusCore

/// Routine fleet card on the Pulse dashboard (baker-internal#82). Read-only by
/// design — no start/stop in v1. Health colours reuse the projects-list
/// activity vocabulary (green/amber/red pill; see ProjectStatusBadge); tap a
/// row for recent status + log tail. Self-polls independently of the
/// MissionControl payload.
@MainActor
@Observable
final class RoutinesCardViewModel {
    private let api: APIClient
    var state: LoadState<RoutinesResponse> = .idle

    init(api: APIClient) { self.api = api }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.routines())
        } catch {
            state = .failed(LoadState<RoutinesResponse>.message(for: error))
        }
    }
}

struct RoutinesCard: View {
    private let api: APIClient
    @State private var vm: RoutinesCardViewModel
    @State private var selected: Routine?

    init(api: APIClient) {
        self.api = api
        _vm = State(initialValue: RoutinesCardViewModel(api: api))
    }

    var body: some View {
        Card(title: "Routines", systemImage: "clock.arrow.circlepath") {
            content
        }
        .polling(PollingCadence.missionControl) { await vm.refresh() }
        .sheet(item: $selected) { routine in
            RoutineDetailSheet(api: api, routine: routine)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity)
        case .failed(let message):
            Text(message).font(.caption).foregroundStyle(.red)
        case .loaded(let report):
            if report.configured == false {
                Text("Configure the assistant URL and key in Settings to see routines.")
                    .font(.caption).foregroundStyle(.secondary)
            } else if let error = report.error {
                Text("Adapter unreachable — \(error)")
                    .font(.caption).foregroundStyle(.secondary)
            } else if report.routines.isEmpty {
                Text("No scheduled routines found.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(report.routines) { routine in
                    Button {
                        selected = routine
                    } label: {
                        RoutineRow(routine: routine)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

struct RoutineRow: View {
    let routine: Routine

    var body: some View {
        HStack(spacing: 10) {
            RoutineHealthBadge(health: routine.health)
            VStack(alignment: .leading, spacing: 1) {
                Text(routine.name).font(.callout.weight(.medium))
                Text(subtitle).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(routine.name), \(RoutineHealthBadge.accessibilityLabel(for: routine.health)), \(subtitle)")
    }

    private var subtitle: String {
        var parts: [String] = []
        if let anchor = routine.lastRun?.ended ?? routine.lastRun?.started {
            parts.append("ran \(Self.relative(anchor))")
        } else {
            parts.append("never run")
        }
        if let due = routine.nextDue {
            parts.append("next \(Self.dueLabel(due))")
        }
        return parts.joined(separator: " · ")
    }

    static func relative(_ epochSeconds: Int) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(
            for: Date(timeIntervalSince1970: TimeInterval(epochSeconds)), relativeTo: Date())
    }

    static func dueLabel(_ epochSeconds: Int) -> String {
        let due = Date(timeIntervalSince1970: TimeInterval(epochSeconds))
        if Calendar.current.isDateInToday(due) {
            return due.formatted(date: .omitted, time: .shortened)
        }
        if Calendar.current.isDateInTomorrow(due) {
            return "tomorrow \(due.formatted(date: .omitted, time: .shortened))"
        }
        return due.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }
}

/// Capsule health pill mirroring ProjectStatusBadge's vocabulary: green = ok,
/// amber = stale (missed its slot), red = failed, grey = pending/unknown.
struct RoutineHealthBadge: View {
    let health: RoutineHealth

    var body: some View {
        Text(Self.label(for: health))
            .font(.caption2.weight(.bold))
            .tracking(0.5)
            .foregroundStyle(foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(fill, in: Capsule())
            .accessibilityLabel(Self.accessibilityLabel(for: health))
    }

    private var foreground: Color {
        switch health {
        case .ok: .green
        case .stale: .black.opacity(0.8)
        case .failed: .white
        case .pending, .unknown: .secondary
        }
    }

    private var fill: Color {
        switch health {
        case .ok: .green.opacity(0.22)
        case .stale: .orange
        case .failed: .red
        case .pending, .unknown: .gray.opacity(0.25)
        }
    }

    static func label(for health: RoutineHealth) -> String {
        switch health {
        case .ok: "OK"
        case .stale: "STALE"
        case .failed: "FAIL"
        case .pending: "PEND"
        case .unknown: "?"
        }
    }

    static func accessibilityLabel(for health: RoutineHealth) -> String {
        switch health {
        case .ok: "last run succeeded"
        case .stale: "missed its scheduled slot"
        case .failed: "last run failed"
        case .pending: "not run yet"
        case .unknown: "unknown health"
        }
    }
}

/// Detail sheet: schedule, last-run facts, and the recent log tail fetched
/// from `/api/routines/{name}`.
struct RoutineDetailSheet: View {
    let api: APIClient
    let routine: Routine
    @State private var state: LoadState<Routine> = .idle
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        RoutineHealthBadge(health: routine.health)
                        Spacer()
                        Text(routine.scheduleDisplay).font(.callout).foregroundStyle(.secondary)
                    }
                    if let last = routine.lastRun {
                        if let anchor = last.ended ?? last.started {
                            row("Last run", RoutineRow.relative(anchor))
                        }
                        if let rc = last.rc {
                            row("Exit code", "\(rc)\(last.timedOut == true ? " (timed out)" : "")")
                        }
                        if last.source == "stamp" {
                            row("Source", "legacy stamp")
                        }
                    } else {
                        row("Last run", "never")
                    }
                    if let due = routine.nextDue {
                        row("Next due", RoutineRow.dueLabel(due))
                    }
                } header: {
                    Text(routine.label)
                }

                Section("Recent log") {
                    switch state {
                    case .idle, .loading:
                        ProgressView().frame(maxWidth: .infinity)
                    case .failed(let message):
                        Text(message).font(.caption).foregroundStyle(.red)
                    case .loaded(let detail):
                        if let tail = detail.logTail, !tail.isEmpty {
                            ScrollView(.horizontal) {
                                Text(tail.joined(separator: "\n"))
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        } else {
                            Text("No log output.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle(routine.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                state = .loading
                do {
                    state = .loaded(try await api.routineDetail(name: routine.name))
                } catch {
                    state = .failed(LoadState<Routine>.message(for: error))
                }
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value)
        }
        .font(.callout)
    }
}
