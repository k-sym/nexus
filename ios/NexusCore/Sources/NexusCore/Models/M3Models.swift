import Foundation

// MARK: - Memory

/// Mirror of `MemoryRecord` in `src/frontend/src/api.ts`.
public struct MemoryRecord: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let projectId: String
    public let category: String
    public let title: String
    public let content: String
    public let source: String
    public let createdAt: String
    public let updatedAt: String
}

// MARK: - Braindump

/// Mirror of `BraindumpIdea` in `src/shared/index.ts`.
public struct BraindumpIdea: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let body: String
    /// `active` | `triaged`.
    public let status: String
    public let projectId: String?
    public let taskId: String?
    public let createdAt: String
    public let updatedAt: String
}

// MARK: - Missions

public enum MissionState: String, Codable, Sendable {
    case paused, active, stopped, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MissionState(rawValue: raw) ?? .unknown
    }
}

/// Mirror of `Mission` in `src/shared/index.ts`. `kind`/`pacing`/`stop_reason`
/// stay `String` (forward-compatible); `config_json` stays a raw string.
public struct Mission: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let description: String
    public let kind: String
    public let configJson: String
    public let pacing: String
    public let intervalSeconds: Int
    public let maxIterations: Int?
    public let maxWallClockSeconds: Int?
    public let maxTokens: Int?
    public let runWindowStart: String?
    public let runWindowEnd: String?
    public let status: MissionState
    public let iterationCount: Int
    public let tokensUsed: Int
    public let nextRunAt: String?
    public let startedAt: String?
    public let lastRunAt: String?
    public let stoppedAt: String?
    public let stopReason: String?
    public let createdAt: String
    public let updatedAt: String
}

// MARK: - Write request DTOs
//
// Encoded with a plain JSONEncoder. Property names double as the wire keys, so
// only fields with snake_case keys need explicit CodingKeys (none needed here —
// M3 avoids those fields).

public struct UpdateTaskRequest: Encodable, Sendable {
    public var status: String?
    public var title: String?
    public var priority: String?
    public init(status: String? = nil, title: String? = nil, priority: String? = nil) {
        self.status = status
        self.title = title
        self.priority = priority
    }
}

public struct CreateMemoryRequest: Encodable, Sendable {
    public let content: String
    public let category: String?
    public init(content: String, category: String? = nil) {
        self.content = content
        self.category = category
    }
}

public struct UpdateMemoryRequest: Encodable, Sendable {
    public let content: String
    public init(content: String) { self.content = content }
}

public struct CreateBraindumpRequest: Encodable, Sendable {
    public let title: String
    public let body: String?
    public init(title: String, body: String? = nil) {
        self.title = title
        self.body = body
    }
}

public struct UpdateBraindumpRequest: Encodable, Sendable {
    public var title: String?
    public var body: String?
    public var status: String?
    public init(title: String? = nil, body: String? = nil, status: String? = nil) {
        self.title = title
        self.body = body
        self.status = status
    }
}
