import XCTest
@testable import NexusCore

/// Claude Desktop session handoff: the session list and the thread stamps.
final class DesktopDecodingTests: XCTestCase {

    private func fixtureData(_ name: String, _ ext: String) throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures"),
            "missing fixture \(name).\(ext)"
        )
        return try Data(contentsOf: url)
    }

    func testDesktopSessionsDecodeWithNullsAndStatus() throws {
        let res = try JSONDecoder.nexusCamel.decode(DesktopSessionsResponse.self, from: fixtureData("desktop_sessions", "json"))
        XCTAssertEqual(res.sessions.map(\.id), ["aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002"])
        XCTAssertEqual(res.sessions[0].title, "Fix the badge")
        XCTAssertEqual(res.sessions[0].firstPrompt, "Fix the badge please")
        XCTAssertEqual(res.sessions[0].gitBranch, "main")
        XCTAssertEqual(res.sessions[0].lastModified, "2026-09-13T09:30:00.000Z")
        XCTAssertNil(res.sessions[1].firstPrompt)
        XCTAssertNil(res.sessions[1].gitBranch)
        XCTAssertNil(res.sessions[1].createdAt)
        XCTAssertEqual(res.desktop, DesktopStatus(appFound: true, indexFound: false))
    }

    func testOpenAndImportResultsCarryTheStampedThread() throws {
        let thread = """
        {"id":"t1","project_id":"p1","title":"T","created_at":"2026-09-13T10:00:00.000Z","updated_at":"2026-09-13T10:00:00.000Z","archived_at":null,
         "last_model_key":"claude-code/claude-opus-5","claude_session_id":"aaaaaaaa-0000-0000-0000-000000000001","desktop_shared_at":"2026-09-13T11:00:00.000Z"}
        """
        let open = try JSONDecoder.nexusCamel.decode(DesktopOpenResult.self, from: Data("{\"thread\":\(thread),\"url\":\"claude://resume?session=x\"}".utf8))
        XCTAssertEqual(open.url, "claude://resume?session=x")
        XCTAssertEqual(open.thread.desktopSharedAt, "2026-09-13T11:00:00.000Z")
        XCTAssertEqual(open.thread.claudeSessionId, "aaaaaaaa-0000-0000-0000-000000000001")
        let imported = try JSONDecoder.nexusCamel.decode(DesktopImportResult.self, from: Data("{\"thread\":\(thread),\"appended\":7}".utf8))
        XCTAssertEqual(imported.appended, 7)
        XCTAssertEqual(imported.thread.id, "t1")
    }

    func testThreadsWithoutTheNewFieldsStillDecode() throws {
        let json = """
        {"id":"t1","project_id":"p1","title":"T","created_at":"2026-09-13T10:00:00.000Z","updated_at":"2026-09-13T10:00:00.000Z","archived_at":null}
        """
        let thread = try JSONDecoder.nexusCamel.decode(ChatThread.self, from: Data(json.utf8))
        XCTAssertNil(thread.desktopSharedAt)
        XCTAssertNil(thread.claudeSessionId)
    }
}
