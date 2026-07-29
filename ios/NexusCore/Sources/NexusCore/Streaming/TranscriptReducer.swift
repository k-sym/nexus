import Foundation

public enum ChatRole: String, Sendable, Hashable {
    case user, assistant, system, toolResult
}

public enum ToolStatus: String, Sendable, Hashable {
    case running, completed, error, interrupted
}

public struct ToolCallView: Identifiable, Hashable, Sendable {
    public let id: String
    public var name: String
    public var args: JSONValue
    public var status: ToolStatus
    public var result: String
}

/// An attachment shown on the user's own turn (image thumbnail). Platform-neutral
/// (raw base64, no UIKit) so NexusCore stays testable on macOS; the app decodes it
/// for display. `Codable` so the app can persist the sent-thumbnail cache to disk
/// (thumbnails then survive a cold restart, not just an in-app reload).
public struct RenderedAttachment: Identifiable, Hashable, Sendable, Codable {
    public let id: String
    public let name: String?
    public let mimeType: String
    public let base64: String

    public init(id: String, name: String?, mimeType: String, base64: String) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.base64 = base64
    }

    public var isImage: Bool { mimeType.hasPrefix("image/") }
}

public struct RenderedMessage: Identifiable, Hashable, Sendable {
    public let id: String
    public let role: ChatRole
    public var content: String
    public var thinking: String
    public var toolCalls: [ToolCallView]
    public var isError: Bool
    public var isStreaming: Bool
    public var provider: String?
    public var model: String?
    /// Outbound attachments on the user's own turn (image thumbnails). Live/
    /// optimistic only — a persisted reload carries none, so they clear on rehydrate.
    public var attachments: [RenderedAttachment] = []
    /// Live-only: the next prose delta starts a new paragraph after tool activity.
    var pendingTextBreak: Bool = false
}

public enum RunStatus: Sendable, Hashable {
    case idle, thinking, responding, toolCall, error
}

/// Folds NDJSON chat-stream lines into a renderable transcript. A value type so
/// it's trivially unit-testable by replaying captured lines. Ports the
/// behaviour of `routeEvent` + `streamReducer` + `agentRunActionsFor` in the
/// web frontend. Unlike the web hook (which resets per turn and merges history
/// separately), this reducer owns the whole transcript: `startTurn` appends.
public struct TranscriptReducer: Sendable {
    public private(set) var messages: [RenderedMessage] = []
    public private(set) var streaming: RenderedMessage?
    public private(set) var contextUsage: ContextUsage?
    public private(set) var status: RunStatus = .idle
    public private(set) var errorText: String?
    /// Set when the stream carried a `thread_title`/`session_title`; the caller
    /// consumes and clears it to rename the sidebar early.
    public var pendingTitle: String?

    private var idSeed = 0
    private var sawRunStart = false
    private var sawRunEnd = false

    public init() {}

    public var isRunning: Bool { streaming != nil && status != .error }

    private mutating func nextId(_ prefix: String) -> String {
        idSeed += 1
        return "\(prefix)-\(idSeed)"
    }

    // MARK: History

    /// Count of user messages in the current transcript. The next sent message's
    /// ordinal (0-based, among user rows) — used to key preserved attachments.
    public var userMessageCount: Int { messages.reduce(0) { $0 + ($1.role == .user ? 1 : 0) } }

