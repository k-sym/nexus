import Foundation

/// One row from `GET /api/assistant/sessions` (and the create/patch result).
///
/// The payload mixes snake_case DB columns (`remote_session_id`, `updated_at`)
/// with camelCase additions (`remoteOnly`, `latestRun`, `source`), so it decodes
/// with the PLAIN decoder + explicit CodingKeys (same rule as `ChatThread`) —
/// `.convertFromSnakeCase` would mangle it. A manual `init(from:)` tolerates the
/// three shapes this type arrives in:
///  - list rows (local): full row + `remoteOnly:false` + `latestRun`
///  - list rows (remote/adoptable): synthetic `remote:<id>` id, `remoteOnly:true`,
///    `source`, null timestamps possible
///  - create/patch result: a bare DB row with no `remoteOnly`/`latestRun`/`source`
public struct AssistantSession: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let status: String
    /// True for adoptable remote-only Hermes rows (not yet a local session).
    public let remoteOnly: Bool
    /// Only present on remote rows: `api_server` | `tui` | `cli`.
    public let source: String?
    /// The un-prefixed Hermes session id (remote rows) or the local pointer to it.
    public let remoteSessionId: String?
    public let updatedAt: String?
    public let latestRun: AssistantRun?

    enum CodingKeys: String, CodingKey {
        case id, title, status, source, latestRun
        case remoteOnly
        case remoteSessionId = "remote_session_id"
        case updatedAt = "updated_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "Untitled"
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "idle"
        remoteOnly = try c.decodeIfPresent(Bool.self, forKey: .remoteOnly) ?? false
        source = try c.decodeIfPresent(String.self, forKey: .source)
        remoteSessionId = try c.decodeIfPresent(String.self, forKey: .remoteSessionId)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        latestRun = try c.decodeIfPresent(AssistantRun.self, forKey: .latestRun)
    }

    /// Memberwise init for tests/previews.
    public init(
        id: String, title: String, status: String = "idle", remoteOnly: Bool = false,
        source: String? = nil, remoteSessionId: String? = nil, updatedAt: String? = nil,
        latestRun: AssistantRun? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.remoteOnly = remoteOnly
        self.source = source
        self.remoteSessionId = remoteSessionId
        self.updatedAt = updatedAt
        self.latestRun = latestRun
    }

    /// The Hermes session id to POST to `/import`. Remote rows carry it directly;
    /// otherwise strip the synthetic `remote:` prefix off the id as a fallback.
    public var adoptableRemoteId: String {
        if let remoteSessionId, !remoteSessionId.isEmpty { return remoteSessionId }
        return id.hasPrefix("remote:") ? String(id.dropFirst("remote:".count)) : id
    }

    /// Uppercase source badge for remote-only rows: TUI / CLI / else REMOTE.
    public var sourceBadge: String? {
        guard remoteOnly else { return nil }
        switch source {
        case "tui": return "TUI"
        case "cli": return "CLI"
        default: return "REMOTE"
        }
    }

    /// Whether this session's latest run is still in flight.
    public var isRunning: Bool { latestRun?.isRunning ?? false }
}

/// The latest run attached to a session row (`publicRun`). Only the fields the
/// list + chat need are modelled; the payload carries more. camelCase-friendly
/// (`id`/`status` are literal), so the plain decoder reads it directly.
public struct AssistantRun: Decodable, Hashable, Sendable {
    public let id: String
    public let status: String

    public init(id: String, status: String) {
        self.id = id
        self.status = status
    }

    /// Mirrors the backend's `RUNNING_STATUSES` set.
    public var isRunning: Bool { status == "running" || status == "cancelling" }
}

