import SwiftUI
import NexusCore

/// Night-queue board on the Pulse dashboard (baker-internal#111) — the read
/// side of the overnight runner (#55). Read-only by design: the queue is
/// filled by minting a `night-queue` label in daytime discussion, never from
/// a phone.
///
/// The card is opinionated about two things, because auditability is the
/// queue's whole value:
///   * `tests` is what the RUNNER observed, not the coder model's claim about
///     its own homework. A PR row without a green run is an unvalidated draft
///     and is coloured like a warning, so the PR link is never the loudest
///     thing on a row the runner could not prove;
///   * an empty night is calm. Most nights have nothing labelled, and that
///     reads as "quiet", never as a failure.
@MainActor
@Observable
final class NightQueueCardViewModel {
    private let api: APIClient
    var state: LoadState<NightQueueResponse> = .idle

    init(api: APIClient) { self.api = api }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            state = .loaded(try await api.nightQueue())
        } catch {
            state = .failed(LoadState<NightQueueResponse>.message(for: error))
        }
    }
}

struct NightQueueCard: View {
    private let api: APIClient
    @State private var vm: NightQueueCardViewModel
    @State private var selected: Night?

    init(api: APIClient) {
        self.api = api
        _vm = State(initialValue: NightQueueCardViewModel(api: api))
    }

    var body: some View {
        // ZStack, NOT Group: Group applies modifiers to each CHILD, so while
        // the card renders nothing it has zero children and `.polling` (a
        // .task underneath) attaches to nothing and never fires. That is
        // exactly how the #42 drafts card deadlocked closed on every device
        // for weeks. A ZStack is a real container that exists while empty.
        ZStack {
            if shouldRender {
                Card(title: "Night queue", systemImage: "moon.stars") {
                    content
                }
            }
        }
        .polling(PollingCadence.missionControl) { await vm.refresh() }
        .sheet(item: $selected) { night in
            NightDetailSheet(api: api, night: night)
        }
    }

