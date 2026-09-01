import SwiftUI
import NexusCore

/// The night queue's front door on iOS (baker-internal#111), reached from the
/// night-queue card. Desktop shipped this on 2026-09-01; this is the same
/// surface, and it acts, so it is built like the drafts sheet beside it:
///
///   * blocked candidates are SHOWN, greyed, with their reason. A list that
///     omits an issue teaches you it does not exist; "PR #212 already
///     implements this" teaches you where the work went;
///   * the count is `unblocked`, never "armable" — nothing in the list has been
///     judged against the bar until you open it, because the bar costs a model
///     call per issue;
///   * the criteria come from the adapter. `night-queue/readiness.py` is the
///     single definition the 01:00 planner composes its prompt from, and a
///     Swift copy would drift from the thing that actually decides the night;
///   * Arm lives inside the issue view, after the assessment has loaded, behind
///     a destructive confirmation — approving a preview is not consent, and a
///     stray tap on a phone must not hand an issue to an unattended agent for a
///     whole night.
///
/// Every refusal the Arm control mirrors is computed by `ArmGate` in NexusCore,
/// where it is tested. The adapter enforces all of them again regardless.

// MARK: - Candidate list

@MainActor
@Observable
final class NightQueueWorkshopModel {
    private let api: APIClient
    var state: LoadState<NightQueueCandidatesResponse> = .idle
    /// Loaded alongside the candidates and passed down. A missing bar is not
    /// fatal — assessment still works — so it never blocks the list.
    var readiness: ReadinessResponse?

    init(api: APIClient) { self.api = api }

    func load() async {
        if state.value == nil { state = .loading }
        async let candidates = api.nightQueueCandidates()
        async let bar = api.nightQueueReadiness()
        do {
            let (list, criteria) = try await (candidates, bar)
            state = .loaded(list)
            readiness = criteria
        } catch {
            state = .failed(LoadState<NightQueueCandidatesResponse>.message(for: error))
        }
    }
}

struct NightQueueWorkshopSheet: View {
    private let api: APIClient
    private let onArmed: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var model: NightQueueWorkshopModel

    init(api: APIClient, onArmed: @escaping () -> Void) {
        self.api = api
        self.onArmed = onArmed
        _model = State(initialValue: NightQueueWorkshopModel(api: api))
    }

