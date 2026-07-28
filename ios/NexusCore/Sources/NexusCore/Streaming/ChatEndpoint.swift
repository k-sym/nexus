import Foundation

/// The data a chat surface needs to rehydrate: the flattened transcript plus the
/// optional title/supervise/model seeds. `ChatViewModel` fills its state from
/// this so it never touches the concrete backend calls directly.
public struct ChatDetail: Sendable {
    public let messages: [PersistedMessage]
    public let title: String?
    public let supervised: Bool?
    public let lastModelKey: String?
    /// The session's latest background run, where the endpoint has one (assistant
    /// only). Lets a reopened chat resume 5s sync polling for an in-flight handoff.
    public let latestRun: AssistantRun?

    public init(
        messages: [PersistedMessage],
        title: String? = nil,
        supervised: Bool? = nil,
        lastModelKey: String? = nil,
        latestRun: AssistantRun? = nil
    ) {
        self.messages = messages
        self.title = title
        self.supervised = supervised
        self.lastModelKey = lastModelKey
        self.latestRun = latestRun
    }
}

/// The chat backend `ChatViewModel` drives. One protocol, two conformers, so the
/// same streaming chat UI serves both project threads and assistant sessions —
/// the assistant is simply thread-chat minus the model picker, Supervise, and the
/// busy/takeover gate. Capability flags let the composer hide what an endpoint
/// doesn't support; unsupported calls are cheap no-ops rather than errors.
public protocol ChatEndpoint: Sendable {
    /// Whether the composer offers a model picker (threads: yes, assistant: no).
    var supportsModelPicker: Bool { get }
    /// Whether the composer offers a Supervise toggle (threads: yes, assistant: no).
    var supportsSupervise: Bool { get }
    /// Whether the composer offers "hand off to a background run" (assistant only).
    /// A background turn runs server-side against Hermes and outlives the app, so
    /// progress is polled via `syncBackgroundRuns()` + `loadDetail()` rather than
    /// streamed. Threads have no equivalent.
    var supportsBackgroundHandoff: Bool { get }
    /// Whether the composer offers attachments (assistant only). Images route
    /// through the backend's vision path; threads don't accept attachments here.
    var supportsAttachments: Bool { get }

    /// Rehydrate history + seeds.
    func loadDetail() async throws -> ChatDetail
    /// Send a message and stream the turn. May throw `.busy` on the thread path
    /// (retry with `confirmCancel: true`); the assistant path never does.
    /// `attachments` are ignored where unsupported.
    func stream(content: String, modelKey: String?, confirmCancel: Bool, attachments: [AssistantAttachment]) async throws -> AsyncThrowingStream<JSONValue, Error>
    /// Abort the active run.
    func abort() async throws
    /// Toggle Supervise; returns the confirmed state. A no-op returning `false`
    /// where unsupported.
    @discardableResult func setSupervised(_ on: Bool) async throws -> Bool
    /// The curated model list for the picker; empty where unsupported.
    func models() async throws -> [Model]

    /// Hand the turn off to a durable background run and return it. Only called
    /// where `supportsBackgroundHandoff`; the default throws. The backend rejects
    /// image attachments on this path (vision is Send-only).
    func startBackgroundRun(content: String, attachments: [AssistantAttachment]) async throws -> AssistantRun
    /// Reconcile in-flight background runs server-side (global). No-op by default.
    func syncBackgroundRuns() async throws
    /// Ask a specific background run to stop. No-op by default.
    func stopBackgroundRun(runId: String) async throws
}

/// Threads (and any future endpoint) get the background-handoff and attachment
/// surfaces for free as no-ops, so only assistant sessions implement them.
public extension ChatEndpoint {
    var supportsBackgroundHandoff: Bool { false }
    var supportsAttachments: Bool { false }
    /// A stable per-conversation key for caching sent-attachment thumbnails so
    /// they survive a rehydrate. Nil where there are no attachments (threads).
    var attachmentScopeId: String? { nil }
    func startBackgroundRun(content: String, attachments: [AssistantAttachment]) async throws -> AssistantRun {
        throw APIError.server(status: 400, message: "This chat doesn't support background handoff.")
    }
    func syncBackgroundRuns() async throws {}
    func stopBackgroundRun(runId: String) async throws {}
}

/// Project-thread chat. Wraps today's thread calls byte-for-byte so the existing
/// chat (busy takeover, Supervise, model picker, context meter) does not regress.
public struct ThreadChatEndpoint: ChatEndpoint {
    private let api: APIClient
    private let threadId: String

    public init(api: APIClient, threadId: String) {
        self.api = api
        self.threadId = threadId
    }

    public var supportsModelPicker: Bool { true }
    public var supportsSupervise: Bool { true }

    public func loadDetail() async throws -> ChatDetail {
        let detail = try await api.threadDetail(threadId: threadId)
        return ChatDetail(
            messages: detail.messages,
            title: detail.thread.title,
            supervised: detail.supervised,
            lastModelKey: detail.thread.lastModelKey)
    }

    public func stream(content: String, modelKey: String?, confirmCancel: Bool, attachments: [AssistantAttachment]) async throws -> AsyncThrowingStream<JSONValue, Error> {
        // Threads don't accept attachments here; the composer never offers them.
        try await api.streamThreadMessage(
            threadId: threadId, content: content, modelKey: modelKey, confirmCancel: confirmCancel)
    }

    public func abort() async throws {
        try await api.abortThread(threadId: threadId)
    }

    @discardableResult
    public func setSupervised(_ on: Bool) async throws -> Bool {
        try await api.setSupervised(threadId: threadId, supervised: on)
    }

    public func models() async throws -> [Model] {
        try await api.models()
    }
}

/// Hermes-backed assistant session chat. Fixed `hermes-agent` model, no Supervise,
/// no busy gate; abort is the global `POST /api/assistant/abort`.
public struct AssistantChatEndpoint: ChatEndpoint {
    private let api: APIClient
    private let sessionId: String

    public init(api: APIClient, sessionId: String) {
        self.api = api
        self.sessionId = sessionId
    }

    public var supportsModelPicker: Bool { false }
    public var supportsSupervise: Bool { false }
    public var supportsBackgroundHandoff: Bool { true }
    public var supportsAttachments: Bool { true }
    public var attachmentScopeId: String? { sessionId }

    public func loadDetail() async throws -> ChatDetail {
        let detail = try await api.assistantSessionDetail(sessionId: sessionId)
        return ChatDetail(
            messages: detail.persistedMessages,
            title: detail.session.title,
            supervised: nil,
            lastModelKey: nil,
            latestRun: detail.latestRun)
    }

    public func stream(content: String, modelKey: String?, confirmCancel: Bool, attachments: [AssistantAttachment]) async throws -> AsyncThrowingStream<JSONValue, Error> {
        // The assistant endpoint takes no modelKey and has no confirm-cancel gate.
        try await api.streamAssistantMessage(sessionId: sessionId, content: content, attachments: attachments)
    }

    public func abort() async throws {
        try await api.abortAssistant()
    }

    @discardableResult
    public func setSupervised(_ on: Bool) async throws -> Bool { false }

    public func models() async throws -> [Model] { [] }

    public func startBackgroundRun(content: String, attachments: [AssistantAttachment]) async throws -> AssistantRun {
        try await api.startAssistantRun(sessionId: sessionId, content: content, attachments: attachments)
    }

    public func syncBackgroundRuns() async throws {
        _ = try await api.syncAssistant()
    }

    public func stopBackgroundRun(runId: String) async throws {
        try await api.stopAssistantRun(runId: runId)
    }
}
