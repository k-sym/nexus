import SwiftUI
import NexusCore

@MainActor
@Observable
final class BraindumpViewModel {
    private let api: APIClient
    var state: LoadState<[BraindumpIdea]> = .idle
    var actionError: String?

    init(api: APIClient) { self.api = api }

    func refresh() async {
        if state.value == nil { state = .loading }
        do { state = .loaded(try await api.braindump()) }
        catch { state = .failed(LoadState<[BraindumpIdea]>.message(for: error)) }
    }

    func add(title: String, body: String) async {
        await perform { try await self.api.createBraindump(title: title, body: body.isEmpty ? nil : body) }
    }

    func update(id: String, title: String, body: String) async {
        await perform { try await self.api.updateBraindump(id: id, patch: .init(title: title, body: body)) }
    }

    func delete(id: String) async {
        await perform { try await self.api.deleteBraindump(id: id) }
    }

    private func perform(_ op: @escaping () async throws -> Void) async {
        do { try await op(); await refresh() }
        catch { actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }
}

/// Global quick-capture inbox. Add/edit/delete ideas before triaging them into
/// a project task (triage-to-project lands in a later pass).
struct BraindumpView: View {
    @State private var vm: BraindumpViewModel
    @State private var composing = false
    @State private var editing: BraindumpIdea?

    init(api: APIClient) {
        _vm = State(initialValue: BraindumpViewModel(api: api))
    }

    var body: some View {
        content
            .navigationTitle("Braindump")
            .task { if vm.state.value == nil { await vm.refresh() } }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { composing = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $composing) {
                IdeaEditorSheet(title: "New idea", initialTitle: "", initialBody: "") { t, b in
                    Task { await vm.add(title: t, body: b) }
                }
            }
            .sheet(item: $editing) { idea in
                IdeaEditorSheet(title: "Edit idea", initialTitle: idea.title, initialBody: idea.body) { t, b in
                    Task { await vm.update(id: idea.id, title: t, body: b) }
                }
            }
            .alert("Error", isPresented: Binding(get: { vm.actionError != nil }, set: { if !$0 { vm.actionError = nil } }), presenting: vm.actionError) { _ in
                Button("OK", role: .cancel) {}
            } message: { Text($0) }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.state {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let ideas):
            if ideas.isEmpty {
                ContentUnavailableView("Nothing captured", systemImage: "lightbulb", description: Text("Jot an idea with the + button."))
            } else {
                List {
                    ForEach(ideas) { idea in
                        Button { editing = idea } label: { IdeaRow(idea: idea) }
                            .buttonStyle(.plain)
                            .swipeActions {
                                Button("Delete", role: .destructive) { Task { await vm.delete(id: idea.id) } }
                            }
                    }
                }
                .listStyle(.plain)
                .refreshable { await vm.refresh() }
            }
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.refresh() } }
        }
    }
}

struct IdeaRow: View {
    let idea: BraindumpIdea
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(idea.title).font(.subheadline.weight(.medium)).lineLimit(1)
                Spacer()
                if idea.status == "triaged" {
                    Text("triaged").font(.caption2)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.thinMaterial, in: Capsule())
                        .foregroundStyle(.secondary)
                }
            }
            if !idea.body.isEmpty {
                Text(idea.body).font(.callout).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }
}

struct IdeaEditorSheet: View {
    let title: String
    let onSave: (String, String) -> Void

    @State private var ideaTitle: String
    @State private var ideaBody: String
    @Environment(\.dismiss) private var dismiss

    init(title: String, initialTitle: String, initialBody: String, onSave: @escaping (String, String) -> Void) {
        self.title = title
        self.onSave = onSave
        _ideaTitle = State(initialValue: initialTitle)
        _ideaBody = State(initialValue: initialBody)
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $ideaTitle)
                Section("Notes") {
                    TextEditor(text: $ideaBody).frame(minHeight: 120)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let t = ideaTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !t.isEmpty { onSave(t, ideaBody.trimmingCharacters(in: .whitespacesAndNewlines)) }
                        dismiss()
                    }
                    .disabled(ideaTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