    var body: some View {
        NavigationStack {
            List {
                switch model.state {
                case .idle, .loading:
                    ProgressView().frame(maxWidth: .infinity)
                case .failed(let message):
                    Text(message).font(.caption).foregroundStyle(.red)
                case .loaded(let report):
                    content(report)
                }
            }
            .navigationTitle("Night queue")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: NightQueueCandidate.self) { candidate in
                WorkshopIssueView(api: api, candidate: candidate,
                                  readiness: model.readiness) {
                    onArmed()
                    Task { await model.load() }
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .refreshable { await model.load() }
            .task { await model.load() }
        }
    }

    @ViewBuilder
    private func content(_ report: NightQueueCandidatesResponse) -> some View {
        if report.configured == false {
            Text("Set the assistant URL and key in Settings to use the workshop.")
                .font(.caption).foregroundStyle(.secondary)
        }
        if let error = report.error {
            Label((report.stale == true ? "Showing the last known list — " : "") + error,
                  systemImage: "exclamationmark.triangle")
                .font(.caption).foregroundStyle(.orange)
        }

        Section {
            ForEach(report.candidates) { candidate in
                NavigationLink(value: candidate) {
                    CandidateRow(candidate: candidate)
                }
                // Blocked issues stay tappable: the detail explains the block,
                // and reading why is the point of showing them at all.
                .opacity(candidate.blocked == nil ? 1 : 0.55)
            }
            if report.candidates.isEmpty && report.error == nil && report.configured != false {
                Text("No open issues found.").font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            // "unblocked", never "armable" — nothing here has been judged yet.
            Text("\(report.unblocked ?? 0) unblocked · \(report.candidates.count) open")
        } footer: {
            Text("Nothing is written until you arm an issue. Open one to judge it "
                 + "against the bar the 01:00 planner enforces.")
        }
    }
}

struct CandidateRow: View {
    let candidate: NightQueueCandidate

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text("\(candidate.repo)#\(candidate.number)")
                    .font(.caption.weight(.medium))
                if let blocked = candidate.blocked {
                    BlockedChip(reason: blocked)
                }
                Spacer(minLength: 4)
                if let updated = candidate.updatedTs {
                    Text(NightFormat.relative(updated))
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            Text(candidate.title).font(.subheadline).lineLimit(2)
            if let detail = blockDetail {
                Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(candidate.repo) issue \(candidate.number), \(candidate.title)"
                            + (blockDetail.map { ". \($0)" } ?? ""))
    }

    private var blockDetail: String? {
        switch candidate.blocked {
        case .openPr:
            guard let pr = candidate.openPr else { return "A PR already implements this" }
            return "PR #\(pr.number) already implements this"
        case .excluded: return "Never runs unattended by standing policy"
        case .queued: return "Already labelled — in tonight's queue"
        case .unknown, .none: return nil
        }
    }
}

struct BlockedChip: View {
    let reason: BlockedReason

    var body: some View {
        Text(label.uppercased())
            .font(.caption2.weight(.semibold))
            .tracking(0.4)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(.tertiary.opacity(0.25), in: Capsule())
            .foregroundStyle(.secondary)
    }

    private var label: String {
        switch reason {
        case .excluded: return "policy"
        case .queued: return "queued"
        case .openPr: return "PR open"
        case .unknown: return "blocked"
        }
    }
}

// MARK: - One issue, judged

@MainActor
@Observable
final class WorkshopIssueModel {
    enum Busy: Equatable { case assessing, arming }

    private let api: APIClient
    private(set) var candidate: NightQueueCandidate
    var assessment: AssessmentResponse?
    /// The text that will be posted. Editable: unlike a draft email (#97) there
    /// is no server-side copy to go stale — what is arming is exactly what is
    /// on screen — so a read/edit split would guard nothing here.
    var draft: String = ""
    var busy: Busy?
    var error: String?
    var armed: ArmResponse?

    init(api: APIClient, candidate: NightQueueCandidate) {
        self.api = api
        self.candidate = candidate
    }

    /// A new issue must never inherit the previous one's verdict, draft — or
    /// `busy`. Desktop bug #3: a busy flag that survived a selection change
    /// wedged the next panel on a disabled "Assessing…" forever.
    func bind(to next: NightQueueCandidate) {
        guard next.id != candidate.id else { return }
        candidate = next
        assessment = nil
        draft = ""
        error = nil
        armed = nil
        busy = nil
    }

    var refusal: ArmGate.Refusal? {
        ArmGate.evaluate(candidate: candidate, assessment: assessment,
                         draft: draft, armed: armed != nil)
    }

    func assess() async {
        // An assessment takes tens of seconds. Capture which issue asked, and
        // compare on resume: a verdict the reader has moved on from must be
        // dropped, not shown under the new heading.
        let requestedFor = candidate.id
        busy = .assessing
        error = nil
        do {
            let got = try await api.assessIssue(repo: candidate.repo, number: candidate.number)
            guard candidate.id == requestedFor else { return }
            // Belt and braces: never display a verdict that is not demonstrably
            // about the issue on screen, whatever the adapter answered.
            guard got.describes(candidate) else {
                error = "The adapter answered about \(got.repo)#\(got.number) — assess again."
                busy = nil
                return
            }
            assessment = got
            draft = got.draftComment
        } catch {
            guard candidate.id == requestedFor else { return }
            self.error = LoadState<AssessmentResponse>.message(for: error)
        }
        if candidate.id == requestedFor { busy = nil }
    }

    func arm() async {
        // The gate is re-read here rather than trusted from the button: the
        // draft can change between the tap and the confirmation.
        guard refusal == nil else {
            error = refusal?.reason
            return
        }
        busy = .arming
        error = nil
        do {
            armed = try await api.armIssue(repo: candidate.repo, number: candidate.number,
                                           comment: draft)
        } catch {
            // Stays on screen, verbatim, and never reads as success. The
            // adapter's own wording carries the states that matter: standing
            // policy (403), closed or already queued (409), a spec it refused
            // (400), and the half-done one — the comment was posted but the
            // label was not, so the issue is NOT queued.
            self.error = LoadState<ArmResponse>.message(for: error)
        }
        busy = nil
    }
}

struct WorkshopIssueView: View {
    private let api: APIClient
    private let candidate: NightQueueCandidate
    private let readiness: ReadinessResponse?
    private let onArmed: () -> Void

    @State private var model: WorkshopIssueModel
    @State private var confirmingArm = false

    init(api: APIClient, candidate: NightQueueCandidate,
         readiness: ReadinessResponse?, onArmed: @escaping () -> Void) {
        self.api = api
        self.candidate = candidate
        self.readiness = readiness
        self.onArmed = onArmed
        _model = State(initialValue: WorkshopIssueModel(api: api, candidate: candidate))
    }

    var body: some View {
        Form {
            issueSection
            if let blocked = candidate.blocked {
                blockedSection(blocked)
            }
            if model.assessment == nil {
                barSection
            } else {
                verdictSection
                draftSection
            }
            if let error = model.error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.red)
                }
            }
            if let armed = model.armed {
                armedSection(armed)
            } else if model.assessment != nil {
                armSection
            }
        }
        .navigationTitle("\(candidate.repo)#\(candidate.number)")
        .navigationBarTitleDisplayMode(.inline)
        // Defence in depth: a pushed destination normally gets fresh state, but
        // if SwiftUI ever recycles this view the model must be re-bound rather
        // than keep the previous issue's verdict.
        .onChange(of: candidate.id, initial: true) { model.bind(to: candidate) }
        .confirmationDialog(
            "Arm \(candidate.repo)#\(candidate.number) for tonight's 01:00 run?",
            isPresented: $confirmingArm,
            titleVisibility: .visible
        ) {
            Button("Post comment and arm", role: .destructive) {
                Task { await model.arm() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This posts the readiness comment publicly on the issue and mints "
                 + "the night-queue label. An unattended agent works it tonight.")
        }
    }