    /// Seed from `GET /api/threads/:id` flattened messages. Standalone
    /// `toolResult` rows are dropped — the assistant's `toolCalls` already carry
    /// their results.
    ///
    /// `attachmentsForUserOrdinal`, when given, re-attaches the sent thumbnails to
    /// each user row by its 0-based ordinal among user rows. The server transcript
    /// is text-only (images go inline to the model, file names get appended to the
    /// content), so without this every rehydrate — foreground reconcile, 5s sync
    /// poll, reopen — would drop the thumbnails. Keyed by ordinal, not content,
    /// precisely because the file path suffix mutates the content.
    public mutating func loadPersisted(
        _ persisted: [PersistedMessage],
        attachmentsForUserOrdinal: ((Int) -> [RenderedAttachment])? = nil
    ) {
        var userOrdinal = 0
        messages = persisted.compactMap { message in
            switch message.role {
            case "user":
                let attachments = attachmentsForUserOrdinal?(userOrdinal) ?? []
                userOrdinal += 1
                return RenderedMessage(
                    id: message.id, role: .user, content: message.content ?? "",
                    thinking: "", toolCalls: [], isError: false, isStreaming: false,
                    attachments: attachments)
            case "assistant":
                let tools = (message.toolCalls ?? []).map { call in
                    ToolCallView(
                        id: call.id, name: call.name, args: call.args ?? .object([:]),
                        status: Self.persistedStatus(call.status), result: call.result ?? "")
                }
                return RenderedMessage(
                    id: message.id, role: .assistant, content: message.content ?? "",
                    thinking: message.thinking ?? "", toolCalls: tools,
                    isError: message.isError ?? false, isStreaming: false,
                    provider: message.provider, model: message.model)
            default:
                return nil
            }
        }
        streaming = nil
        status = .idle
        errorText = nil
    }

    private static func persistedStatus(_ raw: String) -> ToolStatus {
        switch raw {
        case "succeeded", "completed": return .completed
        case "failed", "error": return .error
        case "interrupted": return .interrupted
        default: return .running
        }
    }

    // MARK: Turn lifecycle

    public mutating func startTurn(prompt: String, attachments: [RenderedAttachment] = []) {
        messages.append(RenderedMessage(
            id: nextId("user"), role: .user, content: prompt,
            thinking: "", toolCalls: [], isError: false, isStreaming: false, attachments: attachments))
        streaming = RenderedMessage(
            id: nextId("assistant"), role: .assistant, content: "",
            thinking: "", toolCalls: [], isError: false, isStreaming: true)
        status = .thinking
        errorText = nil
        sawRunStart = false
        sawRunEnd = false
    }

    /// Append a user message without opening a streaming assistant bubble. Used
    /// by background handoff, where the turn executes server-side and the
    /// transcript refreshes via polling rather than a live stream — so there is
    /// no live assistant placeholder to spin. A later `loadPersisted` replaces
    /// this row with the server's own copy, so no duplicate results.
    public mutating func appendUserMessage(_ prompt: String, attachments: [RenderedAttachment] = []) {
        messages.append(RenderedMessage(
            id: nextId("user"), role: .user, content: prompt,
            thinking: "", toolCalls: [], isError: false, isStreaming: false, attachments: attachments))
    }

    // MARK: Event application

    /// Apply one parsed NDJSON line. Handles both the `kind`-tagged run
    /// lifecycle (top-level, not unwrapped) and the `type`-tagged model/tool
    /// events (unwrapping `event ?? self`).
    public mutating func apply(_ line: JSONValue) {
        if let kind = line["kind"]?.string {
            switch kind {
            case "run_start":
                sawRunStart = true
                if let run = line["run"] { applyRunStart(run) }
                return
            case "run_end":
                sawRunEnd = true
                complete()
                return
            case "thread_title", "session_title":
                if let title = line["title"]?.string, !title.isEmpty { pendingTitle = title }
                return
            case "done":
                complete()
                return
            case "error":
                fail(line["error"]?.string ?? "stream error")
                return
            default:
                break
            }
        }

        let event = line["event"] ?? line
        guard let type = event["type"]?.string else { return }

        switch type {
        case "context_usage":
            contextUsage = ContextUsage(event["usage"])
        case "message_start":
            break
        case "message_update":
            applyMessageUpdate(event["assistantMessageEvent"])
        case "message_end":
            applyMessageEnd(event["message"])
        case "tool_execution_start":
            addTool(id: event["toolCallId"]?.string ?? "",
                    name: event["toolName"]?.string ?? "",
                    args: event["args"] ?? .object([:]))
        case "tool_execution_update":
            appendToolOutput(id: event["toolCallId"]?.string ?? "",
                             text: event["partialResult"]?["content"]?.joinedContentText ?? "")
        case "tool_execution_end":
            finishTool(id: event["toolCallId"]?.string ?? "",
                       result: event["result"]?["content"]?.joinedContentText ?? "",
                       isError: event["isError"]?.bool ?? false)
        case "done":
            complete()
        case "error":
            fail(event["message"]?.string ?? "Unknown error")
        default:
            break
        }
    }

