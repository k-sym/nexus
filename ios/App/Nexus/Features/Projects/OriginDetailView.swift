import SwiftUI
import NexusCore

/// Inbox item to session (#439), phone edition — the Tickets detail form for a
/// GitHub issue or Monday item: the item, Draft with Sonnet, project + model
/// pickers, editable prompt and branch, Go. Go opens the new, origin-stamped
/// thread as a cover with the first turn seeded, exactly like `TicketDetailView`.
@MainActor
@Observable
final class OriginDetailViewModel {
    private let api: APIClient
    /// The project whose board the item was found on; the Project picker's
    /// default and the route the draft and session calls go to.
    let boardProjectId: String
    let item: BoardInboxItem

    var projects: [Project] = []
    var models: [Model] = []

    var drafting = false
    var draftError: String?
    var hasDraft = false

    var projectId: String
    var modelKey: String = ""
    var branchType: String = "feat"
    var branchName: String = ""
    var problem: String = ""

    var going = false
    var goError: String?

    init(api: APIClient, projectId: String, item: BoardInboxItem) {
        self.api = api
        self.boardProjectId = projectId
        self.projectId = projectId
        self.item = item
    }

    var canGo: Bool {
        !going && !projectId.isEmpty && !modelKey.isEmpty
            && !problem.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !branchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func load() async {
        async let p = api.projects()
        async let m = api.models()
        projects = (try? await p) ?? []
        models = (try? await m) ?? []
        if !projects.contains(where: { $0.id == projectId }), let first = projects.first { projectId = first.id }
        if modelKey.isEmpty, let sonnet = models.first(where: { $0.modelKey == "claude-code/claude-sonnet-5" }) ?? models.first {
            modelKey = sonnet.modelKey
        }
    }

    func draft() async {
        drafting = true
        draftError = nil
        defer { drafting = false }
        do {
            let d = try await api.boardDraft(projectId: boardProjectId, kind: item.kind, id: item.id)
            problem = d.problem
            branchType = boardBranchTypes.contains(d.branchType) ? d.branchType : "feat"
            branchName = d.branchName
            if let pid = d.projectId, projects.contains(where: { $0.id == pid }) { projectId = pid }
            hasDraft = true
        } catch {
            draftError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func setBranchType(_ type: String) {
        branchType = type
        if !branchName.isEmpty { branchName = boardBranchName(type: type, replacingPrefixOf: branchName) }
    }

    /// Returns what to open, or nil (with `goError` set) on failure.
    func go() async -> OpenThread? {
        guard canGo else { return nil }
        going = true
        goError = nil
        defer { going = false }
        do {
            let result = try await api.createBoardSession(
                projectId: boardProjectId,
                OriginSessionRequest(
                    kind: item.kind,
                    id: item.id,
                    projectId: projectId,
                    problem: problem.trimmingCharacters(in: .whitespacesAndNewlines),
                    branchName: branchName.trimmingCharacters(in: .whitespacesAndNewlines)))
            return OpenThread(id: result.thread.id, title: result.thread.title, seed: ChatSeed(text: result.firstTurn, modelKey: modelKey))
        } catch {
            goError = (error as? APIError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }
}

struct OriginDetailView: View {
    @State private var vm: OriginDetailViewModel
    @Environment(AppRouter.self) private var router

    init(api: APIClient, projectId: String, item: BoardInboxItem) {
        _vm = State(initialValue: OriginDetailViewModel(api: api, projectId: projectId, item: item))
    }

    var body: some View {
        Form {
            header
            sessionSection
        }
        .navigationTitle(navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task { await vm.load() }
    }

    private var navigationTitle: String {
        switch vm.item.kind {
        case .github: return "#\(vm.item.id)"
        case .monday: return "Monday item"
        case .unknown(let raw): return raw.capitalized
        }
    }

    private var kindLabel: String {
        switch vm.item.kind {
        case .github: return "GitHub issue"
        case .monday: return "Monday item"
        case .unknown(let raw): return raw.capitalized
        }
    }

    private var openLinkTitle: String {
        switch vm.item.kind {
        case .github: return "Open in GitHub"
        case .monday: return "Open in Monday"
        case .unknown: return "Open"
        }
    }

    private var header: some View {
        Section {
            Text(vm.item.title).font(.headline)
            LabeledContent("Kind", value: kindLabel)
            if let status = vm.item.statusLabel, !status.isEmpty {
                LabeledContent("Status", value: status)
            }
            if !vm.item.labels.isEmpty {
                LabeledContent("Labels", value: vm.item.labels.joined(separator: ", "))
            }
            if let updated = vm.item.updated {
                LabeledContent("Updated", value: RelativeTime.parse(updated).map { RelativeTime.string(from: $0) } ?? updated)
            }
            if let urlString = vm.item.url, let url = URL(string: urlString) {
                Link(openLinkTitle, destination: url)
            }
        }
    }

    private var sessionSection: some View {
        Section {
            Button {
                Task { await vm.draft() }
            } label: {
                HStack {
                    Image(systemName: "sparkles")
                    Text(vm.drafting ? "Drafting…" : vm.hasDraft ? "Draft again" : "Draft with Sonnet")
                    if vm.drafting { Spacer(); ProgressView() }
                }
            }
            .disabled(vm.drafting)
            if let err = vm.draftError { Text(err).font(.caption).foregroundStyle(.red) }

            Picker("Project", selection: $vm.projectId) {
                ForEach(vm.projects) { p in Text(p.name).tag(p.id) }
            }
            Picker("Model", selection: $vm.modelKey) {
                ForEach(vm.models) { m in Text(m.name).tag(m.modelKey) }
            }
            Picker("Type", selection: Binding(get: { vm.branchType }, set: { vm.setBranchType($0) })) {
                ForEach(boardBranchTypes, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.segmented)
            TextField("\(vm.branchType)/short-description", text: $vm.branchName)
                .font(.system(.footnote, design: .monospaced))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            TextEditor(text: $vm.problem)
                .frame(minHeight: 120)
                .font(.callout)
                .overlay(alignment: .topLeading) {
                    if vm.problem.isEmpty {
                        Text("Draft with Sonnet, or write the problem yourself.")
                            .foregroundStyle(.tertiary)
                            .padding(.top, 8).padding(.leading, 4)
                            .allowsHitTesting(false)
                    }
                }

            Button {
                Task {
                    if let open = await vm.go() { router.openThread = open }
                }
            } label: {
                HStack {
                    Spacer()
                    Image(systemName: "play.fill")
                    Text(vm.going ? "Starting…" : "Go")
                    Spacer()
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!vm.canGo)
            if let err = vm.goError { Text(err).font(.caption).foregroundStyle(.red) }
        } header: {
            Text("Session")
        } footer: {
            Text("Opens a session in the project with this prompt as the first turn. The agent works on the branch and pushes it; the issue or item is never touched.")
        }
    }
}