    // MARK: Sections

    @ViewBuilder
    private var issueSection: some View {
        Section {
            Text(candidate.title).font(.callout)
            if let url = URL(string: candidate.url) {
                Link("Open on GitHub", destination: url).font(.caption)
            }
        }
    }

    @ViewBuilder
    private func blockedSection(_ blocked: BlockedReason) -> some View {
        Section {
            switch blocked {
            case .openPr:
                VStack(alignment: .leading, spacing: 4) {
                    Label("A PR already implements this", systemImage: "arrow.triangle.pull")
                        .font(.caption.weight(.semibold)).foregroundStyle(.orange)
                    if let pr = candidate.openPr {
                        Text("PR #\(pr.number) (\(pr.reason.rawValue.replacingOccurrences(of: "_", with: " "))) "
                             + "is awaiting review. Arming would duplicate it.")
                            .font(.caption2).foregroundStyle(.secondary)
                        if let url = URL(string: pr.url) {
                            Link("See PR #\(pr.number)", destination: url).font(.caption2)
                        }
                    }
                }
            case .excluded:
                Label("This repo never runs unattended by standing policy — the agent "
                      + "does not modify its own runtime or the surface it reports "
                      + "through. Work it in a daytime session.",
                      systemImage: "hand.raised")
                    .font(.caption).foregroundStyle(.secondary)
            case .queued:
                Label("Already labelled — this is in tonight's queue.",
                      systemImage: "checkmark.circle")
                    .font(.caption).foregroundStyle(.green)
            case .unknown:
                Label("Blocked by the adapter for a reason this build does not "
                      + "recognise. Use the desktop workshop.",
                      systemImage: "questionmark.circle")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
    }

    @ViewBuilder
    private var barSection: some View {
        Section {
            // Served by the adapter, never hand-copied: this is the same
            // definition the 01:00 planner composes its prompt from.
            ForEach(readiness?.criteria ?? []) { criterion in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(criterion.label).font(.caption.weight(.semibold))
                        if let conditional = criterion.conditional {
                            Text("· \(conditional)").font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                    Text(criterion.requirement).font(.caption2).foregroundStyle(.secondary)
                }
                .padding(.vertical, 1)
            }
            if readiness?.criteria.isEmpty != false {
                Text("Could not read the bar from the adapter — assessment still applies it.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        } header: {
            Text("What the 01:00 planner will require")
        }

        Section {
            Button {
                Task { await model.assess() }
            } label: {
                Label(model.busy == .assessing ? "Assessing…" : "Assess against the bar",
                      systemImage: "checklist")
            }
            .disabled(model.busy != nil)
        } footer: {
            Text("A model call against the same bar the planner enforces. Nothing is written.")
        }
    }

    @ViewBuilder
    private var verdictSection: some View {
        if let assessment = model.assessment {
            Section {
                Label {
                    Text(assessment.ready ? "Meets the bar" : "Below the bar")
                        .font(.caption.weight(.semibold))
                } icon: {
                    Image(systemName: assessment.ready ? "checkmark.seal" : "exclamationmark.triangle")
                }
                .foregroundStyle(assessment.ready ? .green : .orange)

                if !assessment.summary.isEmpty {
                    Text(assessment.summary).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(assessment.criteria) { criterion in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(statusLabel(criterion.status))
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(statusColour(criterion.status))
                            Text(criterion.label).font(.caption.weight(.medium))
                        }
                        Text(criterion.note).font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 1)
                }
            } header: {
                Text("Verdict")
            } footer: {
                if !assessment.assessed {
                    Text("Decided without a model call — this repo is excluded by standing policy.")
                }
            }
        }
    }

    @ViewBuilder
    private var draftSection: some View {
        Section {
            TextEditor(text: $model.draft)
                .font(.caption.monospaced())
                .frame(minHeight: 200)
                .accessibilityLabel("Readiness comment")
            if model.draft.contains(ArmGate.unresolvedMarker) {
                Text("This draft still contains a <TODO: …>. Decide it before arming — "
                     + "an unattended agent reading a TODO will either guess or park.")
                    .font(.caption2).foregroundStyle(.orange)
            }
        } header: {
            Text("Readiness comment — posted to the issue when you arm")
        } footer: {
            Text("This exact text becomes tonight's brief. Editing it here is the point: "
                 + "the assessor marks gaps rather than deciding them for you.")
        }
    }

    @ViewBuilder
    private var armSection: some View {
        Section {
            Button {
                confirmingArm = true
            } label: {
                Label(model.busy == .arming ? "Arming…" : "Post comment and arm for tonight",
                      systemImage: "moon.stars.fill")
            }
            .disabled(model.refusal != nil || model.busy != nil)
        } footer: {
            // A disabled control with no reason is a mystery, and this one is
            // disabled for several different reasons.
            Text(model.refusal?.reason
                 ?? "Arming posts the comment, then mints the label. It cannot be undone from here.")
        }
    }

    @ViewBuilder
    private func armedSection(_ armed: ArmResponse) -> some View {
        Section {
            Label("Armed — the comment is posted and the \(armed.label) label minted. "
                  + "It is in tonight's 01:00 run.",
                  systemImage: "checkmark.circle.fill")
                .font(.caption).foregroundStyle(.green)
            if let url = URL(string: armed.url.isEmpty ? candidate.url : armed.url) {
                Link("See the issue", destination: url).font(.caption)
            }
            // Audit-only failure, reported alongside the success rather than
            // over it: a ledger hiccup does not un-arm a correctly armed issue,
            // but it does mean the trust ratchet never saw this decision.
            if let decision = armed.decision, decision.recorded == false {
                Label("The autonomy ledger did not record this"
                      + (decision.error.map { " — \($0)" } ?? "") + ".",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption2).foregroundStyle(.orange)
            }
        }
        .onAppear { onArmed() }
    }

    private func statusLabel(_ status: CriterionStatus) -> String {
        switch status {
        case .met: return "MET"
        case .missing: return "MISSING"
        case .na: return "N/A"
        case .unknown: return "?"
        }
    }

    private func statusColour(_ status: CriterionStatus) -> Color {
        switch status {
        case .met: return .green
        case .missing: return .orange
        case .na, .unknown: return .secondary
        }
    }
}
