import XCTest
@testable import NexusCore

final class ProjectActivityTests: XCTestCase {

    /// Build a `Project` via JSON since it has no public memberwise init.
    private func makeProject(id: String, name: String, chatSessionCount: Int?) throws -> Project {
        let sessions = chatSessionCount.map(String.init) ?? "null"
        let json = Data("""
        {
          "id": "\(id)", "slug": "\(id)", "name": "\(name)", "badge": "BDG",
          "description": "", "repo_path": "/tmp/\(id)", "config_json": "{}",
          "git_remote": "", "task_count": 0, "chat_session_count": \(sessions),
          "created_at": "a", "updated_at": "b"
        }
        """.utf8)
        return try JSONDecoder.nexusREST.decode(Project.self, from: json)
    }

    private func run(_ projectId: String?, waiting: Bool) -> ActiveChatRun {
        ActiveChatRun(threadId: "t_\(projectId ?? "nil")", projectId: projectId, waitingForResponse: waiting)
    }

    // MARK: Decoding

    func testActiveRunsDecodeCamelCaseAndTolerateNullProject() throws {
        let json = Data("""
        {
          "activeThreadIds": ["t1", "t2"],
          "runs": [
            { "threadId": "t1", "projectId": "p1", "waitingForResponse": false,
              "modelKey": "anthropic/x", "title": "A", "questionCount": 0 },
            { "threadId": "t2", "projectId": null, "waitingForResponse": true,
              "modelKey": "anthropic/y", "title": "B", "questionCount": 1 }
          ]
        }
        """.utf8)
        let res = try JSONDecoder.nexusCamel.decode(ActiveChatRunsResponse.self, from: json)
        XCTAssertEqual(res.runs.count, 2)
        XCTAssertEqual(res.runs[0].projectId, "p1")
        XCTAssertFalse(res.runs[0].waitingForResponse)
        XCTAssertNil(res.runs[1].projectId)
        XCTAssertTrue(res.runs[1].waitingForResponse)
    }

    // MARK: Derivation — waiting ▸ working ▸ idle ▸ none

    func testWaitingBeatsWorking() {
        let activity = ProjectActivity.derive(
            runs: [run("p", waiting: false), run("p", waiting: true)],
            chatSessionCount: 3)
        XCTAssertEqual(activity, .waiting)
    }

    func testWorkingWhenRunButNoneWaiting() {
        let activity = ProjectActivity.derive(runs: [run("p", waiting: false)], chatSessionCount: 0)
        XCTAssertEqual(activity, .working)
    }

    func testIdleWhenUnclosedSessionsButNoRun() {
        let activity = ProjectActivity.derive(runs: [], chatSessionCount: 2)
        XCTAssertEqual(activity, .idle)
    }

    func testNoneWhenNoRunAndNoSessions() {
        XCTAssertNil(ProjectActivity.derive(runs: [], chatSessionCount: 0))
        XCTAssertNil(ProjectActivity.derive(runs: [], chatSessionCount: nil))
    }

    // MARK: Assembly — sort active-first then A→Z, ignore orphan runs

    func testSortsActiveFirstThenAlphabetical() throws {
        let projects = [
            try makeProject(id: "z", name: "Zebra", chatSessionCount: 0),   // inactive
            try makeProject(id: "a", name: "Apple", chatSessionCount: 0),   // inactive
            try makeProject(id: "m", name: "Mango", chatSessionCount: 5),   // idle (active)
            try makeProject(id: "b", name: "Banana", chatSessionCount: 0),  // working (active)
        ]
        let runs = [run("b", waiting: false)]

        let items = ProjectListItem.assemble(projects: projects, runs: runs)

        XCTAssertEqual(items.map(\.project.name), ["Banana", "Mango", "Apple", "Zebra"])
        XCTAssertEqual(items[0].activity, .working)   // Banana
        XCTAssertEqual(items[1].activity, .idle)      // Mango
        XCTAssertNil(items[2].activity)               // Apple
        XCTAssertTrue(items[0].isActive)
        XCTAssertFalse(items[2].isActive)
    }

    func testOrphanRunWithoutProjectRowIsIgnored() throws {
        let projects = [try makeProject(id: "p", name: "Present", chatSessionCount: 0)]
        // A run naming a nil project and a run naming an unknown project.
        let runs = [run(nil, waiting: true), run("ghost", waiting: false)]

        let items = ProjectListItem.assemble(projects: projects, runs: runs)

        XCTAssertEqual(items.count, 1)
        XCTAssertNil(items[0].activity)   // neither orphan run tints the present project
    }
}
