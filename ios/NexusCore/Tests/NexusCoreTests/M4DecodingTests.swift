import XCTest
@testable import NexusCore

final class M4DecodingTests: XCTestCase {

    func testGitDiffAvailable() throws {
        let json = Data("""
        {
          "ok": true, "repo_path": "/repo", "git_remote": "origin", "has_changes": true,
          "summary": { "files": 1, "hunks": 1, "added": 3, "deleted": 1 },
          "files": [ { "path": "a.swift", "old_path": null, "new_path": null, "status": "modified", "added": 3, "deleted": 1, "staged": false, "hunks": [] } ],
          "hunks": [ { "id": "h1", "file": "a.swift", "header": "@@ -1 +1,3 @@", "diff": "-old\\n+new\\n+new2", "prompt": "", "staged": false, "old_start": 1, "new_start": 1, "old_lines": 1, "new_lines": 3 } ]
        }
        """.utf8)
        let state = try JSONDecoder.nexusREST.decode(GitDiffState.self, from: json)
        guard case .available(let diff) = state else { return XCTFail("expected available") }
        XCTAssertEqual(diff.repoPath, "/repo")
        XCTAssertTrue(diff.hasChanges)
        XCTAssertEqual(diff.summary.added, 3)
        XCTAssertEqual(diff.files.first?.status, "modified")
        XCTAssertEqual(diff.hunks.first?.header, "@@ -1 +1,3 @@")
    }

    func testGitDiffUnavailable() throws {
        let json = Data(#"{"ok":false,"reason":"not_git_repo","message":"Not a git repo","repo_path":"/tmp"}"#.utf8)
        let state = try JSONDecoder.nexusREST.decode(GitDiffState.self, from: json)
        guard case .unavailable(let reason, let message) = state else { return XCTFail("expected unavailable") }
        XCTAssertEqual(reason, "not_git_repo")
        XCTAssertEqual(message, "Not a git repo")
    }

    func testMondayItemsDecode() throws {
        let json = Data("""
        { "items": [
          { "item_id": "i1", "board_id": "b1", "board_name": "Roadmap", "group_id": null, "group_title": "Now",
            "name": "iOS app", "state": "active", "status_label": "Working on it", "status_color": "#fdab3d",
            "owners_json": "[\\"K\\"]", "url": "https://monday/i1", "column_values_json": "{}",
            "monday_updated_at": null, "synced_at": "t",
            "rollup": { "total": 4, "open": 1, "inProgress": 2, "inReview": 0, "done": 1 },
            "rollup_text": "2 in progress", "task_ids": ["t1","t2"] }
        ] }
        """.utf8)
        let response = try JSONDecoder.nexusREST.decode(MondayItemsResponse.self, from: json)
        let item = try XCTUnwrap(response.items.first)
        XCTAssertEqual(item.itemId, "i1")
        XCTAssertEqual(item.boardName, "Roadmap")
        XCTAssertEqual(item.statusLabel, "Working on it")
        XCTAssertEqual(item.rollup?.inProgress, 2)
        XCTAssertEqual(item.taskIds, ["t1", "t2"])
    }

    func testPendingApprovalFromStreamJSON() throws {
        let line = Data(#"{"threadId":"t1","toolCallId":"call_9","toolName":"Bash","category":"bash","cwd":"/repo","input":{"command":"rm -rf build","file_path":"/x"}}"#.utf8)
        let json = try XCTUnwrap(JSONValue.parse(line))
        let approval = try XCTUnwrap(PendingApproval(json: json))
        XCTAssertEqual(approval.toolCallId, "call_9")
        XCTAssertEqual(approval.toolName, "Bash")
        XCTAssertEqual(approval.category, "bash")
        // Nested arbitrary input preserved (incl. a snake_case key).
        XCTAssertEqual(approval.input["command"]?.string, "rm -rf build")
        XCTAssertEqual(approval.input["file_path"]?.string, "/x")
    }

    func testJSONValueEncodeRoundTripPreservesNestedKeys() throws {
        let original = Data(#"{"models":{"local":{"base_url":"http://x","api_key":"••••••••"}},"n":3,"on":true}"#.utf8)
        let value = try XCTUnwrap(JSONValue.parse(original))
        let reencoded = try JSONEncoder().encode(value)
        let roundTripped = try XCTUnwrap(JSONValue.parse(reencoded))
        // Nested snake_case keys survive an encode → decode cycle unchanged.
        XCTAssertEqual(roundTripped["models"]?["local"]?["base_url"]?.string, "http://x")
        XCTAssertEqual(roundTripped["models"]?["local"]?["api_key"]?.string, "••••••••")
        XCTAssertEqual(roundTripped["n"]?.int, 3)
        XCTAssertEqual(roundTripped["on"]?.bool, true)
    }
}
