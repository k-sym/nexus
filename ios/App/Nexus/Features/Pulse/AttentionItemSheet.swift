import SwiftUI
import NexusCore

/// One attention item, with the verbs it lists (#477, design D7). Opened from
/// the Pulse card (with the row as a seed) or from an `attention:<id>` deep
/// link (id only); either way it loads the detail by id, so a stale push still
/// opens something honest — a resolved item shows its resolution and no verbs.
///
/// Verbs render only while the item is `open` or `snoozed`. `draft` is the one
/// verb that takes time: the partner answers 202 and the item sits `resolving`
/// while its drafting routine runs; the sheet says so and re-reads the detail
/// every 3 s (up to 5 min) until the status moves, then offers the draft for
/// review. `open` follows the item's link; for a draft that is the review
/// sheet, presented (not pushed — it owns its own NavigationStack).
struct AttentionItemSheet: View {
    private let api: APIClient
    private let itemId: String
    private let seed: AttentionItem?
    private let onChanged: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var item: AttentionItem?
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
        } header: {
            Text("Follow up")
        } footer: {
            Text(item.isActionable
                 ? "Ask opens the partner's conversation with this item as the first message. File starts a Board session on a project and marks the item seen."
                 : "Ask opens the partner's conversation with this item as the first message.")
        }
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
                        Text("Drafting… the partner is writing a reply.")
                            .font(.callout)
                    }
                    if draftTimedOut {
                        Text("Still running after 5 minutes. Pull to refresh later; the draft appears in the Drafts card when it lands.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else if item.status == .resolved || item.status == .expired {
                Section("Outcome") {
                    if let res = item.resolution {
                        LabeledContent(res.verb.map { AttentionVerbLabel.title($0) } ?? "Resolved",
                                       value: [res.by, res.surface.map { "from \($0)" }].compactMap { $0 }.joined(separator: " "))
                        if let at = res.at { LabeledContent("When", value: Self.relative(at)) }
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
                // A `draft` that returned the item to open with a reason on record.
                Section {
                    Label("Drafting did not produce a reply — \(message)", systemImage: "exclamationmark.triangle")
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
        case .dismiss:
            Button(role: .destructive) {
                Task { await run(item, .dismiss) }
            } label: { Label("Dismiss", systemImage: "xmark.circle") }
            .disabled(busy)
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

    private func openLabel(for item: AttentionItem) -> String {
        if item.links?.draftId != nil { return "Review the draft" }
        if item.links?.vaultPage != nil { return "Show the page" }
        if item.links?.proposalId != nil { return "About this proposal" }
        return "Open"
    }

    // MARK: Actions

    private func load() async {
        do {
            item = try await api.attentionDetail(id: itemId)
            loadError = nil
            if item?.status == .resolving { startPolling() }
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

    private func startPolling() {
        guard pollTask == nil else { return }
        drafting = true
        draftTimedOut = false
        pollTask = Task {
            defer { pollTask = nil }
            for _ in 0..<100 { // 5 minutes at 3 s
                try? await Task.sleep(for: .seconds(3))
                if Task.isCancelled { return }
                if let fresh = try? await api.attentionDetail(id: itemId) {
                    item = fresh
                    if fresh.status != .resolving {
                        drafting = false
                        onChanged()
                        return
                    }
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

