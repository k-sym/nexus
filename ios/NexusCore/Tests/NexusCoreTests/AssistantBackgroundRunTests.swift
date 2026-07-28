import XCTest
@testable import NexusCore

/// Covers the M6 Phase B additions: the background-handoff run/sync decode
/// envelopes, `ChatDetail.latestRun` seeding, the reducer's non-streaming user
/// append, and the `ChatEndpoint` background-handoff capability defaults.
final class AssistantBackgroundRunTests: XCTestCase {

    // MARK: Run + sync decode envelopes

    func testRunResponseDecodesAndReportsRunning() throws {
        // POST …/runs and GET /runs/:id both return the fuller publicRun shape;
        // only id + status are modelled, extra keys are ignored.
        let json = Data("""
        { "run": { "id": "r1", "session_id": "s1", "remote_run_id": "hermes-9",
                   "kind": "overnight", "status": "running", "input": "do the thing",
                   "output": "", "error": null, "usage": null,
                   "started_at": "2026-07-28T12:00:00.000Z", "completed_at": null,
                   "updated_at": "2026-07-28T12:00:00.000Z" } }
        """.utf8)
        let res = try JSONDecoder.nexusCamel.decode(AssistantRunResponse.self, from: json)
        XCTAssertEqual(res.run?.id, "r1")
        XCTAssertEqual(res.run?.status, "running")
        XCTAssertTrue(res.run?.isRunning ?? false)
    }

    func testRunResponseTerminalStatusIsNotRunning() throws {
        let json = Data(#"{ "run": { "id": "r2", "status": "succeeded" } }"#.utf8)
        let res = try JSONDecoder.nexusCamel.decode(AssistantRunResponse.self, from: json)
        XCTAssertFalse(res.run?.isRunning ?? true)
    }

    func testRunResponseToleratesNullRun() throws {
        let res = try JSONDecoder.nexusCamel.decode(AssistantRunResponse.self, from: Data(#"{ "run": null }"#.utf8))
        XCTAssertNil(res.run)
    }

    func testCancellingCountsAsRunning() {
        // /runs/:id/stop marks the run "cancelling" — still in flight, so the poll
        // loop keeps going until it reaches a terminal status.
        XCTAssertTrue(AssistantRun(id: "r", status: "cancelling").isRunning)
    }

    func testSyncResponseDecodes() throws {
        XCTAssertEqual(try JSONDecoder.nexusCamel.decode(AssistantSyncResponse.self, from: Data(#"{"updated":3}"#.utf8)).updated, 3)
        // Tolerate an absent count (defensive) → 0.
        XCTAssertEqual(try JSONDecoder.nexusCamel.decode(AssistantSyncResponse.self, from: Data("{}".utf8)).updated, 0)
    }

    // MARK: ChatDetail.latestRun seeding

    func testSessionDetailExposesRunningLatestRun() throws {
        let json = Data("""
        { "session": { "id": "s1", "title": "T", "status": "running" },
          "messages": [ { "role": "user", "content": "kick off" } ],
          "latestRun": { "id": "r1", "session_id": "s1", "kind": "overnight",
                         "status": "running", "input": "kick off", "output": "",
                         "started_at": "z", "completed_at": null, "updated_at": "z" } }
        """.utf8)
        let detail = try JSONDecoder.nexusCamel.decode(AssistantSessionDetail.self, from: json)
        XCTAssertEqual(detail.latestRun?.id, "r1")
        XCTAssertTrue(detail.latestRun?.isRunning ?? false)
    }

    // MARK: Reducer — non-streaming user append

    func testAppendUserMessageAddsBubbleWithoutStreaming() {
        var reducer = TranscriptReducer()
        reducer.appendUserMessage("hand this off")
        XCTAssertEqual(reducer.messages.count, 1)
        XCTAssertEqual(reducer.messages[0].role, .user)
        XCTAssertEqual(reducer.messages[0].content, "hand this off")
        XCTAssertFalse(reducer.messages[0].isStreaming)
        XCTAssertNil(reducer.streaming, "no live assistant placeholder for a background turn")
        XCTAssertEqual(reducer.status, .idle)
    }

    func testLoadPersistedReplacesOptimisticAppend() throws {
        // The optimistic user bubble is superseded by the server transcript on the
        // first sync reload — no duplicate rows.
        let json = Data("""
        { "session": { "id": "s1", "title": "T", "status": "idle" },
          "messages": [ { "role": "user", "content": "hi" },
                        { "role": "assistant", "content": "done" } ] }
        """.utf8)
        let detail = try JSONDecoder.nexusCamel.decode(AssistantSessionDetail.self, from: json)
        var reducer = TranscriptReducer()
        reducer.appendUserMessage("hi")
        reducer.loadPersisted(detail.persistedMessages)
        XCTAssertEqual(reducer.messages.map(\.content), ["hi", "done"])
    }

    // MARK: ChatEndpoint background-handoff capability defaults

    func testAssistantEndpointOptsIntoBackgroundHandoff() {
        // Direct dispatch check: the concrete conformer must win over the
        // protocol-extension default (false) when read through the existential.
        let endpoint: ChatEndpoint = AssistantChatEndpoint(api: APIClient(), sessionId: "s1")
        XCTAssertTrue(endpoint.supportsBackgroundHandoff)
        // And a thread endpoint keeps the default.
        let thread: ChatEndpoint = ThreadChatEndpoint(api: APIClient(), threadId: "t1")
        XCTAssertFalse(thread.supportsBackgroundHandoff)
    }

    func testEndpointBackgroundHandoffDefaultsAreNoOps() async throws {
        let stub = StubChatEndpoint()
        XCTAssertFalse(stub.supportsBackgroundHandoff, "off unless a conformer opts in")
        // Sync + stop default to harmless no-ops.
        try await stub.syncBackgroundRuns()
        try await stub.stopBackgroundRun(runId: "whatever")
        // startBackgroundRun is capability-gated, so its default must throw.
        do {
            _ = try await stub.startBackgroundRun(content: "x")
            XCTFail("default startBackgroundRun should throw")
        } catch let error as APIError {
            guard case .server(let status, _) = error else { return XCTFail("wrong error \(error)") }
            XCTAssertEqual(status, 400)
        }
    }
}

/// Minimal `ChatEndpoint` that implements only the required members, inheriting
/// the background-handoff defaults — mirrors how `ThreadChatEndpoint` opts out.
private struct StubChatEndpoint: ChatEndpoint {
    var supportsModelPicker: Bool { true }
    var supportsSupervise: Bool { true }
    func loadDetail() async throws -> ChatDetail { ChatDetail(messages: []) }
    func stream(content: String, modelKey: String?, confirmCancel: Bool) async throws -> AsyncThrowingStream<JSONValue, Error> {
        AsyncThrowingStream { $0.finish() }
    }
    func abort() async throws {}
    func setSupervised(_ on: Bool) async throws -> Bool { false }
    func models() async throws -> [Model] { [] }
}