    /// Stay invisible while still loading or unconfigured; everything else —
    /// including "no nights recorded yet" — is worth a line on the dashboard.
    private var shouldRender: Bool {
        switch vm.state {
        case .idle, .loading: return false
        case .failed: return true
        case .loaded(let report): return report.configured != false
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
            if let error = report.error {
                Text("Adapter unreachable — \(error)")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    nights(report)
                    queue(report)
                    awaiting(report)
                }
            }
        }
    }

    @ViewBuilder
    private func nights(_ report: NightQueueResponse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionHeader("Recent nights")
            if report.available == false {
                Text("No nights recorded yet — the runner writes its ledger after its first night.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(report.nights.prefix(3)) { night in
                Button { selected = night } label: { NightRow(night: night) }
                    .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private func queue(_ report: NightQueueResponse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionHeader("Queued for tonight")
            if let error = report.queueError {
                Text((report.queueStale == true
                      ? "Showing the last known queue — "
                      : "Could not read the queue — ") + error)
                    .font(.caption2).foregroundStyle(.orange)
            }
            if report.queue.isEmpty && report.queueError == nil {
                // The deliberate normal state, phrased as such.
                Text("Nothing labelled — the queue is minted in daytime discussion.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(report.queue) { issue in
                QueuedIssueRow(issue: issue)
            }
        }
    }

    @ViewBuilder
    private func awaiting(_ report: NightQueueResponse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionHeader("PRs awaiting you", count: report.openPrs.count)
            if let error = report.openPrsError {
                Text((report.openPrsStale == true
                      ? "Showing the last known list — "
                      : "Could not read open PRs — ") + error)
                    .font(.caption2).foregroundStyle(.orange)
            }
            if report.openPrs.isEmpty && report.openPrsError == nil {
                Text("Nothing open — every night-queue PR is resolved.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(report.openPrs) { pr in
                Link(destination: URL(string: pr.url) ?? URL(string: "https://github.com")!) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(pr.repo)#\(pr.number)").font(.caption.weight(.medium))
                        Text(pr.title).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 4)
                        if let created = pr.createdTs {
                            Text(NightFormat.relative(created))
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct SectionHeader: View {
    let title: String
    var count: Int?

    init(_ title: String, count: Int? = nil) {
        self.title = title
        self.count = count
    }

    var body: some View {
        HStack {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .tracking(0.6)
                .foregroundStyle(.tertiary)
            Spacer()
            if let count, count > 0 {
                Text("\(count)").font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }
}

enum NightFormat {
    static func relative(_ epochSeconds: Int) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(
            for: Date(timeIntervalSince1970: TimeInterval(epochSeconds)), relativeTo: Date())
    }

    static func day(_ night: Night) -> String {
        guard let ts = night.startedTs else { return night.id }
        return Date(timeIntervalSince1970: TimeInterval(ts))
            .formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    static func tokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return "\(Int((Double(n) / 1_000).rounded()))k" }
        return "\(n)"
    }

    static let stopReasons: [String: String] = [
        "drained": "queue drained",
        "window_closed": "window closed",
        "token_budget": "token budget",
        "max_issues": "issue cap",
        "fatal": "fatal error",
    ]
}

struct NightRow: View {
    let night: Night

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            NightOutcomeBadge(outcome: night.outcome)
            VStack(alignment: .leading, spacing: 1) {
                Text(NightFormat.day(night)).font(.callout.weight(.medium))
                Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 1) {
                if night.unvalidated > 0 {
                    Text("\(night.unvalidated) unvalidated")
                        .font(.caption2.weight(.semibold)).foregroundStyle(.orange)
                }
                if night.failures > 0 {
                    Text("\(night.failures) failed")
                        .font(.caption2.weight(.semibold)).foregroundStyle(.red)
                }
            }
            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(NightFormat.day(night)), \(NightOutcomeBadge.accessibilityLabel(for: night.outcome)), \(subtitle)")
    }

    private var subtitle: String {
        // An empty night says so plainly rather than reciting zeroes.
        if night.outcome == .quiet { return "nothing was labelled" }
        var parts = [
            "\(night.issuesAttempted)/\(night.issuesPlanned) attempted",
            "\(night.prsOpened) PR\(night.prsOpened == 1 ? "" : "s")",
            "\(NightFormat.tokens(night.tokensUsed)) tok",
        ]
        if let stop = night.stopReason {
            parts.append(NightFormat.stopReasons[stop] ?? stop)
        }
        return parts.joined(separator: " · ")
    }
}

struct NightOutcomeBadge: View {
    let outcome: NightOutcome

    var body: some View {
        Text(Self.label(for: outcome))
            .font(.caption2.weight(.bold))
            .tracking(0.5)
            .foregroundStyle(foreground)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(fill, in: Capsule())
            .accessibilityLabel(Self.accessibilityLabel(for: outcome))
    }

    private var foreground: Color {
        switch outcome {
        case .worked: .green
        case .running: .blue
        case .quiet, .unknown: .secondary
        }
    }

    private var fill: Color {
        switch outcome {
        case .worked: .green.opacity(0.22)
        case .running: .blue.opacity(0.22)
        case .quiet, .unknown: .gray.opacity(0.25)
        }
    }

    static func label(for outcome: NightOutcome) -> String {
        switch outcome {
        case .worked: "WORKED"
        case .quiet: "QUIET"
        case .running: "RUNNING"
        case .unknown: "?"
        }
    }

    static func accessibilityLabel(for outcome: NightOutcome) -> String {
        switch outcome {
        case .worked: "the runner worked this night"
        case .quiet: "nothing was labelled, a quiet night"
        case .running: "still running"
        case .unknown: "unknown outcome"
        }
    }
}

/// The board's most important pill: what the RUNNER saw when it ran the tests.
struct NightTestsBadge: View {
    let tests: NightTests?

    var body: some View {
        Text(Self.label(for: tests))
            .font(.caption2.weight(tests == .passed ? .regular : .semibold))
            .foregroundStyle(Self.color(for: tests))
            .accessibilityLabel(Self.accessibilityLabel(for: tests))
    }

    static func label(for tests: NightTests?) -> String {
        switch tests {
        case .passed: "tests passed"
        case .failed: "TESTS FAILED"
        case .notRun: "TESTS NOT RUN"
        // The ledger row predates the column. Unknown is not a verdict, and
        // borrowing either one would put a claim in the runner's mouth.
        case .unknown, .none: "tests unknown"
        }
    }

    static func color(for tests: NightTests?) -> Color {
        switch tests {
        case .passed: .green
        case .failed: .red
        case .notRun: .orange
        case .unknown, .none: .secondary
        }
    }

    static func accessibilityLabel(for tests: NightTests?) -> String {
        switch tests {
        case .passed: "the runner's tests passed"
        case .failed: "the runner's tests failed — unvalidated"
        case .notRun: "the runner ran no tests — unvalidated"
        case .unknown, .none: "no test result recorded for this run"
        }
    }
}

struct QueuedIssueRow: View {
    let issue: QueuedIssue

    var body: some View {
        Link(destination: URL(string: issue.url) ?? URL(string: "https://github.com")!) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(issue.repo)#\(issue.number)").font(.caption.weight(.medium))
                    Text(issue.title).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 4)
                    if let updated = issue.updatedTs {
                        Text(NightFormat.relative(updated))
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                if issue.excluded {
                    // Standing policy (#55): a label here does nothing, so say
                    // so rather than letting the row look like tonight's work.
                    Text("excluded by policy — the runner never touches its own runtime or this app")
                        .font(.caption2).foregroundStyle(.orange)
                } else if let readiness = issue.readiness {
                    Text(readiness).font(.caption2).foregroundStyle(.tertiary).lineLimit(2)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

/// Detail sheet: every run of one night, plus what the planner decided.
struct NightDetailSheet: View {
    let api: APIClient
    let night: Night
    @State private var state: LoadState<Night> = .idle
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        NightOutcomeBadge(outcome: night.outcome)
                        Spacer()
                        Text(NightFormat.day(night)).font(.callout).foregroundStyle(.secondary)
                    }
                    row("Attempted", "\(night.issuesAttempted) of \(night.issuesPlanned) planned")
                    row("PRs opened", "\(night.prsOpened)")
                    if night.unvalidated > 0 {
                        row("Unvalidated PRs", "\(night.unvalidated)", tint: .orange)
                    }
                    if night.failures > 0 {
                        row("Failed or timed out", "\(night.failures)", tint: .red)
                    }
                    row("Tokens", NightFormat.tokens(night.tokensUsed))
                    if let stop = night.stopReason {
                        row("Stopped", NightFormat.stopReasons[stop] ?? stop)
                    }
                } header: {
                    Text(night.id)
                }

                Section("Issues") {
                    if night.runs.isEmpty {
                        Text("No issues were attempted — the queue was empty.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(night.runs) { run in
                        NightRunDetail(run: run)
                    }
                }

                if let plan = state.value?.plan, !plan.parked.isEmpty || !plan.excluded.isEmpty {
                    Section("Not worked") {
                        ForEach(plan.parked) { parked in
                            VStack(alignment: .leading, spacing: 1) {
                                Text("parked \(parked.repo ?? "?")#\(parked.number ?? 0)")
                                    .font(.caption.weight(.medium))
                                if let reason = parked.reason {
                                    Text(reason).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                        }
                        ForEach(plan.excluded) { excluded in
                            Text("excluded by policy: \(excluded.repo ?? "?")#\(excluded.number ?? 0)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Night")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                state = .loading
                do {
                    state = .loaded(try await api.night(id: night.id))
                } catch {
                    state = .failed(LoadState<Night>.message(for: error))
                }
            }
        }
    }

    private func row(_ label: String, _ value: String, tint: Color? = nil) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).foregroundStyle(tint ?? .primary)
        }
        .font(.callout)
    }
}

struct NightRunDetail: View {
    let run: NightRun

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(run.repo)#\(run.issueNumber)").font(.callout.weight(.medium))
                Text(run.status ?? "unknown").font(.caption2).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Text("\(NightFormat.tokens(run.tokensUsed)) tok")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            HStack(spacing: 8) {
                // Beside the PR link, never below it: a PR the runner could
                // not validate must not look finished.
                if run.status == "pr_opened" {
                    NightTestsBadge(tests: run.tests)
                }
                if let verdict = run.verdict {
                    Text(verdict.replacingOccurrences(of: "_", with: " "))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if run.rounds > 0 {
                    Text("\(run.rounds) round\(run.rounds == 1 ? "" : "s")")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            if let prUrl = run.prUrl, let url = URL(string: prUrl) {
                Link("Open PR", destination: url).font(.caption)
            }
            if let error = run.error {
                Text(error).font(.caption2).foregroundStyle(.red)
            }
            if !run.summary.isEmpty {
                Text(run.summary).font(.caption2).foregroundStyle(.secondary).lineLimit(4)
            }
        }
        .padding(.vertical, 2)
    }
}
