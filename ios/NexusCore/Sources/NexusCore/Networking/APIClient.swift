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
        try Self.validate(status: http.statusCode, data: data)
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

    private static func validate(status: Int, data: Data) throws {
        switch status {
        case 200..<300:
            return
        case 401:
            throw APIError.unauthorized
        case 409:
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

    @discardableResult
    public func updateTask(id: String, status: String) async throws -> ProjectTask {
        let body = try JSONEncoder().encode(UpdateTaskRequest(status: status))
        return try await request(.updateTask(id, body: body))
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

    public func braindump() async throws -> [BraindumpIdea] {
        try await request(.braindump)
    }

    public func createBraindump(title: String, body: String? = nil) async throws {
        let data = try JSONEncoder().encode(CreateBraindumpRequest(title: title, body: body))
        _ = try await requestData(.createBraindump(body: data))
    }

    public func updateBraindump(id: String, patch: UpdateBraindumpRequest) async throws {
        let data = try JSONEncoder().encode(patch)
        _ = try await requestData(.updateBraindump(id, body: data))
    }

    public func deleteBraindump(id: String) async throws {
        _ = try await requestData(.deleteBraindump(id))
    }

    public func missions(projectId: String) async throws -> [Mission] {
        try await request(.projectMissions(projectId))
    }

    /// `action` ∈ resume | pause | stop.
    public func missionAction(id: String, action: String) async throws {
        _ = try await requestData(.missionAction(id, action))
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
