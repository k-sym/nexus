import Foundation

// Session-first Kanban (#439). Mirrors the `Board*` / `Origin*` types in
// `src/shared/index.ts`.
//
// Decoder rule: `BoardResponse` and `OriginSessionResult` embed `ChatThread`,
// which uses explicit snake_case CodingKeys, so they are decoded with the PLAIN
// decoder (`nexusCamel`) and spell out their own snake_case keys — the same
// convention `TicketSessionResult` follows. `OriginDraft` is camelCase on the
// wire and also uses the plain decoder. Request bodies encode camelCase with a
// plain `JSONEncoder`.

// MARK: - Lanes

/// A board lane, in display order. Forward-compatible: an unrecognized value
/// from a newer backend decodes to `.unknown(raw)` instead of throwing.
/// `allCases` is the five known lanes in the order the board shows them.
public enum BoardLane: Codable, Hashable, Sendable, CaseIterable {
    case inbox, running, needsYou, idle, done
    case unknown(String)

    public static var allCases: [BoardLane] { [.inbox, .running, .needsYou, .idle, .done] }

    public init(rawValue: String) {
        switch rawValue {
        case "inbox": self = .inbox
        case "running": self = .running
        case "needs_you": self = .needsYou
        case "idle": self = .idle
        case "done": self = .done
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .inbox: return "inbox"
        case .running: return "running"
        case .needsYou: return "needs_you"
        case .idle: return "idle"
        case .done: return "done"
        case .unknown(let v): return v
        }
    }

