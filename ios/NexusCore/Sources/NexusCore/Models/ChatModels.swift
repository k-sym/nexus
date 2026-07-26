import Foundation

/// Mirror of `ChatThread` in `src/shared/index.ts`. Decoded with the PLAIN
/// decoder (`nexusCamel`) + explicit CodingKeys — because the thread-detail
/// response also carries tool `args` (arbitrary JSON) that must not pass through
/// `.convertFromSnakeCase`.
public struct ChatThread: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let gitBranch: String?
    public let createdAt: String
    public let updatedAt: String
    public let archivedAt: String?

    enum CodingKeys: String, CodingKey {
        case id
        case projectId = "project_id"
        case title
        case gitBranch = "git_branch"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case archivedAt = "archived_at"
    }
}

/// `GET /api/threads/:id` → the thread plus its flattened, persisted messages.
public struct ThreadDetail: Decodable, Sendable {
    public let thread: ChatThread
    public let cwd: String?
    public let messages: [PersistedMessage]
}

/// One flattened persisted message (see `flattenEntries` in
/// `src/backend/routes/chat.ts`). Heterogeneous by `role`
/// (`user` | `assistant` | `toolResult`); fields not relevant to a role are nil.
public struct PersistedMessage: Decodable, Identifiable, Sendable {
    public let id: String
    public let role: String
    public let content: String?
    public let thinking: String?
    public let toolCalls: [PersistedToolCall]?
    public let model: String?
    public let provider: String?
    public let isError: Bool?
    public let toolCallId: String?
    public let toolName: String?

    enum CodingKeys: String, CodingKey {
        case id, role, content, thinking
        case toolCalls = "tool_calls"
        case model, provider, isError, toolCallId, toolName
    }
}

/// A tool call embedded in a persisted assistant message. `args` stays a raw
/// `JSONValue` so nested snake_case keys survive.
public struct PersistedToolCall: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let args: JSONValue?
    public let status: String
    public let result: String?
}

/// Body for `POST /api/projects/:id/threads`.
public struct CreateThreadRequest: Encodable, Sendable {
    public let title: String?
    public init(title: String?) { self.title = title }
}

/// Body for the send-message stream endpoints. camelCase on the wire
/// (`modelKey`), so encode with a plain `JSONEncoder`.
public struct SendMessageRequest: Encodable, Sendable {
    public let content: String
    public let modelKey: String?

    public init(content: String, modelKey: String? = nil) {
        self.content = content
        self.modelKey = modelKey
    }
}

/// Normalized context-window usage from a `context_usage` event. Mirrors
/// `normalizeContextUsage` in usePiStream.ts.
public struct ContextUsage: Hashable, Sendable {
    public let tokens: Int?
    public let contextWindow: Int
    public let percent: Double?

    /// Build from a `usage` JSON object; nil when the window is missing/invalid.
    public init?(_ value: JSONValue?) {
        guard let value,
              let window = value["contextWindow"]?.int, window > 0 else { return nil }
        self.contextWindow = window
        self.tokens = value["tokens"]?.int
        self.percent = value["percent"]?.double
    }
}
