import Foundation

/// One in-flight chat run, from `/api/chat/active-runs`. This route emits
/// **camelCase** keys, so decode with `JSONDecoder.nexusCamel` (NOT the REST
/// snake-case decoder). Mirrors the `runs[]` entries the web client consumes in
/// `App.tsx`.
public struct ActiveChatRun: Decodable, Hashable, Sendable {
    public let threadId: String
    /// Nil when the owning thread row can't be resolved server-side; such a run
    /// can't tint a project and is ignored by activity derivation.
    public let projectId: String?
    /// True once the run is blocked on a pending question → the amber "waiting"
    /// state; false while the model is actively working → red "working".
    public let waitingForResponse: Bool

    public init(threadId: String, projectId: String?, waitingForResponse: Bool) {
        self.threadId = threadId
        self.projectId = projectId
        self.waitingForResponse = waitingForResponse
    }
}

/// Envelope for `/api/chat/active-runs`. Only `runs` is needed here; the sibling
/// `activeThreadIds` array is ignored.
public struct ActiveChatRunsResponse: Decodable, Sendable {
    public let runs: [ActiveChatRun]

    public init(runs: [ActiveChatRun]) {
        self.runs = runs
    }
}

/// The badge vocabulary shared with the desktop project rail. Ordered so the
/// most attention-worthy state compares highest for sorting.
public enum ProjectActivity: Sendable, Hashable {
    /// A model is actively working on one of the project's threads.
    case working
    /// A run is blocked waiting for the user (a pending question).
    case waiting
    /// A live/unclosed session exists but nothing is running.
    case idle

    /// Per-project activity, mirroring the web client's `projectIdsByActivity`:
    /// waiting ▸ working ▸ idle ▸ none. `runs` is the active-run feed;
    /// `chatSessionCount` is the project's count of unarchived sessions.
    public static func derive(runs: [ActiveChatRun], chatSessionCount: Int?) -> ProjectActivity? {
        var working = false
        for run in runs {
            if run.waitingForResponse { return .waiting }
            working = true
        }
        if working { return .working }
        if (chatSessionCount ?? 0) > 0 { return .idle }
        return nil
    }
}

/// A project paired with its derived activity badge. Built by `assemble` and
/// consumed directly by the projects list UI.
public struct ProjectListItem: Identifiable, Hashable, Sendable {
    public let project: Project
    public let activity: ProjectActivity?

    public var id: String { project.id }
    /// Any live/unclosed or running session — the "active" group that sorts first.
    public var isActive: Bool { activity != nil }

    public init(project: Project, activity: ProjectActivity?) {
        self.project = project
        self.activity = activity
    }

    /// Derive each project's activity from the run feed, then sort: active
    /// sessions first, then case-insensitive A→Z by name. Orphan runs (nil or
    /// unknown `projectId`) can't tint any project and are dropped.
    public static func assemble(projects: [Project], runs: [ActiveChatRun]) -> [ProjectListItem] {
        var runsByProject: [String: [ActiveChatRun]] = [:]
        for run in runs {
            guard let projectId = run.projectId else { continue }
            runsByProject[projectId, default: []].append(run)
        }

        let items = projects.map { project in
            ProjectListItem(
                project: project,
                activity: ProjectActivity.derive(
                    runs: runsByProject[project.id] ?? [],
                    chatSessionCount: project.chatSessionCount))
        }

        return items.sorted { lhs, rhs in
            if lhs.isActive != rhs.isActive { return lhs.isActive }
            return lhs.project.name.localizedCaseInsensitiveCompare(rhs.project.name) == .orderedAscending
        }
    }
}
