import Foundation

/// Mirror of `Project` in `src/shared/index.ts`. Decoded with
/// `JSONDecoder.nexusREST` (`.convertFromSnakeCase`), so the wire's
/// `repo_path`/`created_at`/… map onto these camelCase properties.
public struct Project: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let slug: String
    public let name: String
    /// Up to 3 uppercase chars shown in the project rail.
    public let badge: String
    /// Deprecated on the server (superseded by `badge`) but still sent.
    public let description: String
    public let repoPath: String
    public let configJson: String
    /// Detected `git remote origin`; empty when none.
    public let gitRemote: String
    public let taskCount: Int?
    public let chatSessionCount: Int?
    public let createdAt: String
    public let updatedAt: String
}
