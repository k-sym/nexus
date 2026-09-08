import SwiftUI
import NexusCore

/// Ticket to session (#432), phone edition: the cleaned ticket, Draft with
/// Sonnet, project + model pickers, editable prompt and branch, Go. Go opens
/// the new thread as a cover with the first turn seeded.
@MainActor
@Observable
final class TicketDetailViewModel {
    private let api: APIClient
    let ticket: Ticket

    var description: LoadState<TicketDescription> = .idle
    var projects: [Project] = []
    var models: [Model] = []

    var drafting = false
    var draftError: String?
    var hasDraft = false

    var projectId: String = ""
    var modelKey: String = ""
    var branchType: String = "fix"
    var branchName: String = ""
    var problem: String = ""

    var going = false
    var goError: String?

    init(api: APIClient, ticket: Ticket) {
        self.api = api
        self.ticket = ticket
    }

    var canGo: Bool {
        !going && !projectId.isEmpty && !modelKey.isEmpty
            && !problem.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !branchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func load() async {
        if description.value == nil { description = .loading }
        async let desc: Void = loadDescription(refresh: false)
        async let lists: Void = loadLists()
        _ = await (desc, lists)
    }

    func loadDescription(refresh: Bool) async {
        do {
            description = .loaded(try await api.ticketDescription(key: ticket.key, refresh: refresh))
        } catch {
            description = .failed(LoadState<TicketDescription>.message(for: error))
        }
    }

    private func loadLists() async {
        async let p = api.projects()
        async let m = api.models()
        projects = (try? await p) ?? []
        models = (try? await m) ?? []
        if projectId.isEmpty, let first = projects.first { projectId = first.id }
        if modelKey.isEmpty, let sonnet = models.first(where: { $0.modelKey == "claude-code/claude-sonnet-5" }) ?? models.first {
            modelKey = sonnet.modelKey
        }
    }

    func draft() async {
        drafting = true
        draftError = nil
        defer { drafting = false }
        do {
            let d = try await api.ticketDraft(key: ticket.key)
            problem = d.problem
            branchType = ticketBranchTypes.contains(d.branchType) ? d.branchType : "fix"
            branchName = d.branchName
            if let pid = d.projectId, projects.contains(where: { $0.id == pid }) { projectId = pid }
            hasDraft = true
        } catch {
            draftError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func setBranchType(_ type: String) {
        branchType = type
        if !branchName.isEmpty { branchName = ticketBranchName(type: type, replacingPrefixOf: branchName) }
    }

    /// Returns what to open, or nil (with `goError` set) on failure.
    func go() async -> OpenThread? {
        guard canGo else { return nil }
        going = true
        goError = nil
        defer { going = false }
        do {
            let result = try await api.createTicketSession(
                key: ticket.key,
                TicketSessionRequest(
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

struct TicketDetailView: View {
    @State private var vm: TicketDetailViewModel
    @Environment(AppRouter.self) private var router
    @State private var showTrimmed = false

    init(api: APIClient, ticket: Ticket) {
        _vm = State(initialValue: TicketDetailViewModel(api: api, ticket: ticket))
    }

    var body: some View {
        Form {
            header
            descriptionSection
            if let session = vm.ticket.session {
                Section {
                    Button("Open session") {
                        router.openThread = OpenThread(id: session.threadId, title: vm.ticket.key)
                    }
                } footer: {
                    Text("This ticket already has a session.")
                }
            } else {
                sessionSection
            }
        }
        .navigationTitle(vm.ticket.key)
        .navigationBarTitleDisplayMode(.inline)
        .task { await vm.load() }
    }

    private var header: some View {
        Section {
            Text(vm.ticket.summary).font(.headline)
            LabeledContent("Status", value: vm.ticket.status)
            LabeledContent("Priority", value: vm.ticket.priority)
            if let assignee = vm.ticket.assignee { LabeledContent("Assignee", value: assignee) }
            if let updated = vm.ticket.updated { LabeledContent("Updated", value: updated) }
            if let urlString = vm.ticket.url, let url = URL(string: urlString) {
                Link("Open in Jira", destination: url)
            }
        }
    }

    @ViewBuilder
    private var descriptionSection: some View {
        Section {
            switch vm.description {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                Text(message).foregroundStyle(.red)
                Button("Retry") { Task { await vm.loadDescription(refresh: true) } }
            case .loaded(let desc):
                if desc.empty {
                    Text("No description on this ticket.").foregroundStyle(.secondary)
                } else {
                    Text(desc.body).font(.callout).textSelection(.enabled)
                    if !desc.trimmed.isEmpty {
                        Button(showTrimmed ? "Hide trimmed" : "Show \(desc.trimmed.count) trimmed section\(desc.trimmed.count == 1 ? "" : "s")") {
                            showTrimmed.toggle()
                        }
                        .font(.caption)
                        if showTrimmed {
                            ForEach(Array(desc.trimmed.enumerated()), id: \.offset) { _, t in
                                Text(t.text).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        } header: {
            HStack {
                Text("Ticket")
                Spacer()
                Button {
                    Task { await vm.loadDescription(refresh: true) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Re-fetch from Jira")
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
                ForEach(ticketBranchTypes, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.segmented)
            TextField("\(vm.branchType)/\(vm.ticket.key.replacingOccurrences(of: "-", with: ""))-short-description", text: $vm.branchName)
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
            Text("Opens a session in the project with this prompt as the first turn. The agent works on the branch and pushes it; Jira is never touched.")
        }
    }
}
