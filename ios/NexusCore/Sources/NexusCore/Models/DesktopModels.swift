import Foundation

/// Claude Desktop session handoff: the shapes behind "Open in Claude Desktop"
/// and "Import from Claude Desktop". Snake_case on the wire like `ChatThread`,
/// so these decode with the PLAIN decoder and explicit keys.

/// Whether the machine running the backend has the Claude Desktop app and its
/// Claude Code session index. Camel-cased on the wire (it is `/api/engines` data).
public struct DesktopStatus: Decodable, Hashable, Sendable {
    public let appFound: Bool
    public let indexFound: Bool

    public init(appFound: Bool, indexFound: Bool) {
        self.appFound = appFound
        self.indexFound = indexFound
    }
}

/// One Claude Desktop or terminal session under the project's repo path.
public struct DesktopSessionSummary: Decodable, Identifiable, Hashable, Sendable {
    /// The Claude Code session id.
    public let id: String
    public let title: String
    public let firstPrompt: String?
    /// ISO timestamp of the transcript's last modification.
    public let lastModified: String
    public let createdAt: String?
    public let gitBranch: String?
    public let cwd: String?

    enum CodingKeys: String, CodingKey {
        case id
        case title
        case firstPrompt = "first_prompt"
        case lastModified = "last_modified"
        case createdAt = "created_at"
        case gitBranch = "git_branch"
        case cwd
    }
}

/// `GET /api/projects/:id/desktop/sessions`.
public struct DesktopSessionsResponse: Decodable, Sendable {
    public let sessions: [DesktopSessionSummary]
    public let desktop: DesktopStatus
}

/// `POST /api/threads/:id/desktop/open`.
public struct DesktopOpenResult: Decodable, Sendable {
    public let thread: ChatThread
    /// The `claude://resume` link the backend opened.
    public let url: String
}

/// `POST /api/projects/:id/desktop/sessions/:sessionId/import`.
public struct DesktopImportResult: Decodable, Sendable {
    public let thread: ChatThread
    /// Transcript messages mirrored into the new thread.
    public let appended: Int
}