/// A message from `GET /api/assistant/sessions/:id` (or `/import`). Renders from
/// Hermes `/messages` via `hermesMessagesToTranscript`, whose `id` is **optional**
/// — so this tolerant type keeps `id` optional and synthesizes an index-based id
/// when mapping into the shared, non-optional `PersistedMessage`. (Loosening
/// `PersistedMessage.id` would break the thread-chat path that depends on it.)
public struct AssistantMessage: Decodable, Sendable {
    public let id: String?
    public let role: String
    public let content: String?
    public let thinking: String?
    public let toolCalls: [PersistedToolCall]?

    enum CodingKeys: String, CodingKey {
        case id, role, content, thinking
        case toolCalls = "tool_calls"
    }

    /// Project onto the shared `PersistedMessage` so the existing
    /// `TranscriptReducer.loadPersisted` renders it unchanged. `index` seeds a
    /// stable id for rows Hermes emitted without one.
    func asPersisted(index: Int) -> PersistedMessage {
        PersistedMessage(
            id: id ?? "assistant-\(index)",
            role: role,
            content: content,
            thinking: thinking,
            toolCalls: toolCalls,
            model: nil,
            provider: nil,
            isError: nil,
            toolCallId: nil,
            toolName: nil)
    }
}

/// `GET /api/assistant/sessions` envelope.
public struct AssistantSessionsResponse: Decodable, Sendable {
    public let sessions: [AssistantSession]
}

/// `GET /api/assistant/sessions/:id` and `POST /api/assistant/sessions/import`
/// share this `{session, messages, latestRun}` shape.
public struct AssistantSessionDetail: Decodable, Sendable {
    public let session: AssistantSession
    public let messages: [AssistantMessage]
    public let latestRun: AssistantRun?

    enum CodingKeys: String, CodingKey {
        case session, messages, latestRun
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = try c.decode(AssistantSession.self, forKey: .session)
        messages = try c.decodeIfPresent([AssistantMessage].self, forKey: .messages) ?? []
        latestRun = try c.decodeIfPresent(AssistantRun.self, forKey: .latestRun)
    }

    /// The transcript-ready messages (synthesizing ids for id-less Hermes rows).
    public var persistedMessages: [PersistedMessage] {
        messages.enumerated().map { $0.element.asPersisted(index: $0.offset) }
    }
}

/// Body for `POST /api/assistant/sessions` (create).
public struct CreateAssistantSessionRequest: Encodable, Sendable {
    public let title: String?
    public init(title: String?) { self.title = title }
}

/// Body for `POST /api/assistant/sessions/import`.
public struct ImportAssistantSessionRequest: Encodable, Sendable {
    public let remoteSessionId: String
    public init(remoteSessionId: String) { self.remoteSessionId = remoteSessionId }
}

/// Body for `PATCH /api/assistant/sessions/:id` — a rename (`title`) or a
/// reversible soft-archive (`archived`). Synthesized `encode` omits nil fields.
public struct PatchAssistantSessionRequest: Encodable, Sendable {
    public let title: String?
    public let archived: Bool?
    public init(title: String? = nil, archived: Bool? = nil) {
        self.title = title
        self.archived = archived
    }
}

/// Body for `POST /api/assistant/sessions/:id/messages/stream` — also reused for
/// `POST /api/assistant/sessions/:id/runs` (background handoff), which reads the
/// same `{ content, attachments? }` shape.
public struct AssistantStreamRequest: Encodable, Sendable {
    public let content: String
    public init(content: String) { self.content = content }
}

/// `{ run }` envelope shared by `POST …/runs`, `GET /api/assistant/runs/:runId`.
/// The payload carries more (`session_id`, `remote_run_id`, `usage`…); only the
/// fields the poll loop needs (`id`, `status` via `AssistantRun`) are modelled.
public struct AssistantRunResponse: Decodable, Sendable {
    public let run: AssistantRun?
}

/// `POST /api/assistant/sync` result: how many run statuses were reconciled.
public struct AssistantSyncResponse: Decodable, Sendable {
    public let updated: Int

    enum CodingKeys: String, CodingKey { case updated }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        updated = try c.decodeIfPresent(Int.self, forKey: .updated) ?? 0
    }
}
