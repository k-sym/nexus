import Foundation

// MARK: - Approvals

/// A pending tool-gate. Mirror of `PendingApprovalDto` (camelCase on the wire).
/// `input` stays a raw `JSONValue`. Built directly from stream JSON so the
/// LiveHub doesn't re-serialize.
public struct PendingApproval: Identifiable, Hashable, Sendable {
    public var id: String { toolCallId }
    public let threadId: String
    public let toolCallId: String
    public let toolName: String
    /// ToolCategory (e.g. "bash", "read", "edit") — used to style the row.
    public let category: String
    public let cwd: String
    public let input: JSONValue

    public init?(json: JSONValue) {
        guard let toolCallId = json["toolCallId"]?.string else { return nil }
        self.toolCallId = toolCallId
        self.threadId = json["threadId"]?.string ?? ""
        self.toolName = json["toolName"]?.string ?? ""
        self.category = json["category"]?.string ?? ""
        self.cwd = json["cwd"]?.string ?? ""
        self.input = json["input"] ?? .null
    }
}

public struct ApprovalDecisionRequest: Encodable, Sendable {
    public let action: String  // "allow" | "deny"
    public let reason: String?
    public init(action: String, reason: String? = nil) {
        self.action = action
        self.reason = reason
    }
}

// MARK: - Git diff

/// `GET /api/projects/:id/git/diff`. A discriminated union on `ok`.
public enum GitDiffState: Decodable, Sendable {
    case available(GitDiff)
    case unavailable(reason: String, message: String)

    enum CodingKeys: String, CodingKey { case ok, reason, message }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if try container.decode(Bool.self, forKey: .ok) {
            self = .available(try GitDiff(from: decoder))
        } else {
            self = .unavailable(
                reason: try container.decodeIfPresent(String.self, forKey: .reason) ?? "git_error",
                message: try container.decodeIfPresent(String.self, forKey: .message) ?? "")
        }
    }
}

/// The `ok: true` branch. Decoded with `nexusREST` (snake_case → camelCase).
public struct GitDiff: Decodable, Sendable {
    public let repoPath: String
    public let gitRemote: String
    public let hasChanges: Bool
    public let summary: GitDiffSummary
    public let files: [GitDiffFile]
    public let hunks: [GitDiffHunk]
}

public struct GitDiffSummary: Decodable, Sendable {
    public let files: Int
    public let hunks: Int
    public let added: Int
    public let deleted: Int
}

public struct GitDiffFile: Decodable, Identifiable, Hashable, Sendable {
    public var id: String { path }
    public let path: String
    public let oldPath: String?
    public let newPath: String?
    public let status: String
    public let added: Int
    public let deleted: Int
    public let staged: Bool
    public let hunks: [GitDiffHunk]
}

public struct GitDiffHunk: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let file: String
    public let header: String
    public let diff: String
    public let staged: Bool
}

// MARK: - Monday

public struct MondayRollup: Decodable, Hashable, Sendable {
    public let total: Int
    public let open: Int
    public let inProgress: Int
    public let inReview: Int
    public let done: Int
}

/// Mirror of `MondayItemWithLinks`. `owners_json`/`column_values_json` stay
/// strings (JSON-encoded), so `nexusREST` is safe.
public struct MondayItem: Decodable, Identifiable, Hashable, Sendable {
    public var id: String { itemId }
    public let itemId: String
    public let boardName: String
    public let groupTitle: String?
    public let name: String
    public let state: String
    public let statusLabel: String?
    public let statusColor: String?
    public let url: String?
    public let rollup: MondayRollup?
    public let rollupText: String?
    public let taskIds: [String]?
}

public struct MondayItemsResponse: Decodable, Sendable {
    public let items: [MondayItem]
}
