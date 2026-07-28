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

    public init(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        headers: [String: String] = [:],
        body: Data? = nil,
        requiresAuth: Bool = true
    ) {
        self.path = path
        self.method = method
        self.queryItems = queryItems
        self.headers = headers
        self.body = body
        self.requiresAuth = requiresAuth
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

    public static let braindump = Endpoint(path: "/api/braindump")
    public static func createBraindump(body: Data) -> Endpoint {
        Endpoint(path: "/api/braindump", method: "POST", body: body)
    }
    public static func updateBraindump(_ id: String, body: Data) -> Endpoint {
        Endpoint(path: "/api/braindump/\(id)", method: "PATCH", body: body)
    }
    public static func deleteBraindump(_ id: String) -> Endpoint {
        Endpoint(path: "/api/braindump/\(id)", method: "DELETE")
    }

    public static func projectMissions(_ projectId: String) -> Endpoint {
        Endpoint(path: "/api/projects/\(projectId)/missions")
    }
    public static func missionAction(_ id: String, _ action: String) -> Endpoint {
        Endpoint(path: "/api/missions/\(id)/\(action)", method: "POST")
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

    // MARK: M5 push

    public static func registerDevice(body: Data) -> Endpoint {
        Endpoint(path: "/api/devices", method: "POST", body: body)
    }
    public static func deleteDevice(_ token: String) -> Endpoint {
        let encoded = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? token
        return Endpoint(path: "/api/devices/\(encoded)", method: "DELETE")
    }
}
