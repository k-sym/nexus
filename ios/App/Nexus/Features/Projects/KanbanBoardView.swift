import SwiftUI
import NexusCore

/// A lightweight, mutable projection of a task for the board (ProjectTask is
/// immutable). Optimistic writes flip these before the server confirms.
///
/// `description` is carried even though the card never draws it: the board
/// already fetched the whole task, so the edit sheet can open populated
/// instead of re-fetching one it has.
struct BoardCard: Identifiable, Hashable {
    let id: String
    var title: String
    var description: String
    var priority: TaskPriority
    var status: TaskStatus
}

@MainActor
@Observable
final class KanbanViewModel {
    private let api: APIClient
    let projectId: String
    var cards: [BoardCard] = []
    var loadState: LoadState<Void> = .idle
    /// Shared by both optimistic writes (move and edit) — one card, one alert.
    var actionError: String?

    init(api: APIClient, projectId: String) {
        self.api = api
        self.projectId = projectId
    }

    func load() async {
        if case .loaded = loadState {} else { loadState = .loading }
        do {
            let tasks = try await api.tasks(projectId: projectId)
            cards = tasks.map {
                BoardCard(
                    id: $0.id, title: $0.title, description: $0.description,
                    priority: $0.priority, status: $0.status)
            }
            loadState = .loaded(())
            maybeAutoMove()
        } catch {
            loadState = .failed(LoadState<Void>.message(for: error))
        }
    }

    func cards(in status: TaskStatus) -> [BoardCard] {
        cards.filter { $0.status == status }
    }

    /// Optimistically move a card, then PUT the new status; roll back on failure.
    func move(_ id: String, to newStatus: TaskStatus) {
        guard let index = cards.firstIndex(where: { $0.id == id }) else { return }
        let previous = cards[index].status
        guard previous != newStatus else { return }
        cards[index].status = newStatus
        Task {
            do {
                _ = try await api.updateTask(id: id, status: newStatus.rawValue)
            } catch {
                if let i = cards.firstIndex(where: { $0.id == id }) { cards[i].status = previous }
                actionError = "Couldn't move card: \(LoadState<Void>.message(for: error))"
            }
        }
    }

    /// Optimistically apply an edit, then PUT the changed fields; roll back on
    /// failure. Only the fields that actually changed go on the wire, so a
    /// title-only edit can't clobber a description edited elsewhere.
    func edit(_ id: String, to edit: TaskEdit) {
        guard let index = cards.firstIndex(where: { $0.id == id }) else { return }
        let previous = cards[index]
        var patch = UpdateTaskRequest()
        if edit.title != previous.title { patch.title = edit.title }
        // An emptied description is a real change: "" clears the column,
        // whereas omitting the field would leave the old text in place.
        if edit.description != previous.description { patch.description = edit.description }
        if edit.priority != previous.priority { patch.priority = edit.priority.rawValue }
        guard patch.title != nil || patch.description != nil || patch.priority != nil else { return }

        cards[index].title = edit.title
        cards[index].description = edit.description
        cards[index].priority = edit.priority
        Task {
            do {
                _ = try await api.updateTask(id: id, patch: patch)
            } catch {
                if let i = cards.firstIndex(where: { $0.id == id }) { cards[i] = previous }
                actionError = "Couldn't save changes: \(LoadState<Void>.message(for: error))"
            }
        }
    }

    private func maybeAutoMove() {
        #if DEBUG
        // Verification hook: NEXUS_DEV_KANBAN_MOVE="taskId:status".
        if let spec = ProcessInfo.processInfo.environment["NEXUS_DEV_KANBAN_MOVE"] {
            let parts = spec.split(separator: ":")
            if parts.count == 2 { move(String(parts[0]), to: TaskStatus(rawValue: String(parts[1]))) }
        }
        #endif
    }
}

/// 5-column Kanban board. Cards drag between columns (or use the context menu);
/// tapping one opens the edit sheet. Both writes go to `PUT /tasks/:id`
/// optimistically.
struct KanbanBoardView: View {
    private let api: APIClient
    private let projectId: String
    @State private var vm: KanbanViewModel
    @State private var editing: BoardCard?

    init(api: APIClient, projectId: String) {
        self.api = api
        self.projectId = projectId
        _vm = State(initialValue: KanbanViewModel(api: api, projectId: projectId))
    }

    var body: some View {
        content
            .task { if case .idle = vm.loadState { await vm.load() } }
            .sheet(item: $editing) { card in
                TaskEditSheet(api: api, projectId: projectId, card: card) { edit in
                    vm.edit(card.id, to: edit)
                }
            }
            .alert("Couldn't save", isPresented: actionErrorBinding, presenting: vm.actionError) { _ in
                Button("OK", role: .cancel) {}
            } message: { Text($0) }
    }

    private var actionErrorBinding: Binding<Bool> {
        Binding(get: { vm.actionError != nil }, set: { if !$0 { vm.actionError = nil } })
    }

    @ViewBuilder
    private var content: some View {
        switch vm.loadState {
        case .idle, .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ErrorStateView(message: message) { Task { await vm.load() } }
        case .loaded:
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(TaskStatus.allCases, id: \.rawValue) { status in
                        column(status)
                    }
                }
                .padding()
            }
        }
    }

    private func column(_ status: TaskStatus) -> some View {
        let cards = vm.cards(in: status)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(status.label).font(.subheadline.weight(.semibold))
                Text("\(cards.count)").font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 4)

            ForEach(cards) { card in
                cardView(card)
                    .draggable(card.id)
                    .contextMenu { cardMenu(for: card) }
            }

            if cards.isEmpty {
                Text("—").font(.caption).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            Spacer(minLength: 0)
        }
        .frame(width: 250, alignment: .top)
        .padding(8)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .dropDestination(for: String.self) { items, _ in
            guard let id = items.first else { return false }
            vm.move(id, to: status)
            return true
        }
    }

    private func cardView(_ card: BoardCard) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(card.priority.tint).frame(width: 8, height: 8).padding(.top, 5)
            Text(card.title).font(.callout).lineLimit(3)
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
        // `.draggable` runs off a long press, so a plain tap is still free to
        // mean "edit". The context menu offers Edit too, for anyone who
        // reaches for the card the way they already reach for a move.
        .contentShape(Rectangle())
        .onTapGesture { editing = card }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(card.title), \(card.priority.label) priority")
        .accessibilityHint("Opens the edit sheet")
    }

    @ViewBuilder
    private func cardMenu(for card: BoardCard) -> some View {
        Button("Edit…", systemImage: "pencil") { editing = card }
        Menu("Move to") {
            ForEach(TaskStatus.allCases.filter { $0 != card.status }, id: \.rawValue) { status in
                Button(status.label) { vm.move(card.id, to: status) }
            }
        }
    }
}
