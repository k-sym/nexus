import XCTest
@testable import NexusCore

/// Covers the session list mutations behind the M6 rename/archive swipe actions:
/// the optimistic `withTitle` copy and the `PatchAssistantSessionRequest` body
/// (a rename or an archive, never both — nil fields omitted).
final class AssistantSessionMutationTests: XCTestCase {

    private func encodeToObject(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testWithTitleReplacesOnlyTitle() {
        let original = AssistantSession(
            id: "s1", title: "Old", status: "running", remoteOnly: false,
            source: nil, remoteSessionId: "rem-1", updatedAt: "t",
            latestRun: AssistantRun(id: "r1", status: "running"))
        let renamed = original.withTitle("New")
        XCTAssertEqual(renamed.title, "New")
        // Everything else is preserved.
        XCTAssertEqual(renamed.id, "s1")
        XCTAssertEqual(renamed.status, "running")
        XCTAssertEqual(renamed.remoteSessionId, "rem-1")
        XCTAssertTrue(renamed.isRunning)
    }

    func testPatchRequestRenameEncodesTitleOnly() throws {
        let obj = try encodeToObject(PatchAssistantSessionRequest(title: "Renamed"))
        XCTAssertEqual(obj["title"] as? String, "Renamed")
        XCTAssertNil(obj["archived"], "archived omitted on a rename")
    }

    func testPatchRequestArchiveEncodesArchivedOnly() throws {
        let obj = try encodeToObject(PatchAssistantSessionRequest(archived: true))
        XCTAssertEqual(obj["archived"] as? Bool, true)
        XCTAssertNil(obj["title"], "title omitted on an archive")
    }
}
