import SwiftUI
import NexusCore

// MARK: - View model

@MainActor
@Observable
final class IdeasViewModel {
    private let api: APIClient
    var state: LoadState<[Idea]> = .idle
    /// When true, fetch `?all=1` and show the Done (graduated/discarded) section.
    var showDone = false
    var actionError: String?

    init(api: APIClient) { self.api = api }

    func refresh() async {
        if state.value == nil { state = .loading }
        do { state = .loaded(try await api.ideas(includeDone: showDone)) }
        catch { state = .failed(LoadState<[Idea]>.message(for: error)) }
    }

    func add(title: String, seed: String) async {
        await perform { try await self.api.createIdea(title: title, seed: seed.isEmpty ? nil : seed) }
    }

    func delete(id: String) async {
        await perform { try await self.api.deleteIdea(id: id) }
    }

    func setState(id: String, to state: IdeaState) async {
        await perform { try await self.api.updateIdea(id: id, patch: .init(state: state)) }
    }

    private func perform(_ op: @escaping () async throws -> Void) async {
        do { try await op(); await refresh() }
        catch { actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }
}

// MARK: - Attention grouping

/// The list groups by attention, not raw state (mirrors the web IdeasView):
/// Waiting on you → reviewed; Ripening → discussing/researching (and any
/// unknown future state, so nothing vanishes); Parked → parked; Done →
/// graduated/discarded behind a toggle.
private struct IdeaGroups {
    var waiting: [Idea] = []
    var ripening: [Idea] = []
    var parked: [Idea] = []
    var done: [Idea] = []

    init(_ ideas: [Idea]) {
        for idea in ideas {
            switch idea.state {
            case .reviewed: waiting.append(idea)
            case .discussing, .researching, .unknown: ripening.append(idea)
            case .parked: parked.append(idea)
            case .graduated, .discarded: done.append(idea)
            }
        }
    }

    var isEmpty: Bool {
        waiting.isEmpty && ripening.isEmpty && parked.isEmpty && done.isEmpty
    }
}

// MARK: - Ideas list

/// The Idea Watcher (#352, successor to Braindump): quick capture into Parked,
/// dialogue-first ripening. An idea's thread is an ordinary assistant session,
/// so the detail view hands off to the shared `StreamingChatView`. Graduation
/// (project / GitHub issues) is web-only in v1 — rows just show the links.
struct IdeasView: View {
    private let api: APIClient
    @State private var vm: IdeasViewModel
    @State private var composing = false

    init(api: APIClient) {
        self.api = api
        _vm = State(initialValue: IdeasViewModel(api: api))
    }

    var body: some View {
        content
            .navigationTitle("Ideas")
            .task { if vm.state.value == nil { await vm.refresh() } }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { composing = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $composing) {
                IdeaComposeSheet { title, seed in
                    Task { await vm.add(title: title, seed: seed) }
                }
            }
            .alert("Error", isPresented: actionErrorBinding, presenting: vm.actionError) { _ in
                Button("OK", role: .cancel) {}
            } message: { Text($0) }
    }

    private var actionErrorBinding: Binding<Bool> {
        Binding(get: { vm.actionError != nil }, set: { if !$0 { vm.actionError = nil } })
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let ideas):
            let groups = IdeaGroups(ideas)
            if groups.isEmpty && !vm.showDone {
                ContentUnavailableView {
                    Label("Nothing captured", systemImage: "lightbulb.max")
                } description: {
                    Text("Park an idea with the + button.")
                } actions: {
                    showDoneButton
                }
            } else {
                list(groups)
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }

    private func list(_ groups: IdeaGroups) -> some View {
        List {
            section("Waiting on you", groups.waiting)
            section("Ripening", groups.ripening)
            section("Parked", groups.parked)
            if vm.showDone {
                section("Done", groups.done, emptyNote: "Nothing graduated or discarded yet.")
            }
            Section {
                showDoneButton
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await vm.refresh() }
    }

    /// Toggles the terminal-states section (refetches with `?all=1` when shown).
    private var showDoneButton: some View {
        Button(vm.showDone ? "Hide done" : "Show done") {
            vm.showDone.toggle()
            Task { await vm.refresh() }
        }
        .font(.callout)
    }

    @ViewBuilder
    private func section(_ title: String, _ ideas: [Idea], emptyNote: String? = nil) -> some View {
        if !ideas.isEmpty {
            Section(title) {
                ForEach(ideas) { idea in
                    NavigationLink {
                        IdeaDetailView(api: api, idea: idea) { Task { await vm.refresh() } }
                    } label: {
                        IdeaListRow(idea: idea)
                    }
                    .swipeActions {
                        Button("Delete", role: .destructive) { Task { await vm.delete(id: idea.id) } }
                    }
                }
            }
        } else if let emptyNote {
            Section(title) {
                Text(emptyNote).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Row

struct IdeaListRow: View {
    let idea: Idea

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(idea.title).font(.subheadline.weight(.medium)).lineLimit(1)
                Spacer(minLength: 4)
                if !(idea.graduatedTo?.issueURLs.isEmpty ?? true) {
                    Image(systemName: "link")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Has filed issues")
                }
                IdeaStatePill(state: idea.state)
            }
            HStack(spacing: 6) {
                if let date = RelativeTime.parse(idea.updatedAt) {
                    Text("Updated \(RelativeTime.string(from: date))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if !idea.seed.isEmpty {
                    Text(idea.seed).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// Text state pill per the mobile convention (see RoutineHealthBadge): a
/// caption capsule, colour-coded by lifecycle stage.
struct IdeaStatePill: View {
    let state: IdeaState

    var body: some View {
        Text(state.label.uppercased())
            .font(.caption2.weight(.bold))
            .tracking(0.5)
            .foregroundStyle(foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(fill, in: Capsule())
            .accessibilityLabel(state.label)
    }

    private var foreground: Color {
        switch state {
        case .parked: .secondary
        case .discussing: .blue
        case .researching: .indigo
        case .reviewed: .orange
        case .graduated: .green
        case .discarded, .unknown: .secondary
        }
    }

    private var fill: Color {
        switch state {
        case .parked: .gray.opacity(0.18)
        case .discussing: .blue.opacity(0.16)
        case .researching: .indigo.opacity(0.16)
        case .reviewed: .orange.opacity(0.2)
        case .graduated: .green.opacity(0.18)
        case .discarded, .unknown: .gray.opacity(0.14)
        }
    }
}

// MARK: - Compose sheet

/// Quick capture: title required, seed notes optional (Enter-to-park ethos —
/// nothing else to fill in).
struct IdeaComposeSheet: View {
    let onSave: (String, String) -> Void

    @State private var title = ""
    @State private var seed = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                TextField("Idea", text: $title)
                    .submitLabel(.done)
                    .onSubmit(save)
                Section("Notes") {
                    TextEditor(text: $seed).frame(minHeight: 120)
                }
            }
            .navigationTitle("Park an idea")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Park", action: save)
                        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func save() {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onSave(trimmed, seed.trimmingCharacters(in: .whitespacesAndNewlines))
        dismiss()
    }
}

// MARK: - Detail

/// Programmatic push target for the idea's dialogue (same pattern as
/// `NewAssistantSession` — closure NavigationLinks don't cover a push that
/// exists only after an API call resolves).
private struct IdeaDiscussTarget: Hashable, Identifiable {
    let id: String  // assistant session id
    let title: String
}

/// Idea header (state picker, seed, graduation links) over a Discuss push into
/// the shared assistant chat. Thin slice: research commissioning and
/// graduation actions live on the web surface.
struct IdeaDetailView: View {
    private let api: APIClient
    var onMutate: () -> Void

    @State private var idea: Idea
    @State private var discussTarget: IdeaDiscussTarget?
    @State private var resolvingSession = false
    @State private var actionError: String?

    init(api: APIClient, idea: Idea, onMutate: @escaping () -> Void = {}) {
        self.api = api
        self.onMutate = onMutate
        _idea = State(initialValue: idea)
    }

    var body: some View {
        List {
            Section {
                HStack {
                    statePicker
                    Spacer()
                    if let repo = idea.targetRepo {
                        Text(repo).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }
                if !idea.seed.isEmpty {
                    Text(idea.seed).font(.callout).foregroundStyle(.secondary)
                }
                if !idea.tags.isEmpty {
                    Text(idea.tags.map { "#\($0)" }.joined(separator: "  "))
                        .font(.caption).foregroundStyle(.tertiary)
                }
            }

            graduationSection

            Section {
                Button(action: discuss) {
                    HStack {
                        Label("Discuss", systemImage: "bubble.left.and.text.bubble.right.fill")
                        Spacer()
                        if resolvingSession { ProgressView() }
                    }
                }
                .disabled(resolvingSession)
            } footer: {
                Text("Opens the idea's dialogue with the assistant. Research and graduation run from the desktop.")
            }
        }
        .navigationTitle(idea.title)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $discussTarget) { target in
            StreamingChatView(
                endpoint: AssistantChatEndpoint(api: api, sessionId: target.id), title: target.title)
        }
        .alert("Error", isPresented: errorBinding, presenting: actionError) { _ in
            Button("OK", role: .cancel) {}
        } message: { Text($0) }
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })
    }

    /// Menu-based state picker across all real states — deliberate flips are
    /// allowed from anywhere (the backend doesn't police transitions either).
    private var statePicker: some View {
        Menu {
            Picker("State", selection: stateBinding) {
                ForEach(IdeaState.selectable, id: \.self) { state in
                    Text(state.label).tag(state)
                }
            }
        } label: {
            HStack(spacing: 5) {
                IdeaStatePill(state: idea.state)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var stateBinding: Binding<IdeaState> {
        Binding(
            get: { idea.state == .unknown ? .parked : idea.state },
            set: { newState in
                guard newState != idea.state else { return }
                Task {
                    do {
                        idea = try await api.updateIdea(id: idea.id, patch: .init(state: newState))
                        onMutate()
                    } catch {
                        actionError = LoadState<Idea>.message(for: error)
                    }
                }
            })
    }

    @ViewBuilder
    private var graduationSection: some View {
        switch idea.graduatedTo {
        case .issues(let urls) where !urls.isEmpty:
            Section("Filed issues") {
                ForEach(urls, id: \.self) { url in
                    if let link = URL(string: url) {
                        Link(destination: link) {
                            HStack {
                                Image(systemName: "link")
                                Text(displayName(for: url)).lineLimit(1)
                            }
                            .font(.callout)
                        }
                    } else {
                        Text(url).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        case .project(let projectId, _):
            Section("Graduated") {
                Label("Became project \(projectId)", systemImage: "folder.fill")
                    .font(.callout).foregroundStyle(.secondary)
            }
        default:
            EmptyView()
        }
    }

    /// "owner/repo#123" for a GitHub issue URL; the raw URL otherwise.
    private func displayName(for url: String) -> String {
        guard let comps = URL(string: url), comps.pathComponents.count >= 5,
              comps.pathComponents[3] == "issues" else { return url }
        let parts = comps.pathComponents
        return "\(parts[1])/\(parts[2])#\(parts[4])"
    }

    /// Ensure/attach the dialogue session, then push the shared chat. Idempotent
    /// server-side; also flips parked → discussing, so reflect that locally.
    private func discuss() {
        resolvingSession = true
        Task {
            defer { resolvingSession = false }
            do {
                let sessionId = try await api.ideaSession(id: idea.id)
                discussTarget = IdeaDiscussTarget(id: sessionId, title: idea.title)
                onMutate()
            } catch {
                actionError = LoadState<Idea>.message(for: error)
            }
        }
    }
}
