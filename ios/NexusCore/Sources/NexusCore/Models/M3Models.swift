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

/// A partial write to `PUT /api/tasks/:id`. Every field is optional and nil
/// fields are omitted from the body, which is exactly what the backend's
/// `COALESCE(?, col)` expects: an absent field leaves the column alone.
///
/// The corollary matters for `description`: an empty string is a real value,
/// not an absence, so `description: ""` clears the description rather than
/// leaving it — which is what the edit sheet wants when the field is emptied.
public struct UpdateTaskRequest: Encodable, Sendable {
    public var status: String?
    public var title: String?
    public var description: String?
    public var priority: String?
    public init(
        status: String? = nil, title: String? = nil,
        description: String? = nil, priority: String? = nil
    ) {
        self.status = status
        self.title = title
        self.description = description
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

