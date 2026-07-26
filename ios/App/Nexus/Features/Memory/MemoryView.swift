import SwiftUI
import NexusCore

@MainActor
@Observable
final class MemoryViewModel {
    private let api: APIClient
    let projectId: String
    var state: LoadState<[MemoryRecord]> = .idle
    var query: String = ""
    var actionError: String?

    init(api: APIClient, projectId: String) {
        self.api = api
        self.projectId = projectId
    }

    func refresh() async {
        if state.value == nil { state = .loading }
        do {
            let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
            state = .loaded(try await api.memories(projectId: projectId, query: q.isEmpty ? nil : q))
        } catch {
            state = .failed(LoadState<[MemoryRecord]>.message(for: error))
        }
    }

    func add(content: String) async {
        await perform { try await self.api.createMemory(projectId: self.projectId, content: content) }
    }

    func update(id: String, content: String) async {
        await perform { try await self.api.updateMemory(id: id, content: content) }
    }

    func delete(id: String) async {
        await perform { try await self.api.deleteMemory(id: id) }
    }

    private func perform(_ op: @escaping () async throws -> Void) async {
        do { try await op(); await refresh() }
        catch { actionError = (error as? APIError)?.errorDescription ?? error.localizedDescription }
    }
}

/// Per-project memory: search, add, edit, delete.
struct MemoryView: View {
    @State private var vm: MemoryViewModel
    @State private var editing: MemoryRecord?
    @State private var composing = false

    init(api: APIClient, projectId: String) {
        _vm = State(initialValue: MemoryViewModel(api: api, projectId: projectId))
    }

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search memory", text: Bindable(vm).query)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    .onSubmit { Task { await vm.refresh() } }
                if !vm.query.isEmpty {
                    Button { vm.query = ""; Task { await vm.refresh() } } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                }
            }
            .padding(8)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)

            content
        }
        .task { if vm.state.value == nil { await vm.refresh() } }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { composing = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $composing) {
            MemoryEditorSheet(title: "New memory", initial: "") { text in
                Task { await vm.add(content: text) }
            }
        }
        .sheet(item: $editing) { record in
            MemoryEditorSheet(title: "Edit memory", initial: record.content) { text in
                Task { await vm.update(id: record.id, content: text) }
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
        case .loaded(let records):
            if records.isEmpty {
                ContentUnavailableView("No memories", systemImage: "brain", description: Text("Add one with the + button."))
            } else {
                List {
                    ForEach(records) { record in
                        Button { editing = record } label: { MemoryRow(record: record) }
                            .buttonStyle(.plain)
                            .swipeActions {
                                Button("Delete", role: .destructive) { Task { await vm.delete(id: record.id) } }
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

struct MemoryRow: View {
    let record: MemoryRecord
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                if !record.title.isEmpty {
                    Text(record.title).font(.subheadline.weight(.medium)).lineLimit(1)
                }
                Spacer()
                Text(record.category).font(.caption2)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.thinMaterial, in: Capsule())
                    .foregroundStyle(.secondary)
            }
            Text(record.content).font(.callout).foregroundStyle(.secondary).lineLimit(3)
        }
        .padding(.vertical, 2)
    }
}

/// Reusable content editor for add/edit.
struct MemoryEditorSheet: View {
    let title: String
    let initial: String
    let onSave: (String) -> Void

    @State private var text: String
    @Environment(\.dismiss) private var dismiss

    init(title: String, initial: String, onSave: @escaping (String) -> Void) {
        self.title = title
        self.initial = initial
        self.onSave = onSave
        _text = State(initialValue: initial)
    }

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .padding()
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !trimmed.isEmpty { onSave(trimmed) }
                            dismiss()
                        }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
        }
    }
}
