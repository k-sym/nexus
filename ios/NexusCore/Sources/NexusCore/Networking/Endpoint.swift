import Foundation

/// A single backend request. Paths are the desktop's `/api/...` form verbatim;
/// `APIClient` joins them onto the configured base URL and attaches the bearer
/// unless `requiresAuth` is false.
public struct Endpoint: Sendable {
    public var path: String
    public var method: String
    public var queryItems: [URLQueryItem]
    public var headers: [String: String]
    public var body: Data?
    public var requiresAuth: Bool
    /// Whether a 409 from this endpoint means "a turn is already running"
    /// (`APIError.busy`). True everywhere by default because that is what 409
    /// means on the chat and assistant streams, where the mapping was written.
    /// The night-queue arm endpoint sets it false: there a 409 is the adapter
    /// saying the issue is closed or already queued, and flattening that into
    /// "Busy — another turn is already running" would answer a question nobody
    /// asked.
    public var conflictIsBusy: Bool

    public init(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        headers: [String: String] = [:],
        body: Data? = nil,
        requiresAuth: Bool = true,
        conflictIsBusy: Bool = true
    ) {
        self.path = path
        self.method = method
        self.queryItems = queryItems
        self.headers = headers
        self.body = body
        self.requiresAuth = requiresAuth
        self.conflictIsBusy = conflictIsBusy
    }

    // MARK: M0 endpoints

    /// Unauthenticated reachability probe → `{ status: "ok" }`.
    public static let health = Endpoint(path: "/api/health", requiresAuth: false)

    /// Authenticated token/data probe → `[Project]`.
    public static let projects = Endpoint(path: "/api/projects")

    // MARK: M1 read-only surfaces

    /// Jira mirror rows → `[Ticket]`.
    public static let tickets = Endpoint(path: "/api/tickets")

    /// Long-running operations → `ActivityResponse`.
    public static let activity = Endpoint(path: "/api/activity")

    /// Dashboard payload → `MissionStatus`.
    public static let missionControl = Endpoint(path: "/api/mission-control")

    /// Tasks for one project → `[ProjectTask]`.
    public static func projectTasks(_ projectId: String) -> Endpoint {
        Endpoint(path: "/api/projects/\(projectId)/tasks")
    }

    // MARK: M2 chat

    /// Threads for one project → `[ChatThread]`.
    public static func projectThreads(_ projectId: String) -> Endpoint {
        Endpoint(path: "/api/projects/\(projectId)/threads")
    }

    /// Create a thread → `ChatThread`.
    public static func createThread(_ projectId: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/projects/\(projectId)/threads", method: "POST", body: body)
    }

    /// Full thread + flattened messages → `ThreadDetail`.
    public static func thread(_ threadId: String) -> Endpoint {
        Endpoint(path: "/api/threads/\(threadId)")
    }

    /// Permanently delete a thread → `{ success }`.
    public static func deleteThread(_ threadId: String) -> Endpoint {
        Endpoint(path: "/api/threads/\(threadId)", method: "DELETE")
    }

    /// Summarize a thread into a memory, then remove it → `{ memoryId }`. Slow
    /// (model-generated summary); 400 when the thread has no meaningful history.
    public static func archiveThread(_ threadId: String) -> Endpoint {
        Endpoint(path: "/api/threads/\(threadId)/archive", method: "POST")
    }

    /// Send a message and stream the turn (NDJSON). Body is a `SendMessageRequest`.
    public static func threadStream(_ threadId: String, body: Data, confirmCancel: Bool) -> Endpoint {
        Endpoint(
            path: "/api/threads/\(threadId)/messages/stream",
            method: "POST",
            headers: confirmCancel ? ["X-Confirm-Cancel": "true"] : [:],
            body: body)
    }

    /// Abort the thread's active run. Body `{ source }`.
    public static func threadAbort(_ threadId: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/threads/\(threadId)/abort", method: "POST", body: body)
    }

    /// Toggle per-thread Supervise → `{ threadId, supervised }`. Body `{ supervised }`.
    public static func threadSupervise(_ threadId: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/threads/\(threadId)/supervise", method: "POST", body: body)
    }

    /// In-flight chat runs across all projects → `ActiveChatRunsResponse`
    /// (camelCase). Drives the per-project activity badge on the projects list.
    public static let chatActiveRuns = Endpoint(path: "/api/chat/active-runs")

    /// Curated + full model catalog → `ModelsResponse`.
    public static let models = Endpoint(path: "/api/models")

    // MARK: M3 writes

    public static func updateTask(_ taskId: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/tasks/\(taskId)", method: "PUT", body: body)
    }