    /// Call when the byte stream ended without a terminal `run_end`/`done`
    /// (e.g. backgrounding or a transport drop). Finalizes the partial turn,
    /// marking still-running tools interrupted. The backend keeps the run alive;
    /// a later rehydrate reconciles it.
    public mutating func finishByDisconnect() {
        guard streaming != nil else { return }
        if sawRunStart && !sawRunEnd { interruptRunningTools() }
        complete()
    }

    public mutating func abort() {
        guard streaming != nil else { status = .idle; return }
        interruptRunningTools()
        complete()
    }

    // MARK: Mutations

    private mutating func applyRunStart(_ run: JSONValue) {
        if var message = streaming {
            message.provider = run["provider"]?.string
            message.model = run["model"]?.string
            streaming = message
        }
        status = .thinking
    }

    private mutating func applyMessageUpdate(_ ame: JSONValue?) {
        guard let ame, let type = ame["type"]?.string else { return }
        switch type {
        case "thinking_delta":
            appendThinking(ame["delta"]?.string ?? "")
        case "thinking_end":
            let thinking = extractThinking(ame)
            if !thinking.isEmpty { streaming?.thinking = thinking }
        case "text_delta":
            appendText(ame["delta"]?.string ?? "")
        case "toolcall_end":
            if let call = ame["toolCall"] {
                addTool(id: call["id"]?.string ?? "",
                        name: call["name"]?.string ?? "",
                        args: call["arguments"] ?? .object([:]))
            }
        case "error":
            fail(ameError(ame))
        default:
            break
        }
    }

    private mutating func applyMessageEnd(_ message: JSONValue?) {
        if message?["role"]?.string == "assistant",
           message?["stopReason"]?.string == "error" || (message?["errorMessage"]?.string?.isEmpty == false) {
            fail(formatProviderError(message?["errorMessage"]?.string) ?? "Provider returned an error.")
            return
        }
        guard var current = streaming, let message else { return }
        let snapshot = messageSnapshot(message)
        current.content = snapshot.content
        if !snapshot.thinking.isEmpty { current.thinking = snapshot.thinking }
        if !snapshot.tools.isEmpty {
            var merged = snapshot.tools.map { snap -> ToolCallView in
                current.toolCalls.first(where: { $0.id == snap.id }) ?? snap
            }
            for live in current.toolCalls where !snapshot.tools.contains(where: { $0.id == live.id }) {
                merged.append(live)
            }
            current.toolCalls = merged
        }
        current.pendingTextBreak = false
        streaming = current
    }

    private mutating func appendText(_ delta: String) {
        guard var message = streaming, !delta.isEmpty else { return }
        let needsBreak = message.pendingTextBreak
            && !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !message.content.hasSuffix("\n") && !delta.hasPrefix("\n")
        message.content += (needsBreak ? "\n\n" : "") + delta
        message.pendingTextBreak = false
        streaming = message
        status = .responding
    }

    private mutating func appendThinking(_ delta: String) {
        guard var message = streaming, !delta.isEmpty else { return }
        message.thinking += delta
        streaming = message
        status = .thinking
    }

    private mutating func addTool(id: String, name: String, args: JSONValue) {
        guard var message = streaming, !id.isEmpty else { return }
        guard !message.toolCalls.contains(where: { $0.id == id }) else { return }
        message.toolCalls.append(ToolCallView(id: id, name: name, args: args, status: .running, result: ""))
        message.pendingTextBreak = message.pendingTextBreak
            || !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        streaming = message
        status = .toolCall
    }

