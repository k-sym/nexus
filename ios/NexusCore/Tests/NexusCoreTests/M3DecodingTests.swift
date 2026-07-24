import XCTest
@testable import NexusCore

final class M3DecodingTests: XCTestCase {

    func testMemoryDecode() throws {
        let json = Data("""
        [{"id":"mem1","project_id":"proj_nexus","category":"decision","title":"Two-decoder rule","content":"Flat REST vs chat.","source":"chat","created_at":"a","updated_at":"b"}]
        """.utf8)
        let records = try JSONDecoder.nexusREST.decode([MemoryRecord].self, from: json)
        XCTAssertEqual(records.first?.projectId, "proj_nexus")
        XCTAssertEqual(records.first?.category, "decision")
        XCTAssertEqual(records.first?.content, "Flat REST vs chat.")
    }

    func testBraindumpDecode() throws {
        let json = Data("""
        [
          {"id":"bd1","title":"Model picker","body":"Add a picker.","status":"active","project_id":null,"task_id":null,"created_at":"a","updated_at":"b"},
          {"id":"bd2","title":"Triaged","body":"","status":"triaged","project_id":"proj_nexus","task_id":"t9","created_at":"a","updated_at":"b"}
        ]
        """.utf8)
        let ideas = try JSONDecoder.nexusREST.decode([BraindumpIdea].self, from: json)
        XCTAssertEqual(ideas.count, 2)
        XCTAssertEqual(ideas[0].status, "active")
        XCTAssertNil(ideas[0].projectId)
        XCTAssertEqual(ideas[1].projectId, "proj_nexus")
        XCTAssertEqual(ideas[1].taskId, "t9")
    }

    func testMissionDecode() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "missions", withExtension: "json", subdirectory: "Fixtures"))
        let missions = try JSONDecoder.nexusREST.decode([Mission].self, from: Data(contentsOf: url))
        XCTAssertEqual(missions.count, 2)
        let active = missions[0]
        XCTAssertEqual(active.status, .active)
        XCTAssertEqual(active.kind, "review_stale_tasks")
        XCTAssertEqual(active.intervalSeconds, 86400)
        XCTAssertEqual(active.maxTokens, 500000)
        XCTAssertEqual(active.runWindowStart, "02:00")
        XCTAssertEqual(active.iterationCount, 3)
        XCTAssertEqual(active.tokensUsed, 124000)
        XCTAssertNil(active.maxIterations)

        let paused = missions[1]
        XCTAssertEqual(paused.status, .paused)
        XCTAssertNil(paused.nextRunAt)
        XCTAssertEqual(paused.maxIterations, 10)
    }

    func testUpdateTaskRequestEncodesStatusOnly() throws {
        let data = try JSONEncoder().encode(UpdateTaskRequest(status: "in_progress"))
        let json = try XCTUnwrap(JSONValue.parse(data))
        XCTAssertEqual(json["status"]?.string, "in_progress")
        XCTAssertNil(json["title"])   // nil fields omitted
    }
}
