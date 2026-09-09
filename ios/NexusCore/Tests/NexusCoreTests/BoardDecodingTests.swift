import XCTest
@testable import NexusCore

/// Session-first Kanban (#439): the shapes the Board and origin detail screens
/// consume. `BoardResponse` embeds `ChatThread`, so it decodes with the PLAIN
/// decoder like `TicketSessionResult`.
final class BoardDecodingTests: XCTestCase {

    private func fixtureData(_ name: String, _ ext: String) throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures"),
            "missing fixture \(name).\(ext)"
        )
        return try Data(contentsOf: url)
    }

    private func board() throws -> BoardResponse {
        try JSONDecoder.nexusCamel.decode(BoardResponse.self, from: fixtureData("board", "json"))
    }

    func testBoardDecodesAllFourOriginsAndAnUnknownKind() throws {
        let board = try board()
        XCTAssertEqual(board.cards.count, 5)
        XCTAssertEqual(board.cards.map(\.origin), [
            .ticket(key: "SUP-123", url: "https://x.atlassian.net/browse/SUP-123"),
            .github(number: 439, url: "https://github.com/k-sym/nexus/issues/439"),
            .monday(itemId: "123", name: "Q4 roadmap item", url: nil),
            .chat,
            .unknown("linear"),
        ])
        XCTAssertEqual(board.cards.map(\.origin.kind), ["ticket", "github", "monday", "chat", "linear"])
        XCTAssertNil(board.cards[3].origin.url)
    }

    func testBoardCardLanesCountersAndThreadStamps() throws {
        let board = try board()
        XCTAssertEqual(board.cards.map(\.lane), [.running, .needsYou, .idle, .done, .unknown("parked")])

        let github = board.cards[1]
        XCTAssertEqual(github.id, "t-github")                 // Identifiable id == thread id
        XCTAssertEqual(github.thread.githubIssue, 439)
        XCTAssertNil(github.thread.ticketKey)
        XCTAssertTrue(github.running)
        XCTAssertEqual(github.pendingQuestions, 1)
        XCTAssertEqual(github.pendingApprovals, 2)
        XCTAssertNil(github.mondayItemId)

        let ticket = board.cards[0]
        XCTAssertEqual(ticket.thread.ticketKey, "SUP-123")
        XCTAssertNil(ticket.thread.githubIssue)
        XCTAssertEqual(ticket.thread.lastModelKey, "claude-code/claude-sonnet-5")

        XCTAssertEqual(board.cards[2].mondayItemId, "123")
        XCTAssertEqual(board.cards[3].thread.archivedAt, "2026-09-02T10:00:00.000Z")

        XCTAssertEqual(board.cards(in: .running).map(\.id), ["t-ticket"])
        XCTAssertEqual(board.cards(in: .inbox), [])
    }

    func testBoardInboxItemsAndErrors() throws {
        let board = try board()
        XCTAssertEqual(board.inbox.count, 2)

        let issue = board.inbox[0]
        XCTAssertEqual(issue.kind, .github)
        XCTAssertEqual(issue.id, "440")
        XCTAssertEqual(issue.title, "Board shows sessions")
        XCTAssertEqual(issue.labels, ["enhancement", "ios"])
        XCTAssertNil(issue.statusLabel)
        XCTAssertEqual(issue.updated, "2026-09-08T08:00:00.000Z")

        let item = board.inbox[1]
        XCTAssertEqual(item.kind, .monday)
        XCTAssertEqual(item.id, "987")
        XCTAssertNil(item.url)
        XCTAssertEqual(item.labels, [])
        XCTAssertEqual(item.statusLabel, "Working on it")
        XCTAssertNil(item.updated)

        XCTAssertEqual(board.inboxErrors.github, "GitHub rate limit exceeded")
        XCTAssertNil(board.inboxErrors.monday)
        XCTAssertFalse(board.inboxErrors.isEmpty)
    }

    func testBoardResponseToleratesMissingInboxAndErrors() throws {
        let json = Data(#"{"cards":[]}"#.utf8)
        let board = try JSONDecoder.nexusCamel.decode(BoardResponse.self, from: json)
        XCTAssertEqual(board.cards, [])
        XCTAssertEqual(board.inbox, [])
        XCTAssertTrue(board.inboxErrors.isEmpty)
    }

    func testBoardLaneOrderLabelsAndUnknown() {
        XCTAssertEqual(BoardLane.allCases.map(\.rawValue), ["inbox", "running", "needs_you", "idle", "done"])
        XCTAssertEqual(BoardLane.allCases.map(\.label), ["Inbox", "Running", "Needs you", "Idle", "Done"])
        XCTAssertEqual(BoardLane(rawValue: "needs_you"), .needsYou)
        XCTAssertEqual(BoardLane(rawValue: "brand_new"), .unknown("brand_new"))
        XCTAssertEqual(BoardLane.unknown("brand_new").label, "Brand New")
        XCTAssertEqual(BoardInboxKind(rawValue: "linear"), .unknown("linear"))
    }

    func testOriginDraftDecodesCamelCase() throws {
        let json = """
        {"origin":{"kind":"github","id":"439"},"problem":"The board is a task board.","projectId":"proj_nexus","branchType":"feat","branchName":"feat/session-first-kanban","model":"claude-code/claude-sonnet-5"}
        """
        let draft = try JSONDecoder.nexusCamel.decode(OriginDraft.self, from: Data(json.utf8))
        XCTAssertEqual(draft.origin, OriginRef(kind: .github, id: "439"))
        XCTAssertEqual(draft.problem, "The board is a task board.")
        XCTAssertEqual(draft.projectId, "proj_nexus")
        XCTAssertEqual(draft.branchType, "feat")
        XCTAssertEqual(draft.branchName, "feat/session-first-kanban")
        XCTAssertEqual(draft.model, "claude-code/claude-sonnet-5")
    }

    func testOriginDraftDecodesNullProjectForMonday() throws {
        let json = """
        {"origin":{"kind":"monday","id":"987"},"problem":"Onboard the partner.","projectId":null,"branchType":"fix","branchName":"fix/partner-onboarding","model":"claude-code/claude-sonnet-5"}
        """
        let draft = try JSONDecoder.nexusCamel.decode(OriginDraft.self, from: Data(json.utf8))
        XCTAssertEqual(draft.origin.kind, .monday)
        XCTAssertNil(draft.projectId)
    }

    func testOriginSessionResultDecodesSnakeCaseThreadWithPlainDecoder() throws {
        let json = """
        {"thread":{"id":"t-9","project_id":"proj_nexus","title":"#439 Session-first Kanban","created_at":"a","updated_at":"b","archived_at":null,"github_issue":439},"firstTurn":"Fix it.\\n\\nSource: GitHub issue #439."}
        """
        let result = try JSONDecoder.nexusCamel.decode(OriginSessionResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.thread.id, "t-9")
        XCTAssertEqual(result.thread.projectId, "proj_nexus")
        XCTAssertEqual(result.thread.githubIssue, 439)
        XCTAssertTrue(result.firstTurn.hasSuffix("Source: GitHub issue #439."))
    }

    func testOriginRefEncodesCamelCaseBody() throws {
        let data = try JSONEncoder().encode(OriginRef(kind: .github, id: "439"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(obj, ["kind": "github", "id": "439"])
    }

    func testOriginSessionRequestEncodesCamelCaseAndOmitsNilProject() throws {
        let full = try JSONEncoder().encode(OriginSessionRequest(
            kind: .monday, id: "987", projectId: "proj_nexus", problem: "x", branchName: "feat/x"))
        let fullObj = try XCTUnwrap(JSONSerialization.jsonObject(with: full) as? [String: String])
        XCTAssertEqual(fullObj, [
            "kind": "monday", "id": "987", "projectId": "proj_nexus", "problem": "x", "branchName": "feat/x",
        ])

        let noProject = try JSONEncoder().encode(OriginSessionRequest(
            kind: .github, id: "439", projectId: nil, problem: "x", branchName: "feat/x"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: noProject) as? [String: Any])
        XCTAssertNil(obj["projectId"])
        XCTAssertEqual(obj["kind"] as? String, "github")
    }

    func testBoardBranchPrefixSwap() {
        XCTAssertEqual(boardBranchTypes, ["feat", "fix", "hotfix"])
        XCTAssertEqual(boardBranchName(type: "fix", replacingPrefixOf: "feat/session-first-kanban"), "fix/session-first-kanban")
        XCTAssertEqual(boardBranchName(type: "hotfix", replacingPrefixOf: "Fix/board-crash"), "hotfix/board-crash")
        XCTAssertEqual(boardBranchName(type: "feat", replacingPrefixOf: "no-prefix"), "feat/no-prefix")
        // A ticket-style prefix is not a board type and is left in the slug.
        XCTAssertEqual(boardBranchName(type: "feat", replacingPrefixOf: "feature/x"), "feat/feature/x")
    }
}
