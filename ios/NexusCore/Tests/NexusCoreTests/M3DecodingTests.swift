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
}
