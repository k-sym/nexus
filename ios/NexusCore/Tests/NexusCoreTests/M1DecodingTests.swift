import XCTest
@testable import NexusCore

final class M1DecodingTests: XCTestCase {

    private func fixtureData(_ name: String, _ ext: String) throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures"),
            "missing fixture \(name).\(ext)"
        )
        return try Data(contentsOf: url)
    }

    func testTicketsDecode() throws {
        let tickets = try JSONDecoder.nexusREST.decode([Ticket].self, from: fixtureData("tickets", "json"))
        XCTAssertEqual(tickets.count, 2)
        XCTAssertEqual(tickets[0].key, "NEX-1")
        XCTAssertEqual(tickets[0].syncedAt, "2026-07-24T12:00:00.000Z")
        XCTAssertNil(tickets[1].assignee)
        XCTAssertNil(tickets[1].url)
    }

    func testActivityDecodesAndIgnoresFreeJSON() throws {
        let resp = try JSONDecoder.nexusREST.decode(ActivityResponse.self, from: fixtureData("activity", "json"))
        XCTAssertEqual(resp.running.count, 1)
        XCTAssertEqual(resp.running[0].kind, .chatTurn)
        XCTAssertEqual(resp.running[0].status, .running)
        XCTAssertEqual(resp.running[0].durationMs, 4200)
        XCTAssertEqual(resp.running[0].projectId, "proj_nexus")
        XCTAssertNil(resp.running[0].completedAt)

        XCTAssertEqual(resp.recent.count, 2)
        XCTAssertEqual(resp.recent[0].status, .succeeded)
        // usage/diagnostics present on this row must be ignored, not fail decoding.
        XCTAssertEqual(resp.recent[1].kind, .missionTick)
        XCTAssertEqual(resp.recent[1].error, "timeout")

        XCTAssertEqual(resp.counts["succeeded"], 5)
    }

    func testMissionControlDecodesCamelCase() throws {
        let status = try JSONDecoder.nexusREST.decode(MissionStatus.self, from: fixtureData("mission_control", "json"))
        XCTAssertTrue(status.memory.ok)
        XCTAssertEqual(status.memory.memories, 1423)
        XCTAssertEqual(status.memory.jobs?.pending, 2)
        XCTAssertEqual(status.memory.models?.rerank, false)

        XCTAssertEqual(status.modelCounts?.active, 5)
        XCTAssertEqual(status.modelCounts?.available, 42)
        XCTAssertEqual(status.models.first?.contextWindow, 200000)
        XCTAssertEqual(status.models.first?.key, "anthropic/claude-opus-4-8")

        let claude = try XCTUnwrap(status.stats?["claude"])
        XCTAssertEqual(claude.value, "38%")
        XCTAssertEqual(claude.windows?["session"]?.usedPercent, 38)
        XCTAssertEqual(claude.windows?["session"]?.windowMinutes, 300)
        XCTAssertEqual(status.stats?["openrouter"]?.ok, false)
    }
}
