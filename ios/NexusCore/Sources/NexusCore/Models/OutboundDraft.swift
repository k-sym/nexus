import Foundation

/// Outbound draft queue (`GET /api/drafts`, proxied from the assistant adapter's
/// `/v1/drafts` — baker-internal#42). Mirror of `DraftsResponse` in
/// `src/frontend/src/api.ts`. Wire keys are snake_case, so the shared
/// `.nexusREST` decoder applies.
///
/// Unlike the routines fleet, this surface acts: approving a draft is what sends
/// the email. Every guard (approval freshness, content unchanged since approval,
/// draft age) lives in the partner's own send path, which re-checks them in a
/// separate process — nothing here is load-bearing for safety.
public struct DraftsResponse: Decodable, Sendable {
    /// False when the backend has no assistant URL/key configured.
    public let configured: Bool?
    public let drafts: [OutboundDraft]
    public let pending: Int?
    /// Set (with an empty `drafts`) when the adapter was unreachable.
    public let error: String?
}

public enum DraftStatus: String, Decodable, Sendable {
    case pending
    case approved
    case sent
    case rejected
    case expired
    case failed
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = DraftStatus(rawValue: raw) ?? .unknown
    }
}

public struct OutboundDraft: Decodable, Sendable, Identifiable {
    public let id: String
    /// Mailbox alias the reply would be sent from (`ssuk`, `baker`, …).
    public let account: String
    public let status: DraftStatus
    public let subject: String
    public let to: [String]
    public let cc: [String]
    /// `<alias>:<message-id>` when this threads onto an existing message.
    public let replyTo: String?
    public let thread: String?
    /// Which routine proposed it, e.g. "draft-replies".
    public let source: String?
    /// Why it was proposed — shown on the row so the decision has context.
    public let rationale: String?
    public let createdIso: String?
    /// First ~200 characters. The full body only arrives on the detail call.
    public let preview: String?
    public let bodyChars: Int?

    public var isReply: Bool { replyTo != nil }
}

/// Detail carries the FULL body: approving something you have only seen a
/// preview of is not consent, so the sheet fetches this before offering Send.
public struct OutboundDraftDetail: Decodable, Sendable, Identifiable {
    public let id: String
    public let account: String
    public let status: DraftStatus
    public let subject: String
    public let to: [String]
    public let cc: [String]
    public let replyTo: String?
    public let source: String?
    public let rationale: String?
    public let body: String
    /// The adapter's own read of whether this could be sent right now, and why
    /// not. Advisory for display — the send path re-checks regardless.
    public let sendable: Bool?
    public let sendableReason: String?
}

/// Result of approving or rejecting. `sent` is true only when the email
/// actually left, so the UI never reports success on a failed send.
public struct DraftDecision: Decodable, Sendable {
    public let id: String?
    public let status: DraftStatus?
    public let sent: Bool?
}