    /// Section title, mirroring `BOARD_LANE_LABELS`.
    public var label: String {
        switch self {
        case .inbox: return "Inbox"
        case .running: return "Running"
        case .needsYou: return "Needs you"
        case .idle: return "Idle"
        case .done: return "Done"
        case .unknown(let v): return v.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

// MARK: - Origins

/// Where a card came from. Tagged union on `kind`; an unknown kind decodes to
/// `.unknown(kind)` so a newer backend cannot break the whole board.
public enum BoardOrigin: Hashable, Sendable {
    case ticket(key: String, url: String?)
    case github(number: Int, url: String)
    case monday(itemId: String, name: String, url: String?)
    case chat
    case unknown(String)

    /// The wire `kind` (`"ticket"`, `"github"`, `"monday"`, `"chat"`, or the
    /// unrecognized value).
    public var kind: String {
        switch self {
        case .ticket: return "ticket"
        case .github: return "github"
        case .monday: return "monday"
        case .chat: return "chat"
        case .unknown(let k): return k
        }
    }

    /// The origin's link, when the backend sent one.
    public var url: String? {
        switch self {
        case .ticket(_, let url): return url
        case .github(_, let url): return url
        case .monday(_, _, let url): return url
        case .chat, .unknown: return nil
        }
    }
}

extension BoardOrigin: Decodable {
    private enum CodingKeys: String, CodingKey {
        case kind, key, url, number, name
        case itemId = "item_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "ticket":
            self = .ticket(
                key: try c.decode(String.self, forKey: .key),
                url: try c.decodeIfPresent(String.self, forKey: .url))
        case "github":
            self = .github(
                number: try c.decode(Int.self, forKey: .number),
                url: try c.decode(String.self, forKey: .url))
        case "monday":
            self = .monday(
                itemId: try c.decode(String.self, forKey: .itemId),
                name: try c.decode(String.self, forKey: .name),
                url: try c.decodeIfPresent(String.self, forKey: .url))
        case "chat":
            self = .chat
        default:
            self = .unknown(kind)
        }
    }
}

// MARK: - Cards and Inbox

/// One session on the board with its derived lane and live counters.
public struct BoardCard: Decodable, Identifiable, Hashable, Sendable {
    public let thread: ChatThread
    public let lane: BoardLane
    public let origin: BoardOrigin
    public let running: Bool
    public let pendingQuestions: Int
    public let pendingApprovals: Int
    public let mondayItemId: String?

    public var id: String { thread.id }

    enum CodingKeys: String, CodingKey {
        case thread, lane, origin, running
        case pendingQuestions = "pending_questions"
        case pendingApprovals = "pending_approvals"
        case mondayItemId = "monday_item_id"
    }
}

/// The two external feeds that can put something in the Inbox. Forward-compatible
/// like `BoardLane`; the raw value is what the draft/session routes expect back.
public enum BoardInboxKind: Codable, Hashable, Sendable {
    case github, monday
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "github": self = .github
        case "monday": self = .monday
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .github: return "github"
        case .monday: return "monday"
        case .unknown(let v): return v
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// An open GitHub issue or active Monday item with no session on the board.
public struct BoardInboxItem: Decodable, Identifiable, Hashable, Sendable {
    public let kind: BoardInboxKind
    /// Issue number (as a string) or Monday item id.
    public let id: String
    public let title: String
    public let url: String?
    public let labels: [String]
    public let statusLabel: String?
    public let updated: String?

    enum CodingKeys: String, CodingKey {
        case kind, id, title, url, labels, updated
        case statusLabel = "status_label"
    }
}

/// Per-feed failure messages. The board still renders when a feed is down.
public struct BoardInboxErrors: Decodable, Hashable, Sendable {
    public let github: String?
    public let monday: String?

    public init(github: String? = nil, monday: String? = nil) {
        self.github = github
        self.monday = monday
    }

    public var isEmpty: Bool { github == nil && monday == nil }
}

/// `GET /api/projects/:id/board`.
public struct BoardResponse: Decodable, Hashable, Sendable {
    public let cards: [BoardCard]
    public let inbox: [BoardInboxItem]
    public let inboxErrors: BoardInboxErrors

    enum CodingKeys: String, CodingKey {
        case cards, inbox
        case inboxErrors = "inbox_errors"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cards = try c.decode([BoardCard].self, forKey: .cards)
        inbox = try c.decodeIfPresent([BoardInboxItem].self, forKey: .inbox) ?? []
        inboxErrors = try c.decodeIfPresent(BoardInboxErrors.self, forKey: .inboxErrors) ?? BoardInboxErrors()
    }

    /// Cards in one lane, in the order the server sent them.
    public func cards(in lane: BoardLane) -> [BoardCard] {
        cards.filter { $0.lane == lane }
    }
}

// MARK: - Draft and Go

/// `{ kind, id }` — names an Inbox item to the draft and session routes.
/// camelCase both ways (it is already single-word keys).
public struct OriginRef: Codable, Hashable, Sendable {
    public let kind: BoardInboxKind
    public let id: String

    public init(kind: BoardInboxKind, id: String) {
        self.kind = kind
        self.id = id
    }
}

/// `POST /api/projects/:id/board/draft` — what Sonnet distilled from the issue
/// or item. camelCase on the wire; every field is editable before Go.
public struct OriginDraft: Decodable, Hashable, Sendable {
    public let origin: OriginRef
    public let problem: String
    public let projectId: String?
    public let branchType: String
    public let branchName: String
    public let model: String
}

/// Body of `POST /api/projects/:id/board/session`. camelCase, plain encoder;
/// a nil `projectId` is omitted so the server falls back to the route's project.
public struct OriginSessionRequest: Encodable, Sendable {
    public let kind: BoardInboxKind
    public let id: String
    public let projectId: String?
    public let problem: String
    public let branchName: String

    public init(kind: BoardInboxKind, id: String, projectId: String?, problem: String, branchName: String) {
        self.kind = kind
        self.id = id
        self.projectId = projectId
        self.problem = problem
        self.branchName = branchName
    }
}

/// `POST /api/projects/:id/board/session` → the new, origin-stamped thread and
/// the exact first turn to send. Plain decoder (see the file header).
public struct OriginSessionResult: Decodable, Sendable {
    public let thread: ChatThread
    public let firstTurn: String
}

/// Board branch types (D10): the repo convention, not SSUK's. Picker order.
public let boardBranchTypes = ["feat", "fix", "hotfix"]

/// `feat/session-first-kanban` + `fix` → `fix/session-first-kanban`. Mirrors
/// `ticketBranchName(type:replacingPrefixOf:)` over `boardBranchTypes`, so the
/// type picker rewrites the prefix without a round trip.
public func boardBranchName(type: String, replacingPrefixOf branch: String) -> String {
    var rest = branch
    for t in boardBranchTypes where rest.lowercased().hasPrefix("\(t)/") {
        rest = String(rest.dropFirst(t.count + 1))
        break
    }
    return "\(type)/\(rest)"
}