    private mutating func appendToolOutput(id: String, text: String) {
        updateTool(id) { tool in
            tool.result += text
            tool.status = .running
        }
    }

    private mutating func finishTool(id: String, result: String, isError: Bool) {
        updateTool(id) { tool in
            tool.status = isError ? .error : .completed
            tool.result = result
        }
    }

    private mutating func updateTool(_ id: String, _ transform: (inout ToolCallView) -> Void) {
        guard var message = streaming,
              let index = message.toolCalls.firstIndex(where: { $0.id == id }) else { return }
        transform(&message.toolCalls[index])
        streaming = message
    }

    private mutating func interruptRunningTools() {
        guard var message = streaming else { return }
        for index in message.toolCalls.indices where
            message.toolCalls[index].status == .running {
            message.toolCalls[index].status = .interrupted
        }
        streaming = message
    }

    private mutating func complete() {
        guard let message = streaming else { status = .idle; return }
        let isEmpty = message.content.isEmpty && message.thinking.isEmpty && message.toolCalls.isEmpty
        if !isEmpty {
            var finalized = message
            finalized.isStreaming = false
            messages.append(finalized)
        }
        streaming = nil
        status = .idle
    }

    public mutating func fail(_ message: String) {
        if let current = streaming,
           !(current.content.isEmpty && current.thinking.isEmpty && current.toolCalls.isEmpty) {
            var finalized = current
            finalized.isStreaming = false
            finalized.isError = true
            messages.append(finalized)
        }
        streaming = nil
        status = .error
        errorText = message
    }

    // MARK: Snapshot extraction (mirror extractMessageSnapshot)

    private struct Snapshot {
        var content = ""
        var thinking = ""
        var tools: [ToolCallView] = []
    }

    private func messageSnapshot(_ message: JSONValue) -> Snapshot {
        var snapshot = Snapshot()
        var toolSinceLastText = false
        for block in message["content"]?.array ?? [] {
            switch block["type"]?.string {
            case "text":
                let text = block["text"]?.string ?? ""
                if toolSinceLastText, !snapshot.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                   !text.isEmpty, !snapshot.content.hasSuffix("\n"), !text.hasPrefix("\n") {
                    snapshot.content += "\n\n"
                }
                snapshot.content += text
                toolSinceLastText = false
            case "thinking":
                snapshot.thinking += block["thinking"]?.string ?? ""
            case "toolCall":
                toolSinceLastText = true
                snapshot.tools.append(ToolCallView(
                    id: block["id"]?.string ?? "",
                    name: block["name"]?.string ?? "",
                    args: block["arguments"] ?? .object([:]),
                    status: .running, result: ""))
            default:
                break
            }
        }
        return snapshot
    }

    private func extractThinking(_ event: JSONValue) -> String {
        if let delta = event["delta"]?.string { return delta }
        if let content = event["content"]?.string { return content }
        if let blocks = event["partial"]?["content"]?.array {
            return blocks.filter { $0["type"]?.string == "thinking" }
                .compactMap { $0["thinking"]?.string }.joined()
        }
        return ""
    }

    private func ameError(_ ame: JSONValue) -> String {
        ame["message"]?.string
            ?? ame["error"]?["message"]?.string
            ?? ame["error"]?.string
            ?? (ame["reason"]?.string == "aborted" ? "Aborted" : ame["reason"]?.string)
            ?? "Error"
    }
}

/// Mirror of `formatProviderError`: peel a provider JSON error out of a message.
func formatProviderError(_ message: String?) -> String? {
    guard let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
        return nil
    }
    if let start = trimmed.firstIndex(of: "{"),
       let data = String(trimmed[start...]).data(using: .utf8),
       let parsed = JSONValue.parse(data) {
        if let providerMessage = parsed["error"]?["message"]?.string ?? parsed["message"]?.string,
           !providerMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return providerMessage
        }
    }
    return trimmed
}
