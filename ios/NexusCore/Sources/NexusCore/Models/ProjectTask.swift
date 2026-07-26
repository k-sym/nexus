import Foundation

/// Kanban column. Forward-compatible: an unrecognized value from a newer
/// backend decodes to `.unknown(raw)` instead of throwing. Note the REST
/// decoder's `.convertFromSnakeCase` transforms *keys* only, so the string
/// *value* `"in_progress"` arrives verbatim and is matched here.
public enum TaskStatus: Codable, Hashable, Sendable, CaseIterable {
    case triage, todo, inProgress, review, deploy
    case unknown(String)

    public static var allCases: [TaskStatus] { [.triage, .todo, .inProgress, .review, .deploy] }

    public init(rawValue: String) {
        switch rawValue {
        case "triage": self = .triage
        case "todo": self = .todo
        case "in_progress": self = .inProgress
        case "review": self = .review
        case "deploy": self = .deploy
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .triage: return "triage"
        case .todo: return "todo"
        case .inProgress: return "in_progress"
        case .review: return "review"
        case .deploy: return "deploy"
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

public enum TaskPriority: Codable, Hashable, Sendable {
    case low, medium, high, urgent
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "low": self = .low
        case "medium": self = .medium
        case "high": self = .high
        case "urgent": self = .urgent
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .low: return "low"
        case .medium: return "medium"
        case .high: return "high"
        case .urgent: return "urgent"
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

/// Mirror of `Task` in `src/shared/index.ts` (a Kanban card). Named
/// `ProjectTask` in Swift to avoid shadowing the `Task` concurrency type.
/// Nullable TS fields are Swift optionals; the server sends explicit `null`
/// which decodes to `nil`.
public struct ProjectTask: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let description: String
    public let status: TaskStatus
    public let priority: TaskPriority
    public let assignedAgent: String?
    public let dueDate: String?
    public let createdAt: String
    public let updatedAt: String
    public let modelKey: String?
    public let threadId: String?
    public let externalSource: String?
    public let externalId: String?
}
