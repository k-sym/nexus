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

