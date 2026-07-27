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

    func testModelsResponseDecodesCuratedListAndModelKey() throws {
        // /api/models is camelCase → decode with the plain (nexusCamel) decoder.
        let json = Data("""
        {
          "models": [
            { "provider": "anthropic", "id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5",
              "contextWindow": 200000, "configured": true, "thinkingLevels": ["off","low","high"] },
            { "provider": "openrouter", "id": "owl-alpha", "name": "Owl Alpha" }
          ],
          "allModels": [], "enabledModelKeys": [], "customized": false
        }
        """.utf8)
        let res = try JSONDecoder.nexusCamel.decode(ModelsResponse.self, from: json)
        XCTAssertEqual(res.models.count, 2)
        let haiku = res.models[0]
        XCTAssertEqual(haiku.modelId, "claude-haiku-4-5-20251001")
        XCTAssertEqual(haiku.modelKey, "anthropic/claude-haiku-4-5-20251001")
        XCTAssertEqual(haiku.id, haiku.modelKey)          // Identifiable id == modelKey
        XCTAssertEqual(haiku.contextWindow, 200000)
        XCTAssertEqual(haiku.thinkingLevels, ["off", "low", "high"])
        XCTAssertEqual(haiku.configured, true)
        XCTAssertNil(res.models[1].configured)            // absent flag ⇒ nil
    }

    func testChatThreadDecodesLastModelKey() throws {
        let json = Data("""
        { "id": "t1", "project_id": "p1", "title": "T", "git_branch": "main",
          "created_at": "a", "updated_at": "b", "archived_at": null,
          "last_model_key": "anthropic/claude-opus-4-8" }
        """.utf8)
        let thread = try JSONDecoder.nexusCamel.decode(ChatThread.self, from: json)
        XCTAssertEqual(thread.lastModelKey, "anthropic/claude-opus-4-8")
    }
}
