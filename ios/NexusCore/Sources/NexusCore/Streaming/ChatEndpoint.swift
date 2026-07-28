import Foundation

/// The data a chat surface needs to rehydrate: the flattened transcript plus the
/// optional title/supervise/model seeds. `ChatViewModel` fills its state from
/// this so it never touches the concrete backend calls directly.
public struct ChatDetail: Sendable {
    public let messages: [PersistedMessage]
    public let title: String?
    public let supervised: Bool?
    public let lastModelKey: String?

    public init(
        messages: [PersistedMessage],
        title: String? = nil,
        supervised: Bool? = nil,
        lastModelKey: String? = nil
    ) {
        self.messages = messages
        self.title = title
        self.supervised = supervised
        self.lastModelKey = lastModelKey
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

    /// Rehydrate history + seeds.
    func loadDetail() async throws -> ChatDetail
    /// Send a message and stream the turn. May throw `.busy` on the thread path
    /// (retry with `confirmCancel: true`); the assistant path never does.
    func stream(content: String, modelKey: String?, confirmCancel: Bool) async throws -> AsyncThrowingStream<JSONValue, Error>
    /// Abort the active run.
    func abort() async throws
    /// Toggle Supervise; returns the confirmed state. A no-op returning `false`
    /// where unsupported.
    @discardableResult func setSupervised(_ on: Bool) async throws -> Bool
    /// The curated model list for the picker; empty where unsupported.
    func models() async throws -> [Model]
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

    public func stream(content: String, modelKey: String?, confirmCancel: Bool) async throws -> AsyncThrowingStream<JSONValue, Error> {
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

    public func loadDetail() async throws -> ChatDetail {
        let detail = try await api.assistantSessionDetail(sessionId: sessionId)
        return ChatDetail(
            messages: detail.persistedMessages,
            title: detail.session.title,
            supervised: nil,
            lastModelKey: nil)
    }

    public func stream(content: String, modelKey: String?, confirmCancel: Bool) async throws -> AsyncThrowingStream<JSONValue, Error> {
        // The assistant endpoint takes no modelKey and has no confirm-cancel gate.
        try await api.streamAssistantMessage(sessionId: sessionId, content: content)
    }

    public func abort() async throws {
        try await api.abortAssistant()
    }

    @discardableResult
    public func setSupervised(_ on: Bool) async throws -> Bool { false }

    public func models() async throws -> [Model] { [] }
}
