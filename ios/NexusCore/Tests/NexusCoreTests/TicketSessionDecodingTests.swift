import XCTest
@testable import NexusCore

/// Ticket to session (#432): the shapes the Tickets detail screen consumes.
final class TicketSessionDecodingTests: XCTestCase {

    func testTicketWithAndWithoutSession() throws {
        let json = """
        [
          {"key":"SUP-123","summary":"Scoring","status":"In Progress","priority":"High","assignee":null,"created":"2026-09-01","updated":"2026-09-08","url":"https://x/browse/SUP-123","source":"nexus","synced_at":"2026-09-08T10:00:00.000Z","session":{"thread_id":"t-1","project_id":"p-wse"}},
          {"key":"SUP-124","summary":"Other","status":"Waiting for support","priority":"Medium","assignee":"Kay","created":null,"updated":null,"url":null,"source":null,"synced_at":"2026-09-08T10:00:00.000Z","session":null}
        ]
        """
        let tickets = try JSONDecoder.nexusREST.decode([Ticket].self, from: Data(json.utf8))
        XCTAssertEqual(tickets[0].session, TicketSessionRef(threadId: "t-1", projectId: "p-wse"))
        XCTAssertNil(tickets[1].session)
    }

    func testTicketDescriptionDecodes() throws {
        let json = """
        {"key":"SUP-123","body":"Last score missing.","trimmed":[{"kind":"footer","text":"Regards"}],"fetchedAt":"2026-09-08T10:00:00.000Z","empty":false}
        """
        let desc = try JSONDecoder.nexusREST.decode(TicketDescription.self, from: Data(json.utf8))
        XCTAssertEqual(desc.body, "Last score missing.")
        XCTAssertEqual(desc.trimmed.first?.kind, "footer")
        XCTAssertFalse(desc.empty)
    }

    func testTicketDraftDecodesWithNullProject() throws {
        let json = """
        {"key":"SUP-123","problem":"The last score is missing.","projectId":null,"branchType":"fix","branchName":"fix/SUP123-last-score-missing","model":"claude-code/claude-sonnet-5"}
        """
        let draft = try JSONDecoder.nexusCamel.decode(TicketDraft.self, from: Data(json.utf8))
        XCTAssertNil(draft.projectId)
        XCTAssertEqual(draft.branchName, "fix/SUP123-last-score-missing")
    }

    func testTicketSessionResultDecodesSnakeCaseThreadWithPlainDecoder() throws {
        let json = """
        {"thread":{"id":"t-9","project_id":"p-wse","title":"SUP-123 Scoring","created_at":"a","updated_at":"b","archived_at":null,"ticket_key":"SUP-123"},"firstTurn":"Fix it.\\n\\nDo not touch Jira."}
        """
        let result = try JSONDecoder.nexusCamel.decode(TicketSessionResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.thread.id, "t-9")
        XCTAssertEqual(result.thread.projectId, "p-wse")
        XCTAssertTrue(result.firstTurn.hasSuffix("Do not touch Jira."))
    }

    func testTicketSessionRequestEncodesCamelCase() throws {
        let data = try JSONEncoder().encode(TicketSessionRequest(projectId: "p", problem: "x", branchName: "fix/SUP1-x"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(obj, ["projectId": "p", "problem": "x", "branchName": "fix/SUP1-x"])
    }

    func testBranchPrefixSwap() {
        XCTAssertEqual(ticketBranchName(type: "hotfix", replacingPrefixOf: "fix/SUP123-last-score"), "hotfix/SUP123-last-score")
        XCTAssertEqual(ticketBranchName(type: "feature", replacingPrefixOf: "SUP123-thing"), "feature/SUP123-thing")
        XCTAssertEqual(ticketBranchName(type: "fix", replacingPrefixOf: "Hotfix/SUP1-x"), "fix/SUP1-x")
    }

    func testOperationKindTicketDraft() {
        XCTAssertEqual(OperationKind(rawValue: "ticket_draft"), .ticketDraft)
        XCTAssertEqual(OperationKind.ticketDraft.label, "Ticket draft")
    }
}
