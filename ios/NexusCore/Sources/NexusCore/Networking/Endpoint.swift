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
}
