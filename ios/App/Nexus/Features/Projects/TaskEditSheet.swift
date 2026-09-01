import SwiftUI
import NexusCore

/// The fields a board card's edit sheet can write. Mirrors the payload the
/// desktop modal submits (`onSubmit({ title, description, priority })`).
struct TaskEdit: Equatable {
    var title: String
    var description: String
    var priority: TaskPriority
}

/// Edit sheet for one Kanban card — the iOS half of the desktop's "Edit Task"
/// modal (`src/frontend/src/components/TaskModal.tsx`): title, description,
/// priority, and the task's Monday initiative.
///
/// Two deliberate differences from the desktop modal:
///
///   * **Status is not here.** On this board status *is* the columns, and the
///     board already writes it by drag or context menu. A second control for
///     the same field would be two sources of truth for one column.
///   * **The Monday initiative is read-only.** The iOS client can read a
///     project's items (`GET /api/monday/projects/:id/items`) but has no
///     link/unlink write, so the sheet shows the current link and leaves the
///     picker on the desktop rather than inventing an endpoint for it.
///
/// The sheet owns no network write: it hands a `TaskEdit` back to the board,
/// which applies it optimistically and rolls back on failure — the same shape
/// as a card move, so both writes fail the same way.
struct TaskEditSheet: View {
    let api: APIClient
    let projectId: String
    let card: BoardCard
    let onSave: (TaskEdit) -> Void

    @State private var title: String
    @State private var description: String
    @State private var priority: TaskPriority
    @State private var monday: MondayItem?
    @Environment(\.dismiss) private var dismiss

    init(api: APIClient, projectId: String, card: BoardCard, onSave: @escaping (TaskEdit) -> Void) {
        self.api = api
        self.projectId = projectId
        self.card = card
        self.onSave = onSave
        _title = State(initialValue: card.title)
        _description = State(initialValue: card.description)
        _priority = State(initialValue: card.priority)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") {
                    TextField("What needs to be done?", text: $title, axis: .vertical)
                        .lineLimit(1...3)
                }
                Section("Description") {
                    TextEditor(text: $description)
                        .frame(minHeight: 120)
                        .overlay(alignment: .topLeading) {
                            if description.isEmpty {
                                Text("Details, context, requirements…")
                                    .foregroundStyle(.tertiary)
                                    .padding(.top, 8)
                                    .allowsHitTesting(false)
                            }
                        }
                }
                Section("Priority") {
                    Picker("Priority", selection: $priority) {
                        ForEach(priorityOptions, id: \.rawValue) { option in
                            Text(option.label).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                mondaySection
            }
            .navigationTitle("Edit task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save).disabled(!canSave)
                }
            }
            // A Monday outage must never block editing the task itself, so the
            // lookup is best-effort and its failure just leaves the section
            // hidden — the same tolerant contract the desktop modal keeps.
            .task {
                let items = try? await api.mondayItems(projectId: projectId)
                monday = items?.first { $0.taskIds?.contains(card.id) == true }
            }
        }
    }

    /// The four settable levels, plus the card's own value when the backend
    /// sent one this build doesn't know: an unrecognized priority must still
    /// be selectable, or opening the sheet would silently rewrite it.
    private var priorityOptions: [TaskPriority] {
        TaskPriority.allCases.contains(priority)
            ? TaskPriority.allCases
            : TaskPriority.allCases + [priority]
    }

    @ViewBuilder
    private var mondaySection: some View {
        if let monday {
            Section("Monday initiative") {
                VStack(alignment: .leading, spacing: 4) {
                    Text(monday.name).font(.callout)
                    HStack(spacing: 6) {
                        Text(monday.boardName)
                        if let status = monday.statusLabel {
                            Text("·")
                            Text(status)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    if let url = monday.url.flatMap(URL.init(string:)) {
                        Link("Open in Monday", destination: url).font(.caption)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var edit: TaskEdit {
        TaskEdit(
            title: trimmedTitle,
            description: description.trimmingCharacters(in: .whitespacesAndNewlines),
            priority: priority)
    }

    /// Same guard as the desktop modal (a task must keep a title), plus: don't
    /// PUT a no-op.
    private var canSave: Bool {
        !trimmedTitle.isEmpty
            && edit != TaskEdit(title: card.title, description: card.description, priority: card.priority)
    }

    private func save() {
        guard canSave else { return }
        onSave(edit)
        dismiss()
    }
}
