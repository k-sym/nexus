import Foundation

/// A long-running backend operation surfaced in the Activity console. Mirrors
/// `OperationKind` in `src/shared/index.ts`; forward-compatible via `.unknown`.
public enum OperationKind: Codable, Hashable, Sendable {
    case chatTurn, assistantStream, jiraSync, githubSync, mondaySync, mondayWrite
    case memoryArchive, memoryIndex, missionTick
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "chat_turn": self = .chatTurn
        case "assistant_stream": self = .assistantStream
        case "jira_sync": self = .jiraSync
        case "github_sync": self = .githubSync
        case "monday_sync": self = .mondaySync
        case "monday_write": self = .mondayWrite
        case "memory_archive": self = .memoryArchive
        case "memory_index": self = .memoryIndex
        case "mission_tick": self = .missionTick
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .chatTurn: return "chat_turn"
        case .assistantStream: return "assistant_stream"
        case .jiraSync: return "jira_sync"
        case .githubSync: return "github_sync"
        case .mondaySync: return "monday_sync"
        case .mondayWrite: return "monday_write"
        case .memoryArchive: return "memory_archive"
        case .memoryIndex: return "memory_index"
        case .missionTick: return "mission_tick"
        case .unknown(let v): return v
        }
    }

    /// Human-readable label for the UI.
    public var label: String {
        switch self {
        case .chatTurn: return "Chat turn"
        case .assistantStream: return "Assistant"
        case .jiraSync: return "Jira sync"
        case .githubSync: return "GitHub sync"
        case .mondaySync: return "Monday sync"
        case .mondayWrite: return "Monday write"
        case .memoryArchive: return "Memory archive"
        case .memoryIndex: return "Memory index"
        case .missionTick: return "Mission tick"
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

public enum OperationStatus: String, Codable, Hashable, Sendable {
    case running, succeeded, failed, cancelled, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = OperationStatus(rawValue: raw) ?? .unknown
    }
}

/// Mirror of `Operation` in `src/frontend/src/api.ts`. Named `ActivityOperation`
/// in Swift to avoid clashing with `Foundation.Operation` (NSOperation). The
/// `usage` and `diagnostics` free-JSON fields are intentionally omitted —
/// Decodable ignores unknown keys, and the console doesn't render them.
public struct ActivityOperation: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let kind: OperationKind
    public let status: OperationStatus
    public let title: String
    public let projectId: String?
    public let taskId: String?
    public let threadId: String?
    public let provider: String?
    public let model: String?
    public let startedAt: String
    public let completedAt: String?
    public let durationMs: Int
    public let lastEvent: String?
    public let error: String?
}

public struct ActivityResponse: Decodable, Sendable {
    public let running: [ActivityOperation]
    public let recent: [ActivityOperation]
    public let counts: [String: Int]
}
