import Foundation

/// Mirror of `Ticket` in `src/shared/index.ts` — a read-only Jira mirror row.
/// Decoded with `JSONDecoder.nexusREST` (`synced_at` → `syncedAt`).
public struct Ticket: Decodable, Identifiable, Hashable, Sendable {
    public var id: String { key }
    public let key: String
    public let summary: String
    public let status: String
    public let priority: String
    public let assignee: String?
    public let created: String?
    public let updated: String?
    public let url: String?
    public let source: String?
    public let syncedAt: String
    /// The latest open session started from this ticket (#432), if any.
    public let session: TicketSessionRef?
}

/// `Ticket.session`: where the ticket's session lives. Snake_case on the wire.
public struct TicketSessionRef: Decodable, Hashable, Sendable {
    public let threadId: String
    public let projectId: String

    public init(threadId: String, projectId: String) {
        self.threadId = threadId
        self.projectId = projectId
    }
}

/// `GET /api/tickets/:key/description` — the cleaned, display-ready body.
public struct TicketDescription: Decodable, Hashable, Sendable {
    public struct Trimmed: Decodable, Hashable, Sendable {
        public let kind: String
        public let text: String
    }
    public let key: String
    public let body: String
    public let trimmed: [Trimmed]
    public let fetchedAt: String?
    public let empty: Bool
}

/// `POST /api/tickets/:key/draft` — what Sonnet distilled (#432). camelCase on
/// the wire; every field is editable before Go.
public struct TicketDraft: Decodable, Hashable, Sendable {
    public let key: String
    public let problem: String
    public let projectId: String?
    public let branchType: String
    public let branchName: String
    public let model: String
}

/// Body of `POST /api/tickets/:key/session`. camelCase, plain encoder.
public struct TicketSessionRequest: Encodable, Sendable {
    public let projectId: String
    public let problem: String
    public let branchName: String

    public init(projectId: String, problem: String, branchName: String) {
        self.projectId = projectId
        self.problem = problem
        self.branchName = branchName
    }
}

/// `POST /api/tickets/:key/session` → the new thread and the exact first turn
/// to send. `thread` is snake_case with explicit keys, so decode with the PLAIN
/// decoder (as `ChatThread` always is).
public struct TicketSessionResult: Decodable, Sendable {
    public let thread: ChatThread
    public let firstTurn: String
}

/// SSUK branch types, in the order the picker shows them.
public let ticketBranchTypes = ["fix", "hotfix", "feature"]

/// `SUP-123` + `fix` + "last score missing" → `fix/SUP123-last-score-missing`.
/// Mirrors `buildBranchName` in `src/backend/tickets/draft.ts` for local edits
/// (the type picker rewrites the prefix without a round trip).
public func ticketBranchName(type: String, replacingPrefixOf branch: String) -> String {
    var rest = branch
    for t in ticketBranchTypes where rest.lowercased().hasPrefix("\(t)/") {
        rest = String(rest.dropFirst(t.count + 1))
        break
    }
    return "\(type)/\(rest)"
}
