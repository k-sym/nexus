import Foundation

// MARK: - Idea Watcher (#352, successor to Braindump)

/// Lifecycle of an idea: `parked → discussing → researching → reviewed →
/// graduated | discarded`. Unknown-tolerant like `RoutineHealth` — a newer
/// backend state decodes as `.unknown` instead of failing the row.
public enum IdeaState: String, Codable, Hashable, Sendable {
    case parked
    case discussing
    case researching
    case reviewed
    case graduated
    case discarded
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = IdeaState(rawValue: raw) ?? .unknown
    }

    /// The states a user can pick manually (everything real; never `.unknown`).
    public static let selectable: [IdeaState] = [
        .parked, .discussing, .researching, .reviewed, .graduated, .discarded,
    ]

    /// Terminal states hidden behind the "Done" toggle.
    public var isTerminal: Bool { self == .graduated || self == .discarded }

    /// Display label for state pills and pickers.
    public var label: String {
        switch self {
        case .parked: return "Parked"
        case .discussing: return "Discussing"
        case .researching: return "Researching"
        case .reviewed: return "Reviewed"
        case .graduated: return "Graduated"
        case .discarded: return "Discarded"
        case .unknown: return "Unknown"
        }
    }
}

/// Where a graduated idea went. The row itself is snake_case, but this nested
/// JSON is route-built with camelCase inner keys (`projectId`, `taskId`,
/// `urls`) — explicit CodingKeys keep the decode strategy-proof.
public enum IdeaGraduation: Hashable, Sendable, Decodable {
    case project(projectId: String, taskId: String?)
    case issues(urls: [String])
    /// Forward-compatible: a graduation kind this build doesn't know.
    case unknown(kind: String)

    private enum CodingKeys: String, CodingKey {
        case kind
        case projectId
        case taskId
        case urls
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "project":
            self = .project(
                projectId: try container.decode(String.self, forKey: .projectId),
                taskId: try container.decodeIfPresent(String.self, forKey: .taskId))
        case "issues":
            self = .issues(urls: try container.decodeIfPresent([String].self, forKey: .urls) ?? [])
        default:
            self = .unknown(kind: kind)
        }
    }

    /// Filed issue URLs, when this is an issues graduation.
    public var issueURLs: [String] {
        if case .issues(let urls) = self { return urls }
        return []
    }
}

/// Mirror of `Idea` in `src/shared/index.ts`. Snake_case wire keys → decode
/// with `JSONDecoder.nexusREST`. The dialogue itself is an ordinary assistant
/// session (`sessionId`), not part of this row.
public struct Idea: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    /// Parked notes / the original one-liner.
    public let seed: String
    public let state: IdeaState
    public let tags: [String]
    /// "owner/repo" preselected for graduation (web-only in v1).
    public let targetRepo: String?
    /// Assistant session id; nil until the first Discuss.
    public let sessionId: String?
    public let graduatedTo: IdeaGraduation?
    /// `idea_watcher`, or `braindump` for migrated rows.
    public let source: String
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String, title: String, seed: String, state: IdeaState, tags: [String],
        targetRepo: String?, sessionId: String?, graduatedTo: IdeaGraduation?,
        source: String, createdAt: String, updatedAt: String
    ) {
        self.id = id
        self.title = title
        self.seed = seed
        self.state = state
        self.tags = tags
        self.targetRepo = targetRepo
        self.sessionId = sessionId
        self.graduatedTo = graduatedTo
        self.source = source
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

// MARK: Write request DTOs

/// Body of `POST /api/ideas` — quick capture.
public struct CreateIdeaRequest: Encodable, Sendable {
    public let title: String
    public let seed: String?
    public init(title: String, seed: String? = nil) {
        self.title = title
        self.seed = seed
    }
}

/// Body of `PATCH /api/ideas/:id`. Nil fields are omitted from the JSON, so a
/// patch only touches what it sets. `target_repo` is the one snake_case key.
public struct UpdateIdeaRequest: Encodable, Sendable {
    public var title: String?
    public var seed: String?
    public var state: IdeaState?
    public var tags: [String]?
    public var targetRepo: String?

    private enum CodingKeys: String, CodingKey {
        case title, seed, state, tags
        case targetRepo = "target_repo"
    }

    public init(
        title: String? = nil, seed: String? = nil, state: IdeaState? = nil,
        tags: [String]? = nil, targetRepo: String? = nil
    ) {
        self.title = title
        self.seed = seed
        self.state = state
        self.tags = tags
        self.targetRepo = targetRepo
    }
}

/// `POST /api/ideas/:id/session` → `{ sessionId }` (camelCase; a route-built
/// object, unlike the snake_case Idea rows).
public struct IdeaSessionResponse: Decodable, Sendable {
    public let sessionId: String
}
