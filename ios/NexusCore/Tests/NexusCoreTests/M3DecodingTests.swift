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

    func testUpdateTaskRequestEncodesStatusOnly() throws {
        let data = try JSONEncoder().encode(UpdateTaskRequest(status: "in_progress"))
        let json = try XCTUnwrap(JSONValue.parse(data))
        XCTAssertEqual(json["status"]?.string, "in_progress")
        XCTAssertNil(json["title"])   // nil fields omitted
        XCTAssertNil(json["description"])
        XCTAssertNil(json["priority"])
    }

    /// The edit sheet's payload: the three fields the desktop modal submits,
    /// and no `status` — the board owns that.
    func testUpdateTaskRequestEncodesEditFields() throws {
        let data = try JSONEncoder().encode(
            UpdateTaskRequest(title: "Ship it", description: "Details.", priority: "high"))
        let json = try XCTUnwrap(JSONValue.parse(data))
        XCTAssertEqual(json["title"]?.string, "Ship it")
        XCTAssertEqual(json["description"]?.string, "Details.")
        XCTAssertEqual(json["priority"]?.string, "high")
        XCTAssertNil(json["status"])
    }

    /// An emptied description must reach the server as `""`, not as an absent
    /// key: the route updates with `COALESCE(?, description)`, so omitting it
    /// would silently keep the old text and the clear would look like a bug.
    func testUpdateTaskRequestEncodesClearedDescription() throws {
        let data = try JSONEncoder().encode(UpdateTaskRequest(description: ""))
        let json = try XCTUnwrap(JSONValue.parse(data))
        XCTAssertEqual(json["description"]?.string, "")
    }

    func testTaskPriorityAllCasesOmitsUnknown() {
        XCTAssertEqual(TaskPriority.allCases.map(\.rawValue), ["low", "medium", "high", "urgent"])
        XCTAssertFalse(TaskPriority.allCases.contains(TaskPriority(rawValue: "blocker")))
    }
}
