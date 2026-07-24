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
}