    public static func projectMemories(_ projectId: String, query: String?) -> Endpoint {
        Endpoint(
            path: "/api/projects/\(projectId)/memories",
            queryItems: (query?.isEmpty == false) ? [URLQueryItem(name: "q", value: query)] : [])
    }
    public static func createMemory(_ projectId: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/projects/\(projectId)/memories", method: "POST", body: body)
    }
    public static func updateMemory(_ id: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/memories/\(id)", method: "PUT", body: body)
    }
    public static func deleteMemory(_ id: String) -> Endpoint {
        Endpoint(path: "/api/memories/\(id)", method: "DELETE")
    }

    // MARK: Ideas (#352, replaces Braindump)

    /// Idea Watcher rows → `[Idea]`. Non-terminal states by default;
    /// `all: true` includes graduated/discarded.
    public static func ideas(all: Bool = false) -> Endpoint {
        Endpoint(path: "/api/ideas", queryItems: all ? [URLQueryItem(name: "all", value: "1")] : [])
    }
    /// Quick capture → `Idea`. Body a `CreateIdeaRequest`.
    public static func createIdea(body: Data) -> Endpoint {
        Endpoint(path: "/api/ideas", method: "POST", body: body)
    }
    /// Partial update (title/seed/state/tags/target_repo) → `Idea`.
    public static func updateIdea(_ id: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/ideas/\(id)", method: "PATCH", body: body)
    }
    /// Hard delete (true junk; deliberate drops PATCH state=discarded) → `{ success }`.
    public static func deleteIdea(_ id: String) -> Endpoint {
        Endpoint(path: "/api/ideas/\(id)", method: "DELETE")
    }
    /// Ensure/attach the idea's dialogue session → `{ sessionId }` (camelCase —
    /// route-built object, not a DB row). Idempotent; flips parked → discussing.
    public static func ideaSession(_ id: String) -> Endpoint {
        Endpoint(path: "/api/ideas/\(id)/session", method: "POST")
    }

    // MARK: M4

    public static let approvals = Endpoint(path: "/api/approvals")
    public static let approvalsStream = Endpoint(path: "/api/approvals/stream")
    public static func decideApproval(_ toolCallId: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/approvals/\(toolCallId)/decision", method: "POST", body: body)
    }

    public static func gitDiff(_ projectId: String) -> Endpoint {
        Endpoint(path: "/api/projects/\(projectId)/git/diff")
    }

    public static func mondayItems(_ projectId: String) -> Endpoint {
        Endpoint(path: "/api/monday/projects/\(projectId)/items")
    }

    public static let settings = Endpoint(path: "/api/settings")
    public static func updateSettings(body: Data) -> Endpoint {
        Endpoint(path: "/api/settings", method: "PUT", body: body)
    }

    // MARK: Routines (read-only fleet status, baker-internal#82)

    /// Scheduled partner routine fleet → `RoutinesResponse`.
    public static let routines = Endpoint(path: "/api/routines")

    /// One routine's status + recent log tail → `Routine` (with `logTail`).
    public static func routineDetail(_ name: String) -> Endpoint {
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? name
        return Endpoint(path: "/api/routines/\(encoded)")
    }

    // MARK: Night queue (read-only board, baker-internal#111)

    /// The overnight runner's board → `NightQueueResponse`.
    public static func nightQueue(nights: Int? = nil) -> Endpoint {
        Endpoint(path: "/api/night-queue" + (nights.map { "?nights=\($0)" } ?? ""))
    }

    /// One night with the planner's decisions → `Night` (with `plan`).
    public static func night(_ nightId: String) -> Endpoint {
        let encoded = nightId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? nightId
        return Endpoint(path: "/api/night-queue/nights/\(encoded)")
    }

    // MARK: Readiness workshop (baker-internal#111)

    /// The readiness bar the 01:00 planner enforces → `ReadinessResponse`.
    /// Served, never hand-copied into Swift: `night-queue/readiness.py` is the
    /// single definition, and a second copy here would drift from the thing
    /// that actually decides the night.
    public static let nightQueueReadiness = Endpoint(path: "/api/night-queue/readiness")

    /// Every open issue with the reason it could not be armed →
    /// `NightQueueCandidatesResponse`. Two gh reads and no model call.
    public static let nightQueueCandidates = Endpoint(path: "/api/night-queue/candidates")

    /// Judge ONE issue against the bar → `AssessmentResponse`. A POST because
    /// it costs a model call and takes tens of seconds. Body `{ repo, number }`.
    public static func assessIssue(body: Data) -> Endpoint {
        Endpoint(path: "/api/night-queue/assess", method: "POST", body: body)
    }

    /// Open a Partner conversation about one issue → `DiscussResponse`. Body
    /// `{ repo, number, draft? }`, where `draft` is the working text on screen
    /// so the conversation starts from it. Writes nothing to GitHub.
    public static func discussIssue(body: Data) -> Endpoint {
        Endpoint(path: "/api/night-queue/discuss", method: "POST", body: body)
    }

