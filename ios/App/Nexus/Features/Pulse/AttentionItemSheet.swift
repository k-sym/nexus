import SwiftUI
import NexusCore

/// One attention item, with the verbs it lists (#477, design D7). Opened from
/// the Pulse card (with the row as a seed) or from an `attention:<id>` deep
/// link (id only); either way it loads the detail by id, so a stale push still
/// opens something honest — a resolved item shows its resolution and no verbs.
///
/// Verbs render only while the item is `open` or `snoozed`. Two verbs take
/// time — `draft` (the partner writes a reply) and `close` (the partner closes
/// the PR behind a `pr.review` item with its own `gh`): the partner answers 202
/// and the item sits `resolving` while its routine runs; the sheet says which
/// and re-reads the detail every 3 s (up to 5 min) until the status moves, then
/// shows the outcome (the draft for review, or the closed PR). `close` is an
/// external GitHub write, so it is confirm-gated here (design D32); the lens
/// never offers it. `open` follows the item's link (D33): a draft opens the
/// review sheet, a url opens the browser, a vault page opens the page sheet.
struct AttentionItemSheet: View {
    private let api: APIClient
    private let itemId: String
    private let seed: AttentionItem?
    private let onChanged: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var item: AttentionItem?
    /// Confirm gates for the two writes that need one (D32 close, D35 approve).
    @State private var confirmingClose = false
    @State private var confirmingCleanup = false
    @State private var loadError: String?
    @State private var actionError: String?
    @State private var busy = false
    @State private var drafting = false
    @State private var draftTimedOut = false
    @State private var reviewDraft: DraftRef?
    @State private var pollTask: Task<Void, Never>?
    /// "Show the page": the vault page behind the item, rendered as markdown.
    @State private var page: AttentionPage?
    @State private var loadingPage = false
    /// "File as a to-do": the project picker, then the created session is pushed.
    @State private var pickingProject = false
    @State private var projects: [Project] = []
    @State private var filing = false
    /// A chat pushed inside this sheet's own stack — the partner's current
    /// conversation (Ask the partner) or the just-filed to-do session.
    @State private var chat: ChatTarget?
    /// The latest message behind a mail item (6d, design D42): fetched once on
    /// open, shown for a person to read. `.failed` carries the partner's
    /// sentence (a mailbox it cannot read today); `threadHidden` is an older
    /// backend or partner without the route.
    @State private var thread: LoadState<AttentionThread> = .idle
    @State private var threadHidden = false
    @State private var threadExpanded = false

    struct DraftRef: Identifiable { let id: String }

    /// Where a push lands. Both are `StreamingChatView`s; only the endpoint differs.
    struct ChatTarget: Identifiable, Hashable {
        enum Kind: Hashable { case assistant(sessionId: String), thread(threadId: String) }
        let kind: Kind
        let title: String
        let seedText: String?
        var id: String {
            switch kind {
            case .assistant(let s): return "assistant:\(s)"
            case .thread(let t): return "thread:\(t)"
            }
        }
    }

    init(api: APIClient, itemId: String, seed: AttentionItem? = nil, onChanged: @escaping () -> Void) {
        self.api = api
        self.itemId = itemId
        self.seed = seed
        self.onChanged = onChanged
        _item = State(initialValue: seed)
    }

