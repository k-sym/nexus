import XCTest
@testable import NexusCore

final class ModelDecodingTests: XCTestCase {

    private func fixtureData(_ name: String, _ ext: String) throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures"),
            "missing fixture \(name).\(ext)"
        )
        return try Data(contentsOf: url)
    }

    func testProjectsDecodeWithSnakeCaseMapping() throws {
        let data = try fixtureData("projects", "json")
        let projects = try JSONDecoder.nexusREST.decode([Project].self, from: data)

        XCTAssertEqual(projects.count, 2)
        let nexus = projects[0]
        XCTAssertEqual(nexus.id, "proj_nexus")
        XCTAssertEqual(nexus.repoPath, "/Users/k-sym/Projects/nexus")
        XCTAssertEqual(nexus.gitRemote, "git@github.com:K-Sym/nexus.git")
        XCTAssertEqual(nexus.taskCount, 7)
        XCTAssertEqual(nexus.chatSessionCount, 12)

        // Optional count that arrives as explicit null decodes to nil.
        XCTAssertNil(projects[1].chatSessionCount)
        XCTAssertEqual(projects[1].gitRemote, "")
    }

    func testTaskStatusRoundTripAndUnknownFallback() {
        XCTAssertEqual(TaskStatus(rawValue: "in_progress"), .inProgress)
        XCTAssertEqual(TaskStatus.inProgress.rawValue, "in_progress")
        XCTAssertEqual(TaskStatus(rawValue: "brand_new_column"), .unknown("brand_new_column"))
        XCTAssertEqual(TaskStatus.allCases.count, 5)
    }

    func testTaskPriorityUnknownFallback() {
        XCTAssertEqual(TaskPriority(rawValue: "urgent"), .urgent)
        XCTAssertEqual(TaskPriority(rawValue: "cosmic"), .unknown("cosmic"))
    }

    func testBusyInfoDecodesCamelCaseBody() throws {
        let json = Data("""
        { "kind": "model_busy", "activeThreadId": "t_123", "activeTitle": "Refactor auth", "modelKey": "anthropic/claude-opus-4-8" }
        """.utf8)
        let info = BusyInfo.decode(from: json)
        XCTAssertEqual(info.kind, .modelBusy)
        XCTAssertEqual(info.activeThreadId, "t_123")
        XCTAssertEqual(info.activeTitle, "Refactor auth")
        XCTAssertEqual(info.modelKey, "anthropic/claude-opus-4-8")
    }
}
