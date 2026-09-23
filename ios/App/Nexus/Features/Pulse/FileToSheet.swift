import SwiftUI
import EventKit
import NexusCore

/// Where a Needs-you item can be filed: an idea or an Apple reminder for things
/// that belong to no project, then the projects (a Board to-do). The project
/// rows come from `ProjectsCache`, so they are there the moment the sheet opens;
/// a refresh runs behind them.
struct FileToSheet: View {
    enum Destination {
        case idea
        case reminder
        case project(Project)
    }

    let api: APIClient
    /// The producer's suggestion (slice 6b): a project slug or badge, listed first.
    let suggestedProject: String?
    let onPick: (Destination) -> Void

    @Environment(\.dismiss) private var dismiss
    private var cache = ProjectsCache.shared
    @State private var loadError: String?

    init(api: APIClient, suggestedProject: String?, onPick: @escaping (Destination) -> Void) {
        self.api = api
        self.suggestedProject = suggestedProject
        self.onPick = onPick
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { pick(.idea) } label: {
                        Label("Ideas", systemImage: "lightbulb")
                    }
                    Button { pick(.reminder) } label: {
                        Label("Reminder", systemImage: "checklist")
                    }
                } header: {
                    Text("No project")
                }
                Section("Projects") {
                    if cache.projects.isEmpty {
                        if let loadError {
                            Label(loadError, systemImage: "exclamationmark.triangle")
                                .font(.caption).foregroundStyle(.red)
                        } else {
                            ProgressView()
                        }
                    } else {
                        ForEach(orderedProjects) { project in
                            Button { pick(.project(project)) } label: { row(for: project) }
                        }
                    }
                }
            }
            .navigationTitle("File to…")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task {
                do { try await cache.refresh(api: api) } catch {
                    loadError = LoadState<[Project]>.message(for: error)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func pick(_ destination: Destination) {
        dismiss()
        onPick(destination)
    }

    private func isSuggested(_ project: Project) -> Bool {
        guard let hint = suggestedProject, !hint.isEmpty else { return false }
        return project.slug == hint || project.badge == hint
    }

    private var orderedProjects: [Project] {
        cache.projects.sorted { isSuggested($0) && !isSuggested($1) }
    }

    private func row(for project: Project) -> some View {
        HStack(spacing: 10) {
            Text(project.badge)
                .font(.caption2.weight(.bold)).tracking(0.5)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(.thinMaterial, in: Capsule())
            Text(project.name)
            if isSuggested(project) {
                Spacer()
                Text("suggested").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

/// Add a Needs-you item to Apple Reminders with a due date. The reminder lives
/// on the device (and the person's iCloud), not in Nexus; once it is saved the
/// caller marks the item seen with `{ filed_as: "reminder" }`.
struct ReminderComposer: View {
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var notes: String
    @State private var due: Date
    @State private var saving = false
    @State private var error: String?

    init(title: String, notes: String, onSaved: @escaping () -> Void) {
        self.onSaved = onSaved
        _title = State(initialValue: title)
        _notes = State(initialValue: notes)
        _due = State(initialValue: Self.tomorrowMorning)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title, axis: .vertical)
                    TextField("Notes", text: $notes, axis: .vertical)
                        .font(.callout).foregroundStyle(.secondary)
                }
                Section {
                    HStack {
                        quickPick("Tomorrow", Self.tomorrowMorning)
                        quickPick("Friday", Self.nextWeekday(6))
                        quickPick("Month end", Self.endOfMonth)
                    }
                    .buttonStyle(.bordered)
                    DatePicker("Due", selection: $due, in: Date()...)
                } header: {
                    Text("When")
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Reminder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Adding…" : "Add") { Task { await save() } }
                        .disabled(saving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func quickPick(_ label: String, _ date: Date) -> some View {
        Button(label) { due = date }
            .font(.caption)
            .frame(maxWidth: .infinity)
    }

    private func save() async {
        saving = true
        error = nil
        defer { saving = false }
        let store = EKEventStore()
        do {
            guard try await store.requestFullAccessToReminders() else {
                error = "Nexus can't reach Reminders. Allow it in Settings → Nexus → Reminders."
                return
            }
            guard let list = store.defaultCalendarForNewReminders() else {
                error = "No default Reminders list is set on this phone."
                return
            }
            let reminder = EKReminder(eventStore: store)
            reminder.calendar = list
            reminder.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
            reminder.notes = trimmedNotes.isEmpty ? nil : trimmedNotes
            reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
            reminder.addAlarm(EKAlarm(absoluteDate: due))
            try store.save(reminder, commit: true)
            dismiss()
            onSaved()
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Quick picks — all at 09:00 local.

    private static func nineAM(_ date: Date) -> Date {
        Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: date) ?? date
    }

    static var tomorrowMorning: Date {
        nineAM(Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date())
    }

    /// The next given weekday (1 = Sunday … 7 = Saturday), never today.
    static func nextWeekday(_ weekday: Int) -> Date {
        let cal = Calendar.current
        let start = cal.date(byAdding: .day, value: 1, to: Date()) ?? Date()
        let next = cal.nextDate(after: cal.startOfDay(for: start).addingTimeInterval(-1),
                                matching: DateComponents(weekday: weekday), matchingPolicy: .nextTime) ?? start
        return nineAM(next)
    }

    /// The last day of this month, or of next month when today is already the last.
    static var endOfMonth: Date {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        func lastDay(of date: Date) -> Date? {
            guard let interval = cal.dateInterval(of: .month, for: date) else { return nil }
            return cal.date(byAdding: .day, value: -1, to: interval.end)
        }
        guard var last = lastDay(of: today) else { return tomorrowMorning }
        if cal.isDate(last, inSameDayAs: today),
           let next = cal.date(byAdding: .month, value: 1, to: today),
           let nextLast = lastDay(of: next) {
            last = nextLast
        }
        return nineAM(last)
    }
}