    var body: some View {
        NavigationStack {
            Form {
                header
                if let body = item?.body, !body.isEmpty {
                    Section("Details") {
                        Text(body).font(.callout).textSelection(.enabled)
                    }
                }
                if let item, item.isMail, !threadHidden {
                    threadSection
                }
                stateSection
                if let item, item.isActionable, !drafting {
                    verbsSection(for: item)
                }
                if let item {
                    followUpSection(for: item)
                }
                if let actionError {
                    Section {
                        Label(actionError, systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(item.map { AttentionKindGlyph.title(for: $0.kind, raw: $0.kindName) } ?? "Needs you")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
            .onDisappear { pollTask?.cancel() }
            .confirmationDialog("Close this pull request on GitHub?", isPresented: $confirmingClose, titleVisibility: .visible) {
                Button("Close pull request", role: .destructive) {
                    if let item { Task { await runClose(item) } }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(closeMessage)
            }
            .confirmationDialog("Approve the cleanup?", isPresented: $confirmingCleanup, titleVisibility: .visible) {
                Button("Approve cleanup", role: .destructive) {
                    if let item { Task { await runApproveCleanup(item) } }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The partner deletes the files listed in this item on its next reconciliation run. Nexus deletes nothing.")
            }
            .sheet(item: $reviewDraft) { ref in
                DraftReviewSheet(api: api, draftId: ref.id) { onChanged() }
            }
            .sheet(item: $page) { page in
                AttentionPageSheet(page: page)
            }
            .sheet(isPresented: $pickingProject) {
                projectPicker
            }
            .navigationDestination(item: $chat) { target in
                switch target.kind {
                case .assistant(let sessionId):
                    StreamingChatView(endpoint: AssistantChatEndpoint(api: api, sessionId: sessionId), title: target.title,
                                      seed: target.seedText.map { ChatSeed(text: $0, modelKey: nil) })
                case .thread(let threadId):
                    StreamingChatView(api: api, threadId: threadId, title: target.title,
                                      seed: target.seedText.map { ChatSeed(text: $0, modelKey: nil) })
                }
            }
        }
    }

    // MARK: The latest message (6d, design D41/D42) — read-only, never a verb.

    @ViewBuilder
    private var threadSection: some View {
        Section {
            switch thread {
            case .idle, .loading:
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Reading the thread…").foregroundStyle(.secondary) }
                    .font(.callout)
            case .failed(let why):
                // The partner's own sentence (a Google mailbox today), not an error banner.
                Text("Not readable from here — \(why)")
                    .font(.callout).foregroundStyle(.secondary)
            case .loaded(let t):
                if let m = t.latest {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(m.senderLine).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            Spacer(minLength: 8)
                            if let at = m.sentAt {
                                Text(Self.relative(Int(at.timeIntervalSince1970))).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Text(m.body)
                            .font(.callout)
                            .textSelection(.enabled)
                            .lineLimit(threadExpanded ? nil : 12)
                        if !threadExpanded, m.body.count > 480 {
                            Button("More") { threadExpanded = true }.font(.caption)
                        }
                    }
                } else {
                    Text("No message to show.").font(.callout).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Latest message")
        }
    }

    /// Fetch once per open (D42): one read per sheet, none from the list poll.
    private func loadThread(for item: AttentionItem) async {
        guard item.isMail, case .idle = thread else { return }
        thread = .loading
        do {
            thread = .loaded(try await api.attentionThread(id: item.id))
        } catch APIError.server(let status, _) where status == 404 {
            threadHidden = true
            thread = .idle
        } catch {
            thread = .failed(LoadState<AttentionThread>.message(for: error))
        }
    }

    // MARK: Follow-ups (design D20/D21) — client affordances, not partner verbs.
    // Every item, whatever its state, can be talked over with the partner; an
    // item still open can be filed as a to-do (a Board session on a project).

    @ViewBuilder
    private func followUpSection(for item: AttentionItem) -> some View {
        Section {
            Button {
                Task { await askPartner(about: item) }
            } label: {
                Label(busy ? "Opening…" : "Ask the partner", systemImage: "bubble.left.and.text.bubble.right")
            }
            .disabled(busy)
            if item.isActionable {
                Button {
                    Task { await openProjectPicker() }
                } label: {
                    Label(filing ? "Filing…" : "File as a to-do", systemImage: "tray.and.arrow.down")
                }
                .disabled(busy || filing)
            }
            // Approve cleanup (D35): a dismiss carrying the exact key the
            // reconciliation skill reads back; offered only on the one item it
            // reads it from, and only while the partner still accepts a dismiss.
            if item.isActionable, item.isCleanupApproval, item.offeredVerbs.contains(.dismiss) {
                Button {
                    confirmingCleanup = true
                } label: {
                    Label("Approve cleanup", systemImage: "checkmark.seal")
                }
                .disabled(busy)
            }
        } header: {
            Text("Follow up")
        } footer: {
            Text(followUpFooter(for: item))
        }
    }

    private func followUpFooter(for item: AttentionItem) -> String {
        var parts = ["Ask opens the partner's conversation with this item as the first message."]
        if item.isActionable {
            parts.append("File starts a Board session on a project and marks the item seen.")
        }
        if item.isActionable, item.isCleanupApproval {
            parts.append("Approve records your approval on the item; the partner acts on it, Nexus deletes nothing.")
        }
        return parts.joined(separator: " ")
    }

    private var closeMessage: String {
        let url = item?.links?.url.map { " (\($0))" } ?? ""
        return "The partner closes it with its own gh\(url). Nothing is merged."
    }

    /// The project picker for "file as a to-do": the producer's suggestion (slice
    /// 6b) first when it names a known slug or badge; otherwise the rail order.
    private var projectPicker: some View {
        NavigationStack {
            List {
                if projects.isEmpty {
                    ProgressView()
                } else {
                    ForEach(orderedProjects) { project in
                        Button {
                            pickingProject = false
                            Task { await file(to: project) }
                        } label: {
                            HStack(spacing: 10) {
                                Text(project.badge)
                                    .font(.caption2.weight(.bold)).tracking(0.5)
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(.thinMaterial, in: Capsule())
                                Text(project.name)
                                if project.slug == item?.suggestedProject || project.badge == item?.suggestedProject {
                                    Spacer()
                                    Text("suggested").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("File to…")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { pickingProject = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var orderedProjects: [Project] {
        guard let hint = item?.suggestedProject, !hint.isEmpty else { return projects }
        return projects.sorted { a, b in
            let aHit = a.slug == hint || a.badge == hint
            let bHit = b.slug == hint || b.badge == hint
            return aHit && !bHit
        }
    }

    // MARK: Sections

    @ViewBuilder
    private var header: some View {
        Section {
            if let item {
                HStack(alignment: .top, spacing: 10) {
                    AttentionKindGlyph(kind: item.kind, kindName: item.kindName)
                        .font(.title3)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title).font(.headline)
                        if let why = item.why, !why.isEmpty {
                            Text(why).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
                if let created = item.createdAt {
                    LabeledContent("Raised", value: Self.relative(created))
                }
                if item.status == .snoozed, let until = item.snoozedUntil {
                    LabeledContent("Snoozed until", value: Self.absolute(until))
                }
                if let expires = item.expiresAt, item.isActionable {
                    LabeledContent("Expires", value: Self.relative(expires))
                }
                if let account = item.sourceAccount {
                    LabeledContent("Account", value: account)
                }
                if let producer = item.producer {
                    LabeledContent("From", value: producer)
                }
            } else if let loadError {
                Label(loadError, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
    }

    /// What the item is doing, or how it ended.
    @ViewBuilder
    private var stateSection: some View {
        if let item {
            if drafting || item.status == .resolving {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text(item.slowVerb == .close
                             ? "Closing the PR… the partner is closing it on GitHub."
                             : "Drafting… the partner is writing a reply.")
                            .font(.callout)
                    }
                    if draftTimedOut {
                        Text(item.slowVerb == .close
                             ? "Still running after 5 minutes. Check the PR on GitHub, or pull to refresh later."
                             : "Still running after 5 minutes. Pull to refresh later; the draft appears in the Drafts card when it lands.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else if item.status == .resolved || item.status == .expired {
                Section("Outcome") {
                    if let res = item.resolution {
                        LabeledContent(res.verb == .dismiss && item.isNotice ? "Seen" : res.verb.map { AttentionVerbLabel.title($0) } ?? "Resolved",
                                       value: [res.by, res.surface.map { "from \($0)" }].compactMap { $0 }.joined(separator: " "))
                        if let at = res.at { LabeledContent("When", value: Self.relative(at)) }
                        if let url = res.closedURL {
                            // http(s) only (the same allowlist as `linkURL`): a result is
                            // the partner's data, never a scheme the app would launch.
                            Link(destination: url) { Label("Closed — open the PR", systemImage: "arrow.up.right.square") }
                        } else if let closed = res.closedUrl {
                            LabeledContent("Closed", value: closed)
                        }
                        if res.approved {
                            Label("Cleanup approved", systemImage: "checkmark.seal").foregroundStyle(.secondary)
                        }
                        if res.filedAs != nil {
                            Label("Filed as a to-do", systemImage: "tray.and.arrow.down").foregroundStyle(.secondary)
                        }
                    } else {
                        Text(item.status == .expired ? "Expired without action." : "Resolved.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    if let draftId = item.draftId {
                        Button {
                            reviewDraft = DraftRef(id: draftId)
                        } label: { Label("Review draft", systemImage: "paperplane") }
                    }
                }
            } else if let message = item.lastErrorMessage, item.status == .open,
                      item.events?.last?.verb == "error" {
                // A slow verb that returned the item to open with a reason on record.
                Section {
                    Label(item.slowVerb == .close
                          ? "Closing did not go through — \(message)"
                          : "Drafting did not produce a reply — \(message)",
                          systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
        }
    }

    @ViewBuilder
    private func verbsSection(for item: AttentionItem) -> some View {
        let offered = item.offeredVerbs
        if !offered.isEmpty {
            Section {
                ForEach(offered, id: \.self) { verb in
                    verbButton(verb, for: item)
                }
            } footer: {
                if offered.contains(.draft) {
                    Text("Draft asks the partner to write a reply. Nothing is sent: the reply lands in Drafts for your approval.")
                } else if offered.contains(.close) {
                    Text("Close asks the partner to close the pull request on GitHub. Nothing is merged from here.")
                } else if item.isNotice {
                    Text("Seen marks this notice read. Nothing else happens.")
                }
            }
        }
    }

    @ViewBuilder
    private func verbButton(_ verb: AttentionVerb, for item: AttentionItem) -> some View {
        let proposed = item.proposedVerb == verb
        switch verb {
        case .draft:
            Button {
                Task { await runDraft(item) }
            } label: {
                Label(proposed ? "Draft a reply (proposed)" : "Draft a reply", systemImage: "square.and.pencil")
                    .fontWeight(proposed ? .semibold : .regular)
            }
            .disabled(busy)
        case .open:
            Button {
                Task { await runOpen(item) }
            } label: {
                Label(openLabel(for: item), systemImage: "arrow.up.right.square")
                    .fontWeight(proposed ? .semibold : .regular)
            }
            .disabled(busy)
        case .snooze:
            Menu {
                ForEach(AttentionSnoozePreset.allCases, id: \.self) { preset in
                    Button(preset.label) { Task { await run(item, .snooze, preset: preset) } }
                }
            } label: {
                Label("Snooze", systemImage: "zzz")
                    .fontWeight(proposed ? .semibold : .regular)
            }
            .disabled(busy)
        case .close:
            // Confirm-gated (D32): an external GitHub write, run by the partner.
            Button(role: .destructive) {
                confirmingClose = true
            } label: {
                Label(proposed ? "Close pull request (proposed)" : "Close pull request", systemImage: "xmark.octagon")
                    .fontWeight(proposed ? .semibold : .regular)
            }
            .disabled(busy)
        case .dismiss:
            if item.isNotice {
                // A notice wants "seen" (D36): the same verb, its honest name.
                Button {
                    Task { await run(item, .dismiss) }
                } label: { Label("Seen", systemImage: "checkmark.circle") }
                .disabled(busy)
            } else {
                Button(role: .destructive) {
                    Task { await run(item, .dismiss) }
                } label: { Label("Dismiss", systemImage: "xmark.circle") }
                .disabled(busy)
            }
        case .unknown:
            EmptyView()
        }
    }

    /// "Show the page" (D21): the vault page behind the item, fetched by title
    /// through the backend and rendered as markdown.
    private func showPage(for item: AttentionItem) async {
        loadingPage = true
        defer { loadingPage = false }
        do {
            page = try await api.attentionPage(id: item.id)
        } catch {
            actionError = LoadState<AttentionPage>.message(for: error)
        }
    }

    /// "Ask the partner" (D21): the partner's current conversation, seeded with
    /// the item so the first message is already the question.
    private func askPartner(about item: AttentionItem) async {
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            let session = try await api.assistantCurrent()
            var seed = item.title
            if let why = item.why, !why.isEmpty { seed += " — \(why)" }
            if item.links?.vaultPage != nil { seed += ". Show me the prep pack and tell me anything worth tweaking." }
            else if item.links?.draftId != nil { seed += ". Walk me through the draft." }
            else if item.isMail {
                // D43: name the message, never paste it — the partner screens
                // thread bodies before a model sees them, and so must the phone.
                let who = thread.value?.latest?.fromName ?? item.sourceAccount.map { "the \($0) mailbox" } ?? "the sender"
                seed += ". The latest message from \(who) is in the thread — read it before answering. What is the next step here?"
            }
            else { seed += ". What is the next step here?" }
            chat = ChatTarget(kind: .assistant(sessionId: session.id), title: session.title, seedText: seed)
        } catch {
            actionError = LoadState<AssistantSession>.message(for: error)
        }
    }

    private func openProjectPicker() async {
        if projects.isEmpty {
            do { projects = try await api.projects() } catch {
                actionError = LoadState<[Project]>.message(for: error)
                return
            }
        }
        pickingProject = true
    }

    /// "File as a to-do" (D20): a Board session on the project, seeded with the
    /// composed first turn; the item is dismissed on the partner by the same call.
    private func file(to project: Project) async {
        guard let item else { return }
        filing = true
        actionError = nil
        defer { filing = false }
        do {
            let result = try await api.fileAttention(id: item.id, projectId: project.id)
            onChanged()
            chat = ChatTarget(kind: .thread(threadId: result.thread.id), title: result.thread.title, seedText: result.firstTurn)
        } catch {
            actionError = LoadState<OriginSessionResult>.message(for: error)
        }
    }

    /// Where `open` goes, by precedence (D33): draft → url → vault page → proposal.
    private func openLabel(for item: AttentionItem) -> String {
        if item.links?.draftId != nil { return "Review the draft" }
        if item.linkURL != nil { return item.kind == .prReview ? "Open PR" : "Open link" }
        if item.links?.vaultPage != nil { return item.kindName.hasPrefix("recon.") ? "Open Gap Report" : "Show the page" }
        if item.links?.proposalId != nil { return "About this proposal" }
        return "Open"
    }

    // MARK: Actions

    private func load() async {
        do {
            item = try await api.attentionDetail(id: itemId)
            loadError = nil
            if item?.status == .resolving { startPolling() }
            if let item { await loadThread(for: item) }
        } catch {
            loadError = LoadState<AttentionItem>.message(for: error)
        }
    }

    /// snooze / dismiss: one call, then the card refreshes. Dismiss needs no
    /// confirmation: a dismissed thread that waits again is news again by the
    /// partner's dated dedup key.
    private func run(_ item: AttentionItem, _ verb: AttentionVerb, preset: AttentionSnoozePreset? = nil) async {
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            self.item = try await api.resolveAttention(id: item.id, verb: verb, preset: preset)
            onChanged()
            if verb == .dismiss { dismiss() }
        } catch {
            actionError = LoadState<AttentionItem>.message(for: error)
        }
    }

    /// `draft`: the partner answers 202 with the item `resolving`; poll until it
    /// leaves. On `resolved` the outcome section offers the draft; on `open`
    /// again the recorded error shows.
    private func runDraft(_ item: AttentionItem) async {
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            self.item = try await api.resolveAttention(id: item.id, verb: .draft)
            onChanged()
            startPolling()
        } catch {
            actionError = LoadState<AttentionItem>.message(for: error)
        }
    }

    /// `close` (D32): confirmed already; the partner answers 202 with the item
    /// `resolving` and closes the PR with its own `gh`. Poll until it settles.
    private func runClose(_ item: AttentionItem) async {
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            self.item = try await api.resolveAttention(id: item.id, verb: .close)
            onChanged()
            if self.item?.status == .resolving { startPolling() }
        } catch {
            actionError = LoadState<AttentionItem>.message(for: error)
        }
    }

    /// Approve cleanup (D35): confirmed already; a dismiss with exactly
    /// `{approved: true}`, the key the reconciliation skill reads back.
    private func runApproveCleanup(_ item: AttentionItem) async {
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            self.item = try await api.resolveAttention(id: item.id, verb: .dismiss, result: ["approved": true])
            onChanged()
            dismiss()
        } catch {
            actionError = LoadState<AttentionItem>.message(for: error)
        }
    }

    private func startPolling() {
        guard pollTask == nil else { return }
        drafting = true
        draftTimedOut = false
        pollTask = Task {
            defer { pollTask = nil }
            for _ in 0..<100 { // 5 minutes at 3 s
                try? await Task.sleep(for: .seconds(3))
                if Task.isCancelled { return }
                do {
                    let fresh = try await api.attentionDetail(id: itemId)
                    actionError = nil
                    item = fresh
                    if fresh.status != .resolving {
                        drafting = false
                        onChanged()
                        return
                    }
                } catch {
                    // Keep polling (a blip passes), but say so: a read that
                    // keeps failing must not look like a draft still running.
                    actionError = "Checking the draft failed — \(LoadState<AttentionItem>.message(for: error))"
                }
            }
            draftTimedOut = true
        }
    }

    /// `open`: follow the link, and record the event while the partner still
    /// accepts one (it 409s on a resolved item, so that case follows silently).
    private func runOpen(_ item: AttentionItem) async {
        actionError = nil
        if let draftId = item.links?.draftId {
            reviewDraft = DraftRef(id: draftId)
        } else if let url = item.linkURL {
            openURL(url)
        } else if item.links?.vaultPage != nil {
            await showPage(for: item)
        } else if item.links?.proposalId != nil {
            actionError = "Autonomy proposals are decided from the terminal or the web Partner view."
        }
        guard item.isActionable else { return }
        do {
            self.item = try await api.resolveAttention(id: item.id, verb: .open)
        } catch {
            // Recording the open is a convenience, not the action itself.
        }
    }

    // MARK: Formatting

    private static func relative(_ epoch: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(epoch))
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }

    private static func absolute(_ epoch: Int) -> String {
        Date(timeIntervalSince1970: TimeInterval(epoch)).formatted(date: .abbreviated, time: .shortened)
    }
}

/// The vault page behind an item, as the phone can show it: the markdown the
/// producer filed, rendered with the chat's own renderer. Read-only.
struct AttentionPageSheet: View {
    let page: AttentionPage
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                MarkdownText(text: page.body)
                    .padding()
            }
            .navigationTitle(page.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

