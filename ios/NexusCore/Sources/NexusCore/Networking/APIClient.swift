import Foundation

/// The single choke point for backend HTTP. An `actor` so its base URL and
/// networking are isolated; view models on `@MainActor` simply `await` it.
/// Mirrors the desktop's `apiFetch`: attach `Authorization: Bearer <token>` to
/// every `/api/*` call except unauthenticated probes like `/api/health`.
public actor APIClient {
    private var baseURL: URL?
    private let tokenStore: TokenStore
    private let session: URLSession
    private let decoder: JSONDecoder
    /// Plain decoder (no key conversion) for chat/stream types, which carry
    /// arbitrary JSON (`args`) that `.convertFromSnakeCase` would corrupt.
    private let plainDecoder: JSONDecoder

    public init(tokenStore: TokenStore = .standard, session: URLSession = .shared) {
        self.tokenStore = tokenStore
        self.session = session
        self.decoder = .nexusREST
        self.plainDecoder = .nexusCamel
    }

    /// Point the client at a backend base origin (e.g.
    /// `https://baker-pro.tailnet.ts.net:8444`). Pass `nil` to disconnect.
    public func configure(baseURL: URL?) {
        self.baseURL = baseURL
    }

    public func currentBaseURL() -> URL? { baseURL }

    // MARK: Generic request

    public func request<T: Decodable>(
        _ endpoint: Endpoint, as type: T.Type = T.self, decoder: JSONDecoder? = nil
    ) async throws -> T {
        let data = try await requestData(endpoint)
        do {
            return try (decoder ?? self.decoder).decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    private func buildRequest(_ endpoint: Endpoint) throws -> URLRequest {
        guard let baseURL else { throw APIError.notConfigured }
        guard var comps = URLComponents(string: baseURL.absoluteString + endpoint.path) else {
            throw APIError.notConfigured
        }
        if !endpoint.queryItems.isEmpty { comps.queryItems = endpoint.queryItems }
        guard let url = comps.url else { throw APIError.notConfigured }

        var req = URLRequest(url: url)
        req.httpMethod = endpoint.method
        for (key, value) in endpoint.headers { req.setValue(value, forHTTPHeaderField: key) }
        if let body = endpoint.body {
            req.httpBody = body
            if req.value(forHTTPHeaderField: "Content-Type") == nil {
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
        }
        if endpoint.requiresAuth, let token = tokenStore.token(), !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    @discardableResult
    public func requestData(_ endpoint: Endpoint) async throws -> Data {
        let req = try buildRequest(endpoint)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let urlError as URLError {
            throw APIError.transport(urlError)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(URLError(.badServerResponse))
        }
        try Self.validate(status: http.statusCode, data: data,
                          conflictIsBusy: endpoint.conflictIsBusy)
        return data
    }

    /// Open an NDJSON event stream (chat/assistant turns). Validates the HTTP
    /// status BEFORE yielding lines: 409 → `.busy`, 401 → `.unauthorized`. Each
    /// yielded value is one parsed JSON line. Cancelling the consuming task (or
    /// the stream terminating) cancels the underlying request.
    public func events(_ endpoint: Endpoint) throws -> AsyncThrowingStream<JSONValue, Error> {
        let request = try buildRequest(endpoint)
        let session = self.session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw APIError.transport(URLError(.badServerResponse))
                    }
                    guard (200..<300).contains(http.statusCode) else {
                        var data = Data()
                        for try await byte in bytes { data.append(byte) }
                        try APIClient.validate(status: http.statusCode, data: data)
                        continuation.finish()
                        return
                    }
                    var buffer = Data()
                    for try await byte in bytes {
                        if byte == 0x0A {
                            if !buffer.isEmpty {
                                if let value = JSONValue.parse(buffer) { continuation.yield(value) }
                                buffer.removeAll(keepingCapacity: true)
                            }
                        } else if byte != 0x0D {
                            buffer.append(byte)
                        }
                    }
                    if !buffer.isEmpty, let value = JSONValue.parse(buffer) {
                        continuation.yield(value)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch let error as URLError {
                    continuation.finish(throwing: APIError.transport(error))
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func validate(status: Int, data: Data,
                                 conflictIsBusy: Bool = true) throws {
        switch status {
        case 200..<300:
            return
        case 401:
            throw APIError.unauthorized
        case 409 where conflictIsBusy:
            throw APIError.busy(BusyInfo.decode(from: data))
        default:
            let message = (try? JSONDecoder.nexusCamel.decode(ServerError.self, from: data))?.error
            throw APIError.server(status: status, message: message)
        }
    }

    // MARK: Typed convenience (M0)

    /// Unauthenticated reachability check. `true` iff the backend returns
    /// `{ status: "ok" }`.
    public func health() async throws -> Bool {
        let result: HealthResponse = try await request(.health)
        return result.status == "ok"
    }

    /// Authenticated data probe; also validates the bearer token.
    public func projects() async throws -> [Project] {
        try await request(.projects)
    }

    // MARK: Typed convenience (M1)

    public func tickets() async throws -> [Ticket] {
        try await request(.tickets)
    }

    public func activity() async throws -> ActivityResponse {
        try await request(.activity)
    }

    public func missionControl() async throws -> MissionStatus {
        try await request(.missionControl)
    }

    public func tasks(projectId: String) async throws -> [ProjectTask] {
        try await request(.projectTasks(projectId))
    }

    // MARK: Chat (M2)

    public func projectThreads(projectId: String) async throws -> [ChatThread] {
        try await request(.projectThreads(projectId), decoder: plainDecoder)
    }

    public func createThread(projectId: String, title: String? = nil) async throws -> ChatThread {
        let body = try JSONEncoder().encode(CreateThreadRequest(title: title))
        return try await request(.createThread(projectId, body: body), decoder: plainDecoder)
    }

    public func threadDetail(threadId: String) async throws -> ThreadDetail {
        try await request(.thread(threadId), decoder: plainDecoder)
    }

    /// Permanently delete a thread.
    public func deleteThread(threadId: String) async throws {
        _ = try await requestData(.deleteThread(threadId))
    }

    /// Summarize the thread into a memory then remove it. Slow (a model writes
    /// the summary); throws `.server(400)` when there's no meaningful history.
    public func archiveThread(threadId: String) async throws {
        _ = try await requestData(.archiveThread(threadId))
    }

    public func abortThread(threadId: String, source: String = "user") async throws {
        let body = try JSONEncoder().encode(["source": source])
        _ = try await requestData(.threadAbort(threadId, body: body))
    }

    /// Toggle per-thread Supervise (tool-gate every call). Returns confirmed state.
    @discardableResult
    public func setSupervised(threadId: String, supervised: Bool) async throws -> Bool {
        let body = try JSONEncoder().encode(["supervised": supervised])
        let res: SuperviseResponse = try await request(.threadSupervise(threadId, body: body), decoder: plainDecoder)
        return res.supervised
    }

    /// In-flight chat runs across all projects. Feeds the projects list's
    /// activity badge (working/waiting). camelCase payload → `plainDecoder`.
    public func activeChatRuns() async throws -> [ActiveChatRun] {
        let res: ActiveChatRunsResponse = try await request(.chatActiveRuns, decoder: plainDecoder)
        return res.runs
    }

    /// The curated model list for the per-thread picker (`modelKey` = provider/id).
    public func models() async throws -> [Model] {
        let res: ModelsResponse = try await request(.models, decoder: plainDecoder)
        return res.models
    }

    /// Send a message and stream the turn. Throws `.busy` synchronously if the
    /// thread/model/project is already running (retry with `confirmCancel: true`).
    public func streamThreadMessage(
        threadId: String, content: String, modelKey: String? = nil, confirmCancel: Bool = false
    ) throws -> AsyncThrowingStream<JSONValue, Error> {
        let body = try JSONEncoder().encode(SendMessageRequest(content: content, modelKey: modelKey))
        return try events(.threadStream(threadId, body: body, confirmCancel: confirmCancel))
    }

    // MARK: Writes (M3)

    /// Patch a task. Fields left nil on `patch` are omitted from the body and
    /// the backend leaves those columns untouched, so this is safe to call
    /// with only the fields the user actually changed.
    @discardableResult
    public func updateTask(id: String, patch: UpdateTaskRequest) async throws -> ProjectTask {
        let body = try JSONEncoder().encode(patch)
        return try await request(.updateTask(id, body: body))
    }

    /// Status-only convenience — the Kanban drag/move path.
    @discardableResult
    public func updateTask(id: String, status: String) async throws -> ProjectTask {
        try await updateTask(id: id, patch: UpdateTaskRequest(status: status))
    }

    public func memories(projectId: String, query: String? = nil) async throws -> [MemoryRecord] {
        try await request(.projectMemories(projectId, query: query))
    }

    public func createMemory(projectId: String, content: String, category: String? = nil) async throws {
        let body = try JSONEncoder().encode(CreateMemoryRequest(content: content, category: category))
        _ = try await requestData(.createMemory(projectId, body: body))
    }

    public func updateMemory(id: String, content: String) async throws {
        let body = try JSONEncoder().encode(UpdateMemoryRequest(content: content))
        _ = try await requestData(.updateMemory(id, body: body))
    }

    public func deleteMemory(id: String) async throws {
        _ = try await requestData(.deleteMemory(id))
    }

    // MARK: Ideas (#352, replaces Braindump)

    /// Idea Watcher rows, newest-updated first. Non-terminal states by default;
    /// `includeDone: true` fetches `?all=1` (graduated/discarded too).
    public func ideas(includeDone: Bool = false) async throws -> [Idea] {
        try await request(.ideas(all: includeDone))
    }

    /// Quick capture: park a one-liner (plus optional seed notes).
    @discardableResult
    public func createIdea(title: String, seed: String? = nil) async throws -> Idea {
        let data = try JSONEncoder().encode(CreateIdeaRequest(title: title, seed: seed))
        return try await request(.createIdea(body: data))
    }

    @discardableResult
    public func updateIdea(id: String, patch: UpdateIdeaRequest) async throws -> Idea {
        let data = try JSONEncoder().encode(patch)
        return try await request(.updateIdea(id, body: data))
    }

    /// Hard delete — for true junk. The deliberate drop is
    /// `updateIdea(patch: .init(state: .discarded))`.
    public func deleteIdea(id: String) async throws {
        _ = try await requestData(.deleteIdea(id))
    }

    /// Ensure the idea's dialogue session exists and return its id. Idempotent;
    /// the backend flips parked → discussing. Chat then flows through the
    /// ordinary assistant session routes (`AssistantChatEndpoint`).
    public func ideaSession(id: String) async throws -> String {
        let res: IdeaSessionResponse = try await request(.ideaSession(id))
        return res.sessionId
    }

    // MARK: M4

    /// Held NDJSON queue: one `snapshot`, then `pending`/`resolved`, with `\n`
    /// heartbeats. Holding it open marks the client "attached" server-side.
    public func approvalsStream() throws -> AsyncThrowingStream<JSONValue, Error> {
        try events(.approvalsStream)
    }

    public func decideApproval(toolCallId: String, action: String, reason: String? = nil) async throws {
        let body = try JSONEncoder().encode(ApprovalDecisionRequest(action: action, reason: reason))
        _ = try await requestData(.decideApproval(toolCallId, body: body))
    }

    public func gitDiff(projectId: String) async throws -> GitDiffState {
        try await request(.gitDiff(projectId))
    }

    public func mondayItems(projectId: String) async throws -> [MondayItem] {
        let response: MondayItemsResponse = try await request(.mondayItems(projectId))
        return response.items
    }

    /// Full config with secrets masked (`••••••••`). Kept as a raw tree so the
    /// editor can PUT back only the leaves it changed.
    public func settings() async throws -> JSONValue {
        try await request(.settings, decoder: plainDecoder)
    }

    @discardableResult
    public func updateSettings(_ config: JSONValue) async throws -> JSONValue {
        let body = try JSONEncoder().encode(config)
        return try await request(.updateSettings(body: body), decoder: plainDecoder)
    }

    // MARK: Routines (baker-internal#82)

    /// The scheduled partner routine fleet — read-only observability. Snake_case
    /// payload → default decoder. Fail-soft shapes (`configured: false`,
    /// `error`) come through as data, not thrown errors.
    public func routines() async throws -> RoutinesResponse {
        try await request(.routines)
    }

    /// One routine's status plus its recent log tail.
    public func routineDetail(name: String) async throws -> Routine {
        try await request(.routineDetail(name))
    }

    // MARK: Night queue (baker-internal#111)

    /// The overnight runner's board — what it did, what is queued, and which
    /// of its PRs are still open. Fail-soft shapes (`configured: false`,
    /// `available: false`, per-section errors) come through as data, not as
    /// thrown errors — same contract as `routines()`.
    public func nightQueue(nights: Int? = nil) async throws -> NightQueueResponse {
        try await request(.nightQueue(nights: nights))
    }

    /// One night plus the planner's decisions for it.
    public func night(id: String) async throws -> Night {
        try await request(.night(id))
    }

    // MARK: Readiness workshop (baker-internal#111)

    /// The readiness bar, as the adapter defines it. Fail-soft like the board:
    /// `configured: false` and `error` arrive as data, not thrown errors.
    public func nightQueueReadiness() async throws -> ReadinessResponse {
        try await request(.nightQueueReadiness)
    }

    /// Every open issue with its blocker. Blocked ones come back WITH their
    /// reason rather than filtered out, and the UI shows them.
    public func nightQueueCandidates() async throws -> NightQueueCandidatesResponse {
        try await request(.nightQueueCandidates)
    }

    /// Judge one issue against the bar. Costs a model call and takes tens of
    /// seconds, so callers must assume the reader can move on mid-flight —
    /// check `AssessmentResponse.describes(_:)` before showing or arming it.
    /// Throws on failure: an unjudgeable issue must never render as a clean one.
    public func assessIssue(repo: String, number: Int) async throws -> AssessmentResponse {
        let body = try JSONSerialization.data(withJSONObject: ["repo": repo, "number": number])
        return try await request(.assessIssue(body: body))
    }

    /// Post the readiness comment and mint the label — the moment an issue
    /// joins tonight's queue for an unattended agent.
    ///
    /// Throws on refusal, and the thrown message is the ADAPTER's own wording,
    /// shown verbatim: 403 standing policy, 409 closed or already queued, 400
    /// a spec it refused, and a 502 that says the comment was posted but the
    /// label was not. That last one is a half-done state, and flattening it
    /// would be the one lie this surface cannot afford.
    @discardableResult
    public func armIssue(repo: String, number: Int, comment: String,
                         decidedBy: String = "ios-workshop") async throws -> ArmResponse {
        let body = try JSONSerialization.data(withJSONObject: [
            "repo": repo, "number": number, "comment": comment, "decided_by": decidedBy,
        ])
        return try await request(.armIssue(body: body))
    }

    // MARK: Drafts (baker-internal#42)

    /// The outbound draft queue. Fail-soft shapes (`configured: false`, `error`)
    /// come through as data, not thrown errors — same contract as `routines()`.
    public func drafts(status: String = "pending") async throws -> DraftsResponse {
        try await request(.drafts(status: status))
    }

    /// One draft including its full body — fetched before Send is offered.
    public func draftDetail(id: String) async throws -> OutboundDraftDetail {
        try await request(.draftDetail(id))
    }

    /// Approve and send. Throws on refusal; the thrown message is the adapter's
    /// reason (already decided, content changed, send failed) and is shown verbatim.
    @discardableResult
    public func approveDraft(id: String, by: String = "ios") async throws -> DraftDecision {
        let body = try JSONSerialization.data(withJSONObject: ["by": by])
        return try await request(.approveDraft(id, body: body))
    }

    /// Replace a draft's body (#97). The response is the full updated detail —
    /// pending again, `edited` set — which the sheet swaps in wholesale so what
    /// is displayed is exactly what the server now holds.
    public func editDraft(id: String, body newBody: String, by: String = "ios") async throws -> OutboundDraftDetail {
        let payload = try JSONSerialization.data(withJSONObject: ["body": newBody, "by": by])
        return try await request(.editDraft(id, body: payload))
    }

    @discardableResult
    public func rejectDraft(id: String, by: String = "ios", note: String? = nil) async throws -> DraftDecision {
        var payload: [String: String] = ["by": by]
        if let note, !note.isEmpty { payload["note"] = note }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await request(.rejectDraft(id, body: body))
    }

    // MARK: Assistant (M6)

    /// Merged local + adoptable-remote Hermes sessions. Mixed snake/camel keys →
    /// `plainDecoder` + explicit CodingKeys on `AssistantSession`.
    public func assistantSessions() async throws -> [AssistantSession] {
        let res: AssistantSessionsResponse = try await request(.assistantSessions, decoder: plainDecoder)
        return res.sessions
    }

    public func createAssistantSession(title: String? = nil) async throws -> AssistantSession {
        let body = try JSONEncoder().encode(CreateAssistantSessionRequest(title: title))
        return try await request(.createAssistantSession(body: body), decoder: plainDecoder)
    }

    /// Adopt a remote Hermes session into a local one. Pass the un-prefixed id
    /// (`AssistantSession.adoptableRemoteId`).
    public func importAssistantSession(remoteSessionId: String) async throws -> AssistantSessionDetail {
        let body = try JSONEncoder().encode(ImportAssistantSessionRequest(remoteSessionId: remoteSessionId))
        return try await request(.importAssistantSession(body: body), decoder: plainDecoder)
    }

    public func assistantSessionDetail(sessionId: String) async throws -> AssistantSessionDetail {
        try await request(.assistantSession(sessionId), decoder: plainDecoder)
    }

    @discardableResult
    public func patchAssistantSession(sessionId: String, title: String? = nil, archived: Bool? = nil) async throws -> AssistantSession {
        let body = try JSONEncoder().encode(PatchAssistantSessionRequest(title: title, archived: archived))
        return try await request(.patchAssistantSession(sessionId, body: body), decoder: plainDecoder)
    }

    /// Hard-delete a session (backend also stops/deletes the remote).
    public func deleteAssistantSession(sessionId: String) async throws {
        _ = try await requestData(.deleteAssistantSession(sessionId))
    }

    /// Send a message and stream the turn. No busy gate on the assistant path, so
    /// this never throws `.busy`. Image attachments route through the backend's
    /// (non-streaming) vision path, surfaced as a single text delta.
    public func streamAssistantMessage(
        sessionId: String, content: String, attachments: [AssistantAttachment] = [], modelKey: String? = nil
    ) throws -> AsyncThrowingStream<JSONValue, Error> {
        let body = try JSONEncoder().encode(AssistantStreamRequest(content: content, attachments: attachments, modelKey: modelKey))
        return try events(.assistantSessionStream(sessionId, body: body))
    }

    /// The assistant model catalog (#75) — the partner adapter's allowlist in the
    /// same `{models: [...]}` shape as `GET /api/models`, so the shared picker
    /// decodes it unchanged. Empty when the backend/adapter predates the feature.
    public func assistantModels() async throws -> [Model] {
        let res: ModelsResponse = try await request(.assistantModels, decoder: plainDecoder)
        return res.models
    }

    /// Abort the latest running assistant run (global).
    public func abortAssistant() async throws {
        _ = try await requestData(.assistantAbort)
    }

    // MARK: Assistant background handoff (M6 Phase B)

    /// Hand a turn off to a durable server-side run. The run executes against
    /// Hermes and outlives this connection; poll `syncAssistant()` + reload the
    /// session to see its progress. Throws `.server(400)` if Hermes isn't
    /// configured or the content is empty.
    public func startAssistantRun(
        sessionId: String, content: String, attachments: [AssistantAttachment] = []
    ) async throws -> AssistantRun {
        let body = try JSONEncoder().encode(AssistantStreamRequest(content: content, attachments: attachments))
        let res: AssistantRunResponse = try await request(.startAssistantRun(sessionId, body: body), decoder: plainDecoder)
        guard let run = res.run else {
            throw APIError.server(status: 502, message: "Background run did not start.")
        }
        return run
    }

    /// Poll one background run's current status.
    public func assistantRun(runId: String) async throws -> AssistantRun {
        let res: AssistantRunResponse = try await request(.assistantRun(runId), decoder: plainDecoder)
        guard let run = res.run else {
            throw APIError.server(status: 404, message: "Run not found.")
        }
        return run
    }

    /// Ask a background run to stop (marks it cancelling). Session-scoped, unlike
    /// the global `abortAssistant()`.
    public func stopAssistantRun(runId: String) async throws {
        _ = try await requestData(.stopAssistantRun(runId))
    }

    /// Reconcile all in-flight background runs against Hermes; returns how many
    /// changed status. Reload the session afterwards for the freshened transcript.
    @discardableResult
    public func syncAssistant() async throws -> Int {
        let res: AssistantSyncResponse = try await request(.assistantSync, decoder: plainDecoder)
        return res.updated
    }

    // MARK: M5 push

    /// Register (or refresh) this device's APNs token. `env` is "sandbox" or
    /// "production" — which APNs host the backend should use.
    public func registerDevice(token: String, env: String) async throws {
        let body = try JSONEncoder().encode(["token": token, "platform": "ios", "env": env])
        _ = try await requestData(.registerDevice(body: body))
    }

    public func deleteDevice(token: String) async throws {
        _ = try await requestData(.deleteDevice(token))
    }
}

public struct HealthResponse: Decodable, Sendable {
    public let status: String
}

/// Global error envelope: the backend's error handler returns `{ error: msg }`.
struct ServerError: Decodable {
    let error: String?
}