    /// THE write: post the readiness comment, then mint the `night-queue`
    /// label. Body `{ repo, number, comment }`.
    ///
    /// `conflictIsBusy: false` — the adapter's 409 here is "the issue is
    /// closed" or "this issue is already queued", both of which the reader
    /// needs verbatim.
    public static func armIssue(body: Data) -> Endpoint {
        Endpoint(path: "/api/night-queue/arm", method: "POST", body: body,
                 conflictIsBusy: false)
    }

    // MARK: Drafts (outbound approval queue, baker-internal#42)

    /// Pending outbound drafts → `DraftsResponse`.
    public static func drafts(status: String = "pending") -> Endpoint {
        Endpoint(path: "/api/drafts?status=\(status)")
    }

    /// One draft with its full body → `OutboundDraftDetail`.
    public static func draftDetail(_ id: String) -> Endpoint {
        Endpoint(path: "/api/drafts/\(id)")
    }

    /// Approve AND send. There is no separate send call by design: an approved
    /// but unsent draft goes stale in 15 minutes and rots the queue.
    public static func approveDraft(_ id: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/drafts/\(id)/approve", method: "POST", body: body)
    }

    /// Edit-before-send (baker-internal#97): PATCH the body; the draft returns
    /// to pending, so a prior approval can never be inherited.
    public static func editDraft(_ id: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/drafts/\(id)", method: "PATCH", body: body)
    }

    public static func rejectDraft(_ id: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/drafts/\(id)/reject", method: "POST", body: body)
    }

    // MARK: M6 assistant

    /// Merged local + adoptable-remote Hermes sessions → `AssistantSessionsResponse`.
    public static let assistantSessions = Endpoint(path: "/api/assistant/sessions")

    /// Create a local assistant session → `AssistantSession`. Body `{ title? }`.
    public static func createAssistantSession(body: Data) -> Endpoint {
        Endpoint(path: "/api/assistant/sessions", method: "POST", body: body)
    }

    /// Adopt a remote Hermes session as a local one → `AssistantSessionDetail`.
    /// Body `{ remoteSessionId }` (the un-prefixed Hermes id).
    public static func importAssistantSession(body: Data) -> Endpoint {
        Endpoint(path: "/api/assistant/sessions/import", method: "POST", body: body)
    }

    /// One session + its transcript → `AssistantSessionDetail`.
    public static func assistantSession(_ id: String) -> Endpoint {
        Endpoint(path: "/api/assistant/sessions/\(id)")
    }

    /// Rename or soft-archive a session → `AssistantSession`. Body
    /// `{ title? }` or `{ archived: true }`.
    public static func patchAssistantSession(_ id: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/assistant/sessions/\(id)", method: "PATCH", body: body)
    }

    /// Hard-delete a session (also stops/removes the remote) → `{ ok }`.
    public static func deleteAssistantSession(_ id: String) -> Endpoint {
        Endpoint(path: "/api/assistant/sessions/\(id)", method: "DELETE")
    }

    /// Send a message and stream the turn (NDJSON). Body an `AssistantStreamRequest`.
    /// No `X-Confirm-Cancel` — the assistant path has no busy gate.
    public static func assistantSessionStream(_ id: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/assistant/sessions/\(id)/messages/stream", method: "POST", body: body)
    }

    /// Abort the latest running assistant run (global, not session-scoped).
    public static let assistantAbort = Endpoint(path: "/api/assistant/abort", method: "POST")

    /// Assistant model catalog (#75) — `{models}` in the `GET /api/models` shape.
    public static let assistantModels = Endpoint(path: "/api/assistant/models")

    // MARK: M6 assistant — background handoff (Phase B)

    /// Hand a turn off to a durable server-side run → `{ run }`. Body an
    /// `AssistantStreamRequest` (`{ content }`). Unlike the stream, this returns
    /// immediately; the run keeps executing against Hermes after we disconnect.
    public static func startAssistantRun(_ id: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/assistant/sessions/\(id)/runs", method: "POST", body: body)
    }

    /// Poll one background run's status → `{ run }`.
    public static func assistantRun(_ runId: String) -> Endpoint {
        Endpoint(path: "/api/assistant/runs/\(runId)")
    }

    /// Request a background run stop (marks it cancelling) → `{ ok }`.
    public static func stopAssistantRun(_ runId: String) -> Endpoint {
        Endpoint(path: "/api/assistant/runs/\(runId)/stop", method: "POST")
    }

    /// Reconcile all in-flight background runs against Hermes → `{ updated }`.
    /// Global, not session-scoped; the caller reloads the session afterwards to
    /// pull the freshened transcript.
    public static let assistantSync = Endpoint(path: "/api/assistant/sync", method: "POST")

    // MARK: M5 push

    public static func registerDevice(body: Data) -> Endpoint {
        Endpoint(path: "/api/devices", method: "POST", body: body)
    }
    public static func deleteDevice(_ token: String) -> Endpoint {
        let encoded = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? token
        return Endpoint(path: "/api/devices/\(encoded)", method: "DELETE")
    }
}
